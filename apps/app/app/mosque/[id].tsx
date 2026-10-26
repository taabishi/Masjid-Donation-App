import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api, type Mosque } from '../../src/api';
import { DonationBox } from '../../src/DonationBox';
import { cents, colors } from '../../src/theme';
import { Button, Card, Chip, ErrorText, Field, H1, H2, Loading, Muted, Screen } from '../../src/ui';

export default function MosqueDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [m, setM] = useState<Mosque | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('10');
  const [freq, setFreq] = useState<'weekly' | 'monthly'>('weekly');
  const [recMsg, setRecMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Mosque>('GET', `/mosques/${id}`).then(setM).catch((e) => setError(e.message));
  }, [id]);

  const toggleFav = async () => {
    if (!m) return;
    try {
      await api(m.isFavorite ? 'DELETE' : 'PUT', `/favorites/${m.id}`);
      setM({ ...m, isFavorite: !m.isFavorite });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startRecurring = async () => {
    if (!m) return;
    setBusy(true);
    setError(null);
    setRecMsg(null);
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      await api('POST', '/recurring', { mosqueId: m.id, amountCents, frequency: freq });
      setRecMsg(`Done — ${cents(amountCents)} ${freq}. Manage it in the Recurring tab.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!m) return <Screen><ErrorText>{error}</ErrorText><Loading /></Screen>;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: m.name }} />
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <H1>{m.name}</H1>
          <Muted>{[m.address, `${m.city}, ${m.state}`].filter(Boolean).join(' · ')}</Muted>
        </View>
        <Pressable onPress={toggleFav} hitSlop={12}>
          <Text style={{ fontSize: 32, color: m.isFavorite ? colors.gold : colors.border }}>{m.isFavorite ? '★' : '☆'}</Text>
        </Pressable>
      </View>
      {!!m.description && <Text style={{ marginVertical: 12, color: colors.text }}>{m.description}</Text>}

      <H2>Donate now</H2>
      <Card><DonationBox mosque={m} showCauses /></Card>

      {m.acceptingDonations && (
        <>
          <H2>Give regularly</H2>
          <Card>
            <Muted style={{ marginBottom: 8 }}>Set it once, like dropping something in the box every Jumu'ah.</Muted>
            <View style={{ flexDirection: 'row' }}>
              <Chip title="Weekly" selected={freq === 'weekly'} onPress={() => setFreq('weekly')} />
              <Chip title="Monthly" selected={freq === 'monthly'} onPress={() => setFreq('monthly')} />
            </View>
            <Field label="Amount ($)" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
            <Button title="Start recurring donation" busy={busy} onPress={startRecurring} />
            {recMsg && <Text style={{ color: colors.primary, marginTop: 8 }}>{recMsg}</Text>}
          </Card>
        </>
      )}
      <ErrorText>{error}</ErrorText>

      <H2>What we're collecting for</H2>
      {m.causes.map((c) => (
        <Card key={c.id}>
          <Text style={{ fontWeight: '600' }}>{c.title}</Text>
          {!!c.description && <Muted>{c.description}</Muted>}
        </Card>
      ))}
    </Screen>
  );
}
