import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { api, downloadBlob, type ReviewItem } from '../src/api';
import { colors } from '../src/theme';
import { Button, Card, ErrorText, Field, H1, H2, Loading, Muted, Screen } from '../src/ui';

const yesNo = (v?: boolean) => (v === undefined ? '—' : v ? 'yes' : 'NO');

function Item({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const l = item.lookup;

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/ops/verifications/${item.mosqueId}`, { decision, note: note || undefined });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = async (docId: string) => {
    if (Platform.OS !== 'web') return setError('Open the console on the web to view documents.');
    try {
      const blob = await downloadBlob(`/ops/verifications/${item.mosqueId}/documents/${docId}`);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Card>
      <Text style={{ fontSize: 17, fontWeight: '700' }}>{item.name}</Text>
      <Muted>{item.city}, {item.state} · {item.adminEmail}</Muted>
      <View style={{ marginVertical: 8 }}>
        <Text>Legal name: <Text style={{ fontWeight: '600' }}>{item.legalName ?? '—'}</Text></Text>
        <Text>EIN: <Text style={{ fontWeight: '600' }}>{item.ein ?? '—'}</Text></Text>
      </View>
      <View style={{ backgroundColor: colors.primarySoft, borderRadius: 8, padding: 10, marginBottom: 8 }}>
        <Text style={{ fontWeight: '600' }}>IRS data check: {l?.status ?? 'none'}</Text>
        {l?.status === 'found' && (
          <>
            <Text>Official name: {l.record?.name} ({l.record?.city}, {l.record?.state})</Text>
            <Text>Name match: {l.nameMatch} · State match: {yesNo(l.stateMatch)} · 501(c)(3): {yesNo(l.is501c3)}</Text>
          </>
        )}
        {l?.status === 'not_found' && <Text>Not in the directory (normal for some houses of worship: ask for a letter).</Text>}
        {l?.status === 'unavailable' && <Text>Directory was unreachable: check the EIN manually at the IRS Tax Exempt Organization Search.</Text>}
      </View>
      {item.documents.length === 0 ? <Muted>No documents uploaded.</Muted> : item.documents.map((d) => (
        <Button key={d.id} title={`View ${d.filename}`} variant="outline" onPress={() => open(d.id)} style={{ marginBottom: 6 }} />
      ))}
      <Field label="Note (required to reject; shown to the organization)" value={note} onChangeText={setNote} multiline />
      <ErrorText>{error}</ErrorText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="Approve" busy={busy} onPress={() => decide('approve')} style={{ flex: 1 }} />
        <Button title="Reject" variant="danger" busy={busy} disabled={!note.trim()} onPress={() => decide('reject')} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

export default function Ops() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<ReviewItem[]>('GET', '/ops/verifications?status=pending_review').then(setItems).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Operator console' }} />
      <H1>Verification queue</H1>
      <Muted>Approve only when the EIN, legal name and location belong to the organization that applied. Anyone can type someone else's EIN.</Muted>
      <ErrorText>{error}</ErrorText>
      {!items ? <Loading /> : items.length === 0 ? <H2>Nothing waiting for review</H2> : items.map((i) => <Item key={i.mosqueId} item={i} onDone={load} />)}
    </Screen>
  );
}
