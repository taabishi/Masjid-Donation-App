import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setOnUnauthorized, setToken, type User } from './api';
import { getItem, removeItem, setItem } from './storage';

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (body: Record<string, unknown>) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(async () => {
    setToken(null);
    setUser(null);
    await removeItem('token');
  }, []);

  useEffect(() => {
    setOnUnauthorized(() => void signOut());
    (async () => {
      try {
        const t = await getItem('token');
        if (t) {
          setToken(t);
          setUser(await api<User>('GET', '/me'));
        }
      } catch {
        setToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [signOut]);

  const finish = async (r: { token: string; user: User }) => {
    setToken(r.token);
    await setItem('token', r.token);
    setUser(r.user);
  };

  return (
    <Ctx.Provider
      value={{
        user,
        loading,
        signOut,
        signIn: async (email, password) => finish(await api('POST', '/auth/login', { email, password })),
        register: async (body) => finish(await api('POST', '/auth/register', body)),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
