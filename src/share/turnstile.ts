/** Cloudflare Turnstile on signed-out answer checks (Epo 2026-10-24, Q271).
 * The script loads only where such a check can happen; the site Worker's
 * policy for those pages allows its host (workers/site/handler.ts). */
const SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** How long a check waits for its token before it gives up (Q309); the API
 * then refuses the empty token and the page shows the failed-check copy. The
 * clock stops while an interactive challenge shows (Q372). */
export const TAKE_TIMEOUT_MS = 15_000;

interface Turnstile {
  remove(widget: string): void;
  render(
    element: HTMLElement,
    options: {
      appearance: 'interaction-only';
      'after-interactive-callback': () => void;
      'before-interactive-callback': () => void;
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
      'refresh-expired': 'never';
      'refresh-timeout': 'manual';
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
// (Q309). It renders under the Submit of the check that asks for a token
// (`slot`, Q372), rendering again under another check's Submit when that one
// asks. It solves only when a check asks; an expired token is dropped, and
// the widget is told never to re-solve it in the background (Q350). An
// interactive challenge that times out waits for the visitor rather than
// running again by itself.
interface Waiter {
  /** What is left of its TAKE_TIMEOUT_MS, and since when it has run. */
  left: number;
  resolve: (token: string) => void;
  since: number;
  slot: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
}
let loading: Promise<Turnstile> | undefined;
let widget: { id: string; slot: HTMLElement; turnstile: Turnstile } | undefined;
let token: string | undefined;
let solving = false;
const waiters: Waiter[] = [];
/** The slot whose challenge Cloudflare shows the visitor; waits stop then. */
let showing: HTMLElement | null = null;
const listeners = new Set<() => void>();

function startClock(waiter: Waiter) {
  waiter.since = Date.now();
  waiter.timer = setTimeout(() => {
    const at = waiters.indexOf(waiter);
    if (at >= 0) waiters.splice(at, 1);
    waiter.resolve('');
  }, waiter.left);
}

function stopClock(waiter: Waiter) {
  clearTimeout(waiter.timer);
  waiter.left -= Date.now() - waiter.since;
}

function finish(waiter: Waiter, value: string) {
  clearTimeout(waiter.timer);
  waiter.resolve(value);
}

function show(slot: HTMLElement | null) {
  if (showing === slot) return;
  const paused = showing !== null;
  showing = slot;
  if (slot && !paused) for (const waiter of waiters) stopClock(waiter);
  if (paused && !slot) for (const waiter of waiters) startClock(waiter);
  for (const listener of listeners) listener();
}

function settle(value: string) {
  solving = false;
  show(null);
  const waiter = waiters.shift();
  if (waiter) finish(waiter, value);
  else token = value || undefined;
  // Another check is still waiting: solve once more for it.
  if (waiters.length) void solve();
}

async function solve() {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  if (!siteKey) {
    for (const waiter of waiters.splice(0)) finish(waiter, '');
    return;
  }
  const slot = waiters[0].slot;
  solving = true;
  try {
    loading ??= loadTurnstile();
    const turnstile = await loading;
    if (widget?.slot === slot) {
      turnstile.reset(widget.id);
      return;
    }
    if (widget) turnstile.remove(widget.id);
    const id = turnstile.render(slot, {
      'after-interactive-callback': () => show(null),
      appearance: 'interaction-only',
      'before-interactive-callback': () => show(slot),
      callback: settle,
      'error-callback': () => settle(''),
      'expired-callback': () => {
        token = undefined;
      },
      'refresh-expired': 'never',
      'refresh-timeout': 'manual',
      sitekey: siteKey,
    });
    widget = { id, slot, turnstile };
  } catch {
    // The script did not load: this check fails, the next one tries again.
    loading = undefined;
    solving = false;
    for (const waiter of waiters.splice(0)) finish(waiter, '');
  }
}

/** A Turnstile token for one signed-out answer check, whose Submit has
 * `slot` under it: the one already solved, or the next solve's. It resolves
 * empty without a site key, when the script cannot load, or once
 * TAKE_TIMEOUT_MS has run outside an interactive challenge, and the API
 * refuses the check. */
export function takeTurnstileToken(slot: HTMLElement): Promise<string> {
  if (token) {
    const ready = token;
    token = undefined;
    return Promise.resolve(ready);
  }
  return new Promise<string>((resolve) => {
    const waiter: Waiter = { left: TAKE_TIMEOUT_MS, resolve, since: 0, slot };
    waiters.push(waiter);
    if (!showing) startClock(waiter);
    if (!solving) void solve();
  });
}

/** The slot whose interactive challenge shows now, and its changes, for the
 * check under whose Submit it sits (TurnstileCheck.tsx). */
export const challengeSlot = () => showing;
export function onChallenge(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
