import { useCallback, useEffect, useRef } from 'react';

/** Cloudflare Turnstile on signed-out answer checks (Epo 2026-10-24, Q271).
 * The script loads only where such a check can happen; the site Worker's
 * policy for those pages allows its host (workers/site/handler.ts). */
const SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  remove(widget: string): void;
  render(
    element: HTMLElement,
    options: {
      appearance: 'interaction-only';
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
      sitekey: string;
    }
  ): string;
  reset(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let script: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = SCRIPT;
    tag.async = true;
    tag.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error('turnstile'));
    tag.onerror = () => {
      script = undefined;
      reject(new Error('turnstile'));
    };
    document.head.append(tag);
  });
  return script;
}

/**
 * A Turnstile widget in managed mode for one signed-out answer check area. It
 * solves in the background once mounted and again after each token is taken,
 * so Check rarely waits; Cloudflare shows a challenge in `box` only when it
 * wants one. `take` resolves with the solved token, or the next one; with no
 * site key or no script it resolves empty and the API refuses the check.
 */
export function useTurnstile(enabled: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{
    id?: string;
    token?: string;
    failed?: boolean;
    waiters: ((token: string) => void)[];
  }>({ waiters: [] });

  useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as
      | string
      | undefined;
    const element = box.current;
    const state = widget.current;
    if (!(enabled && siteKey && element)) {
      state.failed = true;
      return;
    }
    state.failed = false;
    let gone = false;
    loadTurnstile()
      .then((turnstile) => {
        if (gone) return;
        // A waiting check takes the token, and the next solve starts.
        const settle = (token: string) => {
          const waiter = state.waiters.shift();
          if (!waiter) {
            state.token = token || undefined;
            return;
          }
          waiter(token);
          if (state.id) turnstile.reset(state.id);
        };
        state.id = turnstile.render(element, {
          appearance: 'interaction-only',
          callback: settle,
          'error-callback': () => settle(''),
          'expired-callback': () => {
            state.token = undefined;
            if (state.id) turnstile.reset(state.id);
          },
          sitekey: siteKey,
        });
      })
      .catch(() => {
        state.failed = true;
        for (const waiter of state.waiters.splice(0)) waiter('');
      });
    return () => {
      gone = true;
      if (state.id) window.turnstile?.remove(state.id);
      state.id = undefined;
      state.token = undefined;
    };
  }, [enabled]);

  const take = useCallback(
    () =>
      new Promise<string>((resolve) => {
        const state = widget.current;
        if (state.failed) {
          resolve('');
          return;
        }
        const token = state.token;
        state.token = undefined;
        if (token) resolve(token);
        else state.waiters.push(resolve);
        // A token is good for one check: start solving the next one.
        if (token && state.id) window.turnstile?.reset(state.id);
      }),
    []
  );

  return { box, take };
}
