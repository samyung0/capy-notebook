import { createContext, useContext } from 'react';
import type { OpsApi, Session } from './api';

type AppContextValue = {
  api: OpsApi;
  session: Session;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppContextProvider({
  value,
  children,
}: {
  value: AppContextValue;
  children: React.ReactNode;
}) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useOpsApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useOpsApp must be used inside AppContextProvider.');
  }
  return value;
}
