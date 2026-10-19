import { api } from '@/api/client';
import type { ShareRedemption } from '@/api/types';

const redeemed = new Map<string, Promise<ShareRedemption>>();

/** Presents a signed share link (`{id}.{signature}`) once for the signed-in
 * viewer: a link workspace or standalone material reaches a non-member only
 * after this (Google's resource key, Sam 2026-10-18), and bare-id calls pass
 * from then on. One request per token for the page's life; a failure is
 * forgotten so a retry asks again. */
export function redeemShareToken(token: string): Promise<ShareRedemption> {
  let pending = redeemed.get(token);
  if (!pending) {
    pending = api.post<ShareRedemption>('/share/redeem', { token });
    pending.catch(() => redeemed.delete(token));
    redeemed.set(token, pending);
  }
  return pending;
}
