import { createContext } from 'react';

export type FileMode = 'view' | 'edit';

// Keep context identity separate from the hot-reloaded file controls.
export const FileHeaderTarget = createContext<HTMLElement | null>(null);

export const FileModeContext = createContext<{
  mode: FileMode;
  onChange: (mode: FileMode) => void;
} | null>(null);
