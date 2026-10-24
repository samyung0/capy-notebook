import { useEffect, useState } from 'react';

/* Whether the visitor is signed in, settled once Clerk loads after first paint
   (ShareAuth.tsx). Pages read it only when they save an attempt or a rating,
   so the edge-cached page and data stay the same for every visitor. */

let settle: (signedIn: boolean) => void = () => undefined;
let settled: boolean | undefined;
const session = new Promise<boolean>((resolve) => {
  settle = resolve;
});

export const signedIn = () => session;

/** The session's answer once Clerk has given it, else `undefined`: a check
 * that cannot wait takes the signed-out route until then (Q311). */
export const sessionNow = () => settled;

/** Later calls are ignored: the first answer holds for the page's life. */
export const settleSession = (value: boolean) => {
  settled ??= value;
  settle(value);
};

/** `undefined` until Clerk answers. */
export function useSignedIn(): boolean | undefined {
  const [value, setValue] = useState<boolean>();
  useEffect(() => {
    let live = true;
    void session.then((answer) => live && setValue(answer));
    return () => {
      live = false;
    };
  }, []);
  return value;
}
