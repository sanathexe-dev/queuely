import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, session, setUnauthorizedHandler } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [manager, setManager] = useState(null);
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    session.clear();
    setManager(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!session.get()) {
      setReady(true);
      return;
    }
    api('/auth/me')
      .then((d) => setManager(d.manager))
      .catch(() => session.clear())
      .finally(() => setReady(true));
  }, [logout]);

  const login = useCallback(async (email, password) => {
    const d = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
    session.set(d.token);
    setManager(d.manager);
  }, []);

  const register = useCallback(async (name, email, password) => {
    const d = await api('/auth/register', { method: 'POST', body: { name, email, password }, auth: false });
    session.set(d.token);
    setManager(d.manager);
  }, []);

  const value = useMemo(() => ({ manager, ready, login, register, logout }), [manager, ready, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
