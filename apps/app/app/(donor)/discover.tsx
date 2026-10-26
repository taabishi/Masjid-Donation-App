import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api, type Mosque } from '../../src/api';
import { colors } from '../../src/theme';
import { Card, ErrorText, Field, Loading, Muted, Screen } from '../../src/ui';

export default function Discover() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [mosques, setMosques] = useState<Mosque[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<Mosque[]>('GET', `/mosques?q=${encodeURIComponent(q)}`).then(setMosques).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const toggle = async (m: Mosque) => {
    const next = !m.isFavorite;
    setMosques((list) => list?.map((x) => (x.id === m.id ? { ...x, isFavorite: next } : x)) ?? null);
    try {
      await api(next ? 'PUT' : 'DELETE', `/favorites/${m.id}`);
    } catch (e) {
      setError((e as Error).message);
      setMosques((list) => list?.map((x) => (x.id === m.id ? { ...x, isFavorite: !next } : x)) ?? null);
    }
  };

  return (
    <Screen>
      <Field label="Search by name or city" value={q} onChangeText={setQ} placeholder="e.g. Dearborn" />
      <ErrorText>{error}</ErrorText>
      {!mosques ? <Loading /> : mosques.length === 0 ? <Muted>No mosques found.</Muted> : mosques.map((m) => (
        <Card key={m.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable style={{ flex: 1 }} onPress={() => router.push(`/mosque/${m.id}`)}>
              <Text style={{ fontSize: 17, fontWeight: '700' }}>{m.name}</Text>
              <Muted>{m.city}, {m.state}</Muted>
            </Pressable>
            <Pressable accessibilityLabel={m.isFavorite ? 'Remove favorite' : 'Add favorite'} onPress={() => toggle(m)} hitSlop={12}>
              <Text style={{ fontSize: 28, color: m.isFavorite ? colors.gold : colors.border }}>{m.isFavorite ? '★' : '☆'}</Text>
            </Pressable>
          </View>
        </Card>
      ))}
    </Screen>
  );
}
