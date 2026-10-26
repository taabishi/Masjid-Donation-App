import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { api, type Donation } from '../../src/api';
import { useAuth } from '../../src/auth';
import { cents, colors } from '../../src/theme';
import { Button, Card, ErrorText, H2, Loading, Muted, Screen } from '../../src/ui';

export default function History() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<Donation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api<Donation[]>('GET', '/donations').then(setItems).catch((e) => setError(e.message));
    }, []),
  );

  const total = (items ?? []).filter((d) => d.status === 'succeeded').reduce((s, d) => s + d.amountCents, 0);

  return (
    <Screen>
      <Card>
        <Text style={{ fontWeight: '700' }}>{user?.name}</Text>
        <Muted style={{ marginBottom: 12 }}>{user?.email}</Muted>
        {user?.operator && <Button title="Operator console" onPress={() => router.push('/ops')} style={{ marginBottom: 8 }} />}
        <Button title="Sign out" variant="outline" onPress={signOut} />
      </Card>
      <H2>Total given: {cents(total)}</H2>
      <ErrorText>{error}</ErrorText>
      {!items ? <Loading /> : items.length === 0 ? <Muted>No donations yet.</Muted> : items.map((d) => (
        <Card key={d.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '600' }}>{d.mosqueName}</Text>
            <Muted>{new Date(d.createdAt).toLocaleDateString()}{d.recurringId ? ' · recurring' : ''}</Muted>
          </View>
          <Text style={{ fontWeight: '700', color: d.status === 'failed' ? colors.danger : d.status === 'processing' ? colors.muted : colors.primary }}>
            {cents(d.amountCents)}{d.status === 'failed' ? ' (failed)' : d.status === 'processing' ? ' (pending)' : ''}
          </Text>
        </Card>
      ))}
    </Screen>
  );
}
