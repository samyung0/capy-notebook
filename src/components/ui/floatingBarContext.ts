import { createContext } from 'react';

/** True inside a page area that a PageFloatingBar overlays (the workspace's
 * viewer while its tools bar shows): content ending a scroll area there keeps
 * room under the bar. */
export const FloatingBarContext = createContext(false);
