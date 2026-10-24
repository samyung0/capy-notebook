/** Cloudflare Turnstile on signed-out answer checks (Epo 2026-10-24, Q271).
 * The script loads only where such a check can happen; the site Worker's
 * policy for those pages allows its host (workers/site/handler.ts). */
const SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** How long a check waits for its token before it gives up (Q309); the API
 * then refuses the empty token and the page shows the failed-check copy. */
export const TAKE_TIMEOUT_MS = 15_000;

interface Turnstile {
  render(
    element: HTMLElement,
    options: {
      appearance: 'interaction-only';
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
      'refresh-expired': 'never';
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

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise<Turnstile>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = SCRIPT;
    tag.async = true;
    tag.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error('turnstile'));
    tag.onerror = () => reject(new Error('turnstile'));
    document.head.append(tag);
  });
}

// One widget serves the whole shared page, however many quizzes it holds
// (Q309). It renders at the first signed-out check and solves again only
// when a check asks for a token; an expired token is dropped, and the widget
// is told never to re-solve it in the background (Q350).
let widget: Promise<{ turnstile: Turnstile; id: string }> | undefined;
let token: string | undefined;
let solving = false;
const waiters: ((token: string) => void)[] = [];

function settle(value: string) {
  solving = false;
  const waiter = waiters.shift();
  if (waiter) waiter(value);
  else token = value || undefined;
  // Another check is still waiting: solve once more for it.
  if (waiters.length) void solve();
}

function mount(siteKey: string) {
  widget ??= loadTurnstile().then((turnstile) => {
    // Fixed on screen, so a challenge Cloudflare asks for is seen wherever
    // the check is; with interaction-only it is empty otherwise.
    const box = document.createElement('div');
    box.className = 'fixed bottom-4 left-1/2 z-50 -translate-x-1/2';
    document.body.append(box);
    solving = true;
    const id = turnstile.render(box, {
      appearance: 'interaction-only',
      callback: settle,
      'error-callback': () => settle(''),
      'expired-callback': () => {
        token = undefined;
      },
      'refresh-expired': 'never',
      sitekey: siteKey,
    });
    return { id, turnstile };
  });
  return widget;
}

async function solve() {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  if (!siteKey) {
    for (const waiter of waiters.splice(0)) waiter('');
    return;
  }
  try {
    const first = !widget;
    const { id, turnstile } = await mount(siteKey);
    if (!(first || solving)) {
      solving = true;
      turnstile.reset(id);
    }
  } catch {
    // The script did not load: this check fails, the next one tries again.
    widget = undefined;
    solving = false;
    for (const waiter of waiters.splice(0)) waiter('');
  }
}

/** A Turnstile token for one signed-out answer check: the one already solved,
 * or the next solve's. It resolves empty without a site key, when the script
 * cannot load, or after TAKE_TIMEOUT_MS, and the API refuses the check. */
export function takeTurnstileToken(): Promise<string> {
  if (token) {
    const ready = token;
    token = undefined;
    return Promise.resolve(ready);
  }
  return new Promise<string>((resolve) => {
    const waiter = (value: string) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      const at = waiters.indexOf(waiter);
      if (at >= 0) waiters.splice(at, 1);
      resolve('');
    }, TAKE_TIMEOUT_MS);
    waiters.push(waiter);
    if (!solving) void solve();
  });
}
