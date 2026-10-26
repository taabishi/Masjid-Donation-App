import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text } from 'react-native';
import { api, type Recurring } from '../../src/api';
import { cents } from '../../src/theme';
import { Button, Card, ErrorText, Loading, Muted, Screen } from '../../src/ui';

export default function RecurringScreen() {
  const [items, setItems] = useState<Recurring[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Recurring[]>('GET', '/recurring').then(setItems).catch((e) => setError(e.message));
  }, []);
  useFocusEffect(load);

  const cancel = async (id: string) => {
    try {
      await api('DELETE', `/recurring/${id}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!items) return <Screen><ErrorText>{error}</ErrorText><Loading /></Screen>;

  return (
    <Screen>
      <ErrorText>{error}</ErrorText>
      {items.length === 0 && <Muted>No recurring donations. Open a mosque and choose "Give regularly" to set one up.</Muted>}
      {items.map((r) => (
        <Card key={r.id}>
          <Text style={{ fontSize: 17, fontWeight: '700' }}>{cents(r.amountCents)} {r.frequency}</Text>
          <Text>{r.mosqueName}</Text>
          <Muted style={{ marginBottom: 12 }}>Next: {new Date(r.nextDate).toLocaleDateString()}</Muted>
          <Button title="Cancel" variant="outline" onPress={() => cancel(r.id)} />
        </Card>
      ))}
    </Screen>
  );
}
