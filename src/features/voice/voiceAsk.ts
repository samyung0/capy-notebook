import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

let pending: string | null = null;
const askListeners = new Set<() => void>();

/** Hands a spoken question to the account chat, which starts a new chat with
 * it: at once if it is open, else when it opens. */
export function askByVoice(text: string) {
  pending = text;
  for (const listener of askListeners) listener();
}

/** The account chat's end of askByVoice. */
export function useVoiceAsk(onAsk: (text: string) => void) {
  const ask = useEffectEvent(onAsk);
  useEffect(() => {
    const take = () => {
      if (pending === null) return;
      const text = pending;
      pending = null;
      ask(text);
    };
    take();
    askListeners.add(take);
    return () => {
      askListeners.delete(take);
    };
  }, []);
}

/* Whether the account voice overlay is open. It lives in the app shell, not
   in the sidebar card, so the phone drawer can close under it. */
let accountOpen = false;
const openListeners = new Set<() => void>();

export function setAccountVoiceOpen(open: boolean) {
  accountOpen = open;
  for (const listener of openListeners) listener();
}

export function useAccountVoiceOpen() {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => {
        openListeners.delete(listener);
      };
    },
    () => accountOpen
  );
}
