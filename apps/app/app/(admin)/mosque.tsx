import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { api, type Cause, type Mosque } from '../../src/api';
import { colors } from '../../src/theme';
import { Button, Card, ErrorText, Field, H2, Loading, Muted, Screen } from '../../src/ui';

export default function MosquePage() {
  const [m, setM] = useState<Mosque | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [newCause, setNewCause] = useState({ title: '', description: '' });

  const load = useCallback(() => {
    api<Mosque>('GET', '/admin/mosque').then(setM).catch((e) => setError(e.message));
  }, []);
  useFocusEffect(load);

  if (!m) return <Screen><ErrorText>{error}</ErrorText><Loading /></Screen>;
  const set = (k: 'name' | 'city' | 'state' | 'address' | 'description') => (v: string) => { setSaved(false); setM({ ...m, [k]: v }); };

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
  };

  const save = () => run(async () => {
    await api('PUT', '/admin/mosque', { name: m.name, city: m.city, state: m.state, address: m.address, description: m.description });
    setSaved(true);
  });
  const addCause = () => run(async () => {
    await api('POST', '/admin/causes', newCause);
    setNewCause({ title: '', description: '' });
    load();
  });
  const removeCause = (c: Cause) => run(async () => { await api('DELETE', `/admin/causes/${c.id}`); load(); });

  return (
    <Screen>
      <H2>Public profile</H2>
      <Field label="Name" value={m.name} onChangeText={set('name')} />
      <Field label="Address" value={m.address} onChangeText={set('address')} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 2 }}><Field label="City" value={m.city} onChangeText={set('city')} /></View>
        <View style={{ flex: 1 }}><Field label="State" value={m.state} onChangeText={set('state')} /></View>
      </View>
      <Field label="About" multiline value={m.description} onChangeText={set('description')} />
      <Button title="Save profile" onPress={save} />
      {saved && <Text style={{ color: colors.primary, marginTop: 8 }}>Saved.</Text>}
      <ErrorText>{error}</ErrorText>

      <H2>What you're collecting for</H2>
      {m.causes.map((c) => (
        <Card key={c.id}>
          <Text style={{ fontWeight: '600' }}>{c.title}</Text>
          {!!c.description && <Muted>{c.description}</Muted>}
          <Button title="Remove" variant="outline" onPress={() => removeCause(c)} style={{ marginTop: 8 }} />
        </Card>
      ))}
      <Card>
        <Field label="New cause" value={newCause.title} onChangeText={(t) => setNewCause({ ...newCause, title: t })} placeholder="e.g. Roof repair" />
        <Field label="Description" value={newCause.description} onChangeText={(t) => setNewCause({ ...newCause, description: t })} />
        <Button title="Add cause" disabled={!newCause.title.trim()} onPress={addCause} />
      </Card>
    </Screen>
  );
}
