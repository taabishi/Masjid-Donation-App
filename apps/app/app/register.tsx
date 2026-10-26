import { Link } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useAuth } from '../src/auth';
import { Button, Chip, ErrorText, Field, H1, H2, Muted, Screen } from '../src/ui';

export default function Register() {
  const { register } = useAuth();
  const [isMosque, setIsMosque] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', mosqueName: '', city: '', state: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await register({
        name: f.name,
        email: f.email,
        password: f.password,
        ...(isMosque ? { mosque: { name: f.mosqueName, city: f.city, state: f.state } } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <H1>Create account</H1>
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        <Chip title="I'm a donor" selected={!isMosque} onPress={() => setIsMosque(false)} />
        <Chip title="I run a mosque" selected={isMosque} onPress={() => setIsMosque(true)} />
      </View>
      <Field label="Your name" value={f.name} onChangeText={set('name')} />
      <Field label="Email" autoCapitalize="none" keyboardType="email-address" value={f.email} onChangeText={set('email')} />
      <Field label="Password (8+ characters)" secureTextEntry value={f.password} onChangeText={set('password')} />
      {isMosque && (
        <>
          <H2>Your mosque</H2>
          <Muted>You can add details, causes and payout info after signing up.</Muted>
          <Field label="Mosque / organization name" value={f.mosqueName} onChangeText={set('mosqueName')} />
          <Field label="City" value={f.city} onChangeText={set('city')} />
          <Field label="State" value={f.state} onChangeText={set('state')} />
        </>
      )}
      <ErrorText>{error}</ErrorText>
      <Button title="Sign up" onPress={submit} busy={busy} />
      <Link href="/login" style={{ marginTop: 16, textAlign: 'center' }}>I already have an account</Link>
    </Screen>
  );
}
