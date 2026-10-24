import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, post, setUnauthenticatedHandler } from './api';

export interface Me {
  id: string;
  email: string;
  display_name: string;
  role: string;
  permissions: string[];
  must_change_password: boolean;
}

interface AuthCtx {
  me: Me | null | undefined; // undefined = still checking
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (perm: string) => boolean;
}

const Ctx = createContext<AuthCtx>({ me: undefined, refresh: async () => {}, logout: async () => {}, can: () => false });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      setMe(await get<Me>('/auth/me'));
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    setUnauthenticatedHandler(() => setMe(null));
    void refresh();
  }, [refresh]);
  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setMe(null);
    }
  }, []);
  const can = useCallback((perm: string) => Boolean(me?.permissions.includes(perm)), [me]);
  return <Ctx.Provider value={{ me, refresh, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
