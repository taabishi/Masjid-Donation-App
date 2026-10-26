import { Link } from 'expo-router';
import { useState } from 'react';
import { useAuth } from '../src/auth';
import { Button, ErrorText, Field, H1, Muted, Screen } from '../src/ui';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <H1>Masjid Donation Box</H1>
      <Muted>Give to the mosques you visit, in one place.</Muted>
      <Field label="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
      <Field label="Password" secureTextEntry value={password} onChangeText={setPassword} onSubmitEditing={submit} />
      <ErrorText>{error}</ErrorText>
      <Button title="Sign in" onPress={submit} busy={busy} />
      <Link href="/register" style={{ marginTop: 16, textAlign: 'center' }}>Create an account</Link>
    </Screen>
  );
}
