import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '../src/auth';
import { Loading } from '../src/ui';

function Guard() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const group = segments[0] as string | undefined;

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (group !== 'login' && group !== 'register') router.replace('/login');
    } else if (user.role === 'admin') {
      if (group !== '(admin)') router.replace('/(admin)');
    } else if (group !== '(donor)' && group !== 'mosque' && !(group === 'ops' && user.operator)) {
      router.replace('/(donor)');
    }
  }, [user, loading, group, router]);

  return loading ? <Loading /> : <Slot />;
}

export default function Root() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Guard />
    </AuthProvider>
  );
}
