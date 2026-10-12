import { createContext } from 'react';

/** True inside a page area that a PageFloatingBar overlays (the workspace's
 * viewer while its tools bar shows): content ending a scroll area there keeps
 * room under the bar. */
export const FloatingBarContext = createContext(false);

/** Given by the workspace around its viewer: an Office runtime reports the
 * height of its bottom chrome (sheet tabs, a narrow slide strip, the notes
 * box), and the floating tools button sits 8px above it. */
export const OfficeInsetContext = createContext<
  ((inset: number) => void) | null
>(null);
