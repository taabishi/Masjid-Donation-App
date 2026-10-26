import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { api, type Mosque } from '../../src/api';
import { DonationBox } from '../../src/DonationBox';
import { Card, ErrorText, H2, Loading, Muted, Screen } from '../../src/ui';

export default function Favorites() {
  const router = useRouter();
  const [mosques, setMosques] = useState<Mosque[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api<Mosque[]>('GET', '/favorites').then(setMosques).catch((e) => setError(e.message));
    }, []),
  );

  if (!mosques) return <Screen><ErrorText>{error}</ErrorText><Loading /></Screen>;

  return (
    <Screen>
      {mosques.length === 0 && (
        <Card>
          <H2>No favorites yet</H2>
          <Muted>Find the mosques you visit and tap the star to keep their donation boxes here.</Muted>
          <Pressable onPress={() => router.push('/(donor)/discover')}><Text style={{ color: '#0f6b4f', fontWeight: '600', marginTop: 8 }}>Find a mosque →</Text></Pressable>
        </Card>
      )}
      {mosques.map((m) => (
        <Card key={m.id}>
          <Pressable onPress={() => router.push(`/mosque/${m.id}`)}>
            <Text style={{ fontSize: 18, fontWeight: '700' }}>{m.name}</Text>
            <Muted style={{ marginBottom: 12 }}>{m.city}, {m.state}</Muted>
          </Pressable>
          <DonationBox mosque={m} />
        </Card>
      ))}
    </Screen>
  );
}
