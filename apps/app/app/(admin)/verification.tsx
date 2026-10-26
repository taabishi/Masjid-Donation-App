import * as DocumentPicker from 'expo-document-picker';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { api, upload, type Verification } from '../../src/api';
import { colors } from '../../src/theme';
import { Button, Card, ErrorText, Field, H2, Loading, Muted, Screen } from '../../src/ui';

const STATUS: Record<string, { label: string; color: string }> = {
  unverified: { label: 'Not verified yet', color: colors.muted },
  pending_review: { label: 'In review', color: colors.gold },
  verified: { label: 'Verified', color: colors.primary },
  rejected: { label: 'Needs changes', color: colors.danger },
};

export default function VerificationScreen() {
  const [v, setV] = useState<Verification | null>(null);
  const [ein, setEin] = useState('');
  const [legalName, setLegalName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Verification>('GET', '/admin/verification')
      .then((r) => {
        setV(r);
        setEin((cur) => cur || r.ein || '');
        setLegalName((cur) => cur || r.legalName || '');
      })
      .catch((e) => setError(e.message));
  }, []);
  useFocusEffect(load);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => run(() => api('POST', '/admin/verification', { ein, legalName }));

  const pickFile = () =>
    run(async () => {
      const r = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/png', 'image/jpeg'], copyToCacheDirectory: true });
      if (r.canceled) return;
      const f = r.assets[0];
      const blob = await (await fetch(f.uri)).blob();
      await upload('/admin/verification/documents', blob, f.mimeType ?? blob.type, f.name);
    });

  if (!v) return <Screen><ErrorText>{error}</ErrorText><Loading /></Screen>;
  const s = STATUS[v.status];
  const locked = v.status === 'verified';

  return (
    <Screen>
      <Card>
        <Muted>Status</Muted>
        <Text style={{ fontSize: 20, fontWeight: '700', color: s.color }}>{s.label}</Text>
        {v.status === 'rejected' && !!v.note && <Text style={{ color: colors.danger, marginTop: 8 }}>Reviewer note: {v.note}</Text>}
        {v.status === 'pending_review' && <Muted style={{ marginTop: 8 }}>A person on our team is reviewing your submission. You can add documents while you wait.</Muted>}
        {v.status === 'verified' && <Muted style={{ marginTop: 8 }}>Your organization is live: donors can find you and give.</Muted>}
      </Card>

      {!locked && (
        <>
          <H2>Tax-exempt details</H2>
          <Muted style={{ marginBottom: 8 }}>
            Only tax-exempt organizations can receive donations here. Enter the legal name and EIN exactly as on your IRS letter (the EIN is the 9-digit number like 12-3456789).
          </Muted>
          <Field label="Legal name" value={legalName} onChangeText={setLegalName} />
          <Field label="EIN" value={ein} onChangeText={setEin} placeholder="12-3456789" keyboardType="numbers-and-punctuation" />
          <Button title={v.status === 'unverified' ? 'Submit for review' : 'Resubmit for review'} busy={busy} onPress={submit} disabled={!ein.trim() || !legalName.trim()} />

          <H2>Documents (optional but speeds things up)</H2>
          <Muted style={{ marginBottom: 8 }}>
            Upload your IRS determination letter (PDF, PNG or JPG, up to 5 MB). Houses of worship are often tax-exempt without a letter: if you don't have one, tell us in your submission or upload any proof you have, such as an IRS affirmation letter.
          </Muted>
          {v.documents.map((d) => (
            <Card key={d.id}><Text>{d.filename}</Text></Card>
          ))}
          <Button title="Upload a document" variant="outline" onPress={pickFile} busy={busy} disabled={v.documents.length >= 5} />
        </>
      )}

      {v.lookup && (
        <View style={{ marginTop: 16 }}>
          <Muted>
            {v.lookup.status === 'found'
              ? `IRS-data match: ${v.lookup.record?.name} (${v.lookup.record?.city ?? ''}, ${v.lookup.record?.state ?? ''})`
              : v.lookup.status === 'not_found'
                ? "We couldn't find this EIN in public IRS data. That's normal for some houses of worship; a reviewer will look at your submission."
                : "We couldn't reach the public IRS data just now; a reviewer will check manually."}
          </Muted>
        </View>
      )}
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}
