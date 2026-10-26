import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { api, type AdminReport, type Mosque } from '../../src/api';
import { useAuth } from '../../src/auth';
import { cents, colors } from '../../src/theme';
import { Button, Card, ErrorText, H1, H2, Loading, Muted, Screen } from '../../src/ui';

const Stat = ({ label, value }: { label: string; value: string }) => (
  <Card style={{ flexGrow: 1, flexBasis: '45%', marginBottom: 0 }}>
    <Muted>{label}</Muted>
    <Text style={{ fontSize: 22, fontWeight: '700', color: colors.primaryDark }}>{value}</Text>
  </Card>
);

export default function Dashboard() {
  const { signOut } = useAuth();
  const [mosque, setMosque] = useState<(Mosque & { payoutsConnected: boolean }) | null>(null);
  const [report, setReport] = useState<AdminReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api<typeof mosque>('GET', '/admin/mosque'), api<AdminReport>('GET', '/admin/donations')])
      .then(([m, r]) => { setMosque(m); setReport(r); })
      .catch((e) => setError(e.message));
  }, []);
  useFocusEffect(load);

  const connect = async () => {
    setBusy(true);
    try {
      await api('POST', '/admin/payouts/connect');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!mosque || !report) return <Screen><ErrorText>{error}</ErrorText><Loading /></Screen>;
  const { summary } = report;

  return (
    <Screen>
      <H1>{mosque.name}</H1>
      <ErrorText>{error}</ErrorText>
      {!mosque.payoutsConnected ? (
        <Card style={{ borderColor: colors.gold }}>
          <Text style={{ fontWeight: '700' }}>Set up payouts to start receiving donations</Text>
          <Muted style={{ marginVertical: 8 }}>Donors can't give until your bank account is connected. (Demo mode: this connects a mock account.)</Muted>
          <Button title="Connect payout account" busy={busy} onPress={connect} />
        </Card>
      ) : (
        <Card style={{ backgroundColor: colors.primarySoft }}><Text style={{ color: colors.primaryDark, fontWeight: '600' }}>✓ Payouts connected — accepting donations</Text></Card>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <Stat label="This month" value={cents(summary.thisMonthCents)} />
        <Stat label="All time" value={cents(summary.totalCents)} />
        <Stat label="Donations" value={String(summary.donationCount)} />
        <Stat label="Active recurring" value={String(summary.activeRecurring)} />
      </View>
      <H2>Recent donations</H2>
      {report.donations.length === 0 && <Muted>No donations yet.</Muted>}
      {report.donations.map((d) => (
        <Card key={d.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '600' }}>{d.donorName}</Text>
            <Muted>{new Date(d.createdAt).toLocaleDateString()}{d.cause ? ` · ${d.cause}` : ''}{d.recurring ? ' · recurring' : ''}</Muted>
          </View>
          <Text style={{ fontWeight: '700', color: colors.primary }}>{cents(d.amountCents)}</Text>
        </Card>
      ))}
      <Button title="Sign out" variant="outline" onPress={signOut} style={{ marginTop: 16 }} />
    </Screen>
  );
}
