import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { api, type PaymentMethod } from '../../src/api';
import { openHosted, returnUrl } from '../../src/hosted';
import { Button, Card, ErrorText, Loading, Muted, Screen } from '../../src/ui';

export default function Payment() {
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<PaymentMethod[]>('GET', '/payment-methods').then(setMethods).catch((e) => setError(e.message));
  }, []);
  useFocusEffect(load);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string | null }>('POST', '/payment-methods', { returnUrl: returnUrl('/payment') });
      if (r.url) await openHosted(r.url);
      load(); // native: the browser sheet has closed; web: this page is reloaded on return
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api('DELETE', `/payment-methods/${id}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!methods) return <Screen><ErrorText>{error}</ErrorText><Loading /></Screen>;

  return (
    <Screen>
      <Muted style={{ marginBottom: 12 }}>
        Add a debit/credit card, Apple Pay, Google Pay or a US bank account. Details are entered on Stripe's secure page; we never see or store them.
        Your first saved method is used for one-tap and recurring donations.
      </Muted>
      <ErrorText>{error}</ErrorText>
      {methods.map((m) => (
        <Card key={m.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '600' }}>{m.label}</Text>
            <Muted>{m.type === 'card' ? 'Card' : 'Bank account (takes a few days to settle)'}</Muted>
          </View>
          <Button title="Remove" variant="outline" onPress={() => remove(m.id)} />
        </Card>
      ))}
      <Button title="Add payment method" busy={busy} onPress={add} />
    </Screen>
  );
}
