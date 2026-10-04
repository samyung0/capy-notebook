import { createContext, type Dispatch, type SetStateAction } from 'react';

export const AppShellContext = createContext<Dispatch<
  SetStateAction<boolean>
> | null>(null);
