/**
 * Imported right after Zod jitless in main.tsx, so it runs before Sentry
 * starts and before the router reads the address: see urlTokenStash.ts.
 */
import { stashUrlTokens } from './urlTokenStash';

try {
  const clean = stashUrlTokens(window.location, sessionStorage);
  if (clean !== null)
    window.history.replaceState(window.history.state, '', clean);
} catch {
  // Storage unavailable (a locked-down browser): the address keeps its token
  // and the page still works.
}
