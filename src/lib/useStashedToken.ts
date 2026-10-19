import { useEffect, useState } from 'react';
import {
  clearStashedToken,
  type StashKind,
  stashedToken,
} from '@/lib/urlTokenStash';

/** A token route's token (urlTokenStash.ts), held for the page's life. The
 * stashed copy goes when the page is left (cancel, a refusal, navigating
 * away); the page also drops it once the token was used or refused. A refresh
 * before either still finds it. */
export function useStashedToken(kind: StashKind, value: string): string {
  const [token] = useState(() => stashedToken(kind, value));
  useEffect(() => () => clearStashedToken(kind), [kind]);
  return token;
}
