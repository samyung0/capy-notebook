import { createContext } from 'react';

/** True inside a page area that a bottom control overlays (the workspace's
 * viewer below lg, under its chat dock): content ending a scroll area there
 * keeps room under it. */
export const FloatingBarContext = createContext(false);

/** Given by the workspace around its viewer: an Office runtime reports the
 * height of its bottom chrome (sheet tabs, a narrow slide strip, the notes
 * box), and the chat button sits 8px above it. */
export const OfficeInsetContext = createContext<
  ((inset: number) => void) | null
>(null);
