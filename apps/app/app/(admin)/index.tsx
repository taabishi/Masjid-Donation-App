import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { api, type AdminReport, type Mosque, type VerificationStatus } from '../../src/api';
import { useAuth } from '../../src/auth';
import { openHosted, returnUrl } from '../../src/hosted';
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
  const router = useRouter();
  const [mosque, setMosque] = useState<(Mosque & { payoutsConnected: boolean; verificationStatus: VerificationStatus }) | null>(null);
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
      const r = await api<{ url: string | null }>('POST', '/admin/payouts/connect', { returnUrl: returnUrl('/') });
      if (r.url) await openHosted(r.url);
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
      {mosque.verificationStatus !== 'verified' && (
        <Card style={{ borderColor: colors.gold }}>
          <Text style={{ fontWeight: '700' }}>
            {mosque.verificationStatus === 'pending_review' ? 'Verification in review' : mosque.verificationStatus === 'rejected' ? 'Verification needs changes' : 'Verify your organization'}
          </Text>
          <Muted style={{ marginVertical: 8 }}>
            Donors can find you and give once we've confirmed your organization's tax-exempt status. It only takes your EIN and, if you have one, your IRS determination letter.
          </Muted>
          <Button title={mosque.verificationStatus === 'pending_review' ? 'View status' : 'Verify now'} onPress={() => router.push('/(admin)/verification')} />
        </Card>
      )}
      {mosque.verificationStatus !== 'verified' ? null : !mosque.payoutsConnected ? (
        <Card style={{ borderColor: colors.gold }}>
          <Text style={{ fontWeight: '700' }}>Donations are already being collected for you</Text>
          <Muted style={{ marginVertical: 8 }}>
            Connect your bank account on Stripe's secure page so we can send you the balance below automatically. Until then, we'll arrange payment with you directly.
          </Muted>
          <Button title="Connect payout account" busy={busy} onPress={connect} />
        </Card>
      ) : (
        <Card style={{ backgroundColor: colors.primarySoft }}><Text style={{ color: colors.primaryDark, fontWeight: '600' }}>✓ Payout account connected</Text></Card>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <Stat label="Balance waiting for you" value={cents(summary.balanceCents)} />
        <Stat label="This month (gross)" value={cents(summary.thisMonthCents)} />
        <Stat label="All time (gross)" value={cents(summary.totalCents)} />
        <Stat label="Donations" value={String(summary.donationCount)} />
        <Stat label="Active recurring" value={String(summary.activeRecurring)} />
      </View>
      <Muted>Balance = donations minus payment-processing fees, minus anything already paid out.</Muted>
      {report.payouts.length > 0 && (
        <>
          <H2>Payouts to you</H2>
          {report.payouts.map((p) => (
            <Card key={p.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '600' }}>{p.method === 'ach_manual' ? 'Bank transfer (ACH)' : 'Stripe transfer'}</Text>
                <Muted>{new Date(p.createdAt).toLocaleDateString()}{p.status === 'pending' ? ' · pending' : ''}</Muted>
              </View>
              <Text style={{ fontWeight: '700', color: colors.primary }}>{cents(p.amountCents)}</Text>
            </Card>
          ))}
        </>
      )}
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
