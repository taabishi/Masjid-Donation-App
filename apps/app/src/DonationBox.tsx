import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { api, type Mosque } from './api';
import { cents, colors } from './theme';
import { Button, Chip, ErrorText, Field, Muted } from './ui';

const QUICK = [100, 500, 1500, 2500];

/** The "digital donation box": quick amounts, custom amount, optional cause, with an inline confirm step. */
export function DonationBox({ mosque, showCauses = false, onDonated }: { mosque: Mosque; showCauses?: boolean; onDonated?: () => void }) {
  const [pending, setPending] = useState<number | null>(null);
  const [custom, setCustom] = useState<string | null>(null); // null = custom field hidden
  const [causeId, setCauseId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState<number | null>(null);

  if (!mosque.acceptingDonations) return <Muted>This mosque hasn't finished setting up donations yet.</Muted>;

  const pick = (amount: number) => { setPending(amount); setThanks(null); setError(null); };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/donations', { mosqueId: mosque.id, amountCents: pending, causeId });
      setThanks(pending);
      setPending(null);
      setCustom(null);
      onDonated?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const customCents = Math.round(parseFloat(custom ?? '') * 100);

  return (
    <View>
      {showCauses && mosque.causes.length > 1 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 }}>
          <Chip title="Any" selected={!causeId} onPress={() => setCauseId(undefined)} />
          {mosque.causes.map((c) => <Chip key={c.id} title={c.title} selected={causeId === c.id} onPress={() => setCauseId(c.id)} />)}
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {QUICK.map((a) => <Chip key={a} title={cents(a)} selected={pending === a && custom === null} onPress={() => { setCustom(null); pick(a); }} />)}
        <Chip title="Custom" selected={custom !== null} onPress={() => { setCustom(''); setPending(null); }} />
      </View>
      {custom !== null && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="Amount ($)" keyboardType="decimal-pad" value={custom} onChangeText={(t) => { setCustom(t); setPending(null); }} placeholder="10.00" />
          </View>
          <Button
            title="Next"
            style={{ marginBottom: 12 }}
            disabled={!(customCents >= 100 && customCents <= 1_000_000)}
            onPress={() => pick(customCents)}
          />
        </View>
      )}
      {pending && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ color: colors.text, marginBottom: 8 }}>Donate <Text style={{ fontWeight: '700' }}>{cents(pending)}</Text> to {mosque.name}?</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button title="Confirm" busy={busy} onPress={confirm} style={{ flex: 1 }} />
            <Button title="Cancel" variant="outline" onPress={() => setPending(null)} style={{ flex: 1 }} />
          </View>
        </View>
      )}
      {thanks && <Text style={{ color: colors.primary, fontWeight: '600', marginTop: 8 }}>JazakAllahu khayran — {cents(thanks)} donated.</Text>}
      <ErrorText>{error}</ErrorText>
    </View>
  );
}
