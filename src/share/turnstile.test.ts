import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/* One Turnstile widget per shared page (Q309), against a fake Turnstile and
   a bare document: it renders under the Submit of the check that asks
   (Q372), solves again only when a check asks, and a check stops waiting
   after 15 s, unless an interactive challenge shows. */

interface FakeOptions {
  'after-interactive-callback'?: () => void;
  'before-interactive-callback'?: () => void;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'refresh-expired'?: string;
  'refresh-timeout'?: string;
}

let options: FakeOptions[];
let targets: unknown[];
let removed: string[];
let resets: number;
let appended: number;
/** Stand-ins for the slots under two checks' Submit buttons. */
const slot = { name: 'slot under the first Submit' } as unknown as HTMLElement;
const otherSlot = {
  name: 'slot under the second Submit',
} as unknown as HTMLElement;

/** A token's expiry as Turnstile handles it: the widget solves again by
 * itself unless rendered with `'refresh-expired': 'never'`. */
function expire(widget: FakeOptions) {
  widget['expired-callback']();
  if (widget['refresh-expired'] !== 'never') widget.callback('token-refreshed');
}

/** An interactive challenge timing out as Turnstile handles it: the widget
 * runs it again by itself unless rendered with `'refresh-timeout': 'manual'`
 * (or `never`). */
function timeOut(widget: FakeOptions) {
  if (!['manual', 'never'].includes(widget['refresh-timeout'] ?? 'auto'))
    widget.callback('token-rerun');
}

/** Whether a check's promise has settled, without awaiting it. */
function settled(check: Promise<string>) {
  const state = { done: false };
  void check.then(() => {
    state.done = true;
  });
  return state;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
  options = [];
  targets = [];
  removed = [];
  resets = 0;
  appended = 0;
  vi.stubGlobal('window', {
    turnstile: {
      remove: (id: string) => {
        removed.push(id);
      },
      render: (target: unknown, given: FakeOptions) => {
        targets.push(target);
        options.push(given);
        return `widget-${options.length}`;
      },
      reset: () => {
        resets++;
      },
    },
  });
  vi.stubGlobal('document', {
    body: {
      append: () => {
        appended++;
      },
    },
    createElement: () => ({}),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('renders one widget at the first check and none before', async () => {
  const { takeTurnstileToken } = await import('./turnstile');
  expect(options).toHaveLength(0);
  const first = takeTurnstileToken(slot);
  const second = takeTurnstileToken(slot);
  await vi.waitFor(() => expect(options).toHaveLength(1));
  options[0].callback('token-1');
  await vi.waitFor(() => expect(resets).toBe(1));
  options[0].callback('token-2');
  await expect(first).resolves.toBe('token-1');
  await expect(second).resolves.toBe('token-2');
  expect(options).toHaveLength(1);
});

it('renders under the asking check, with no overlay, and shows only while a challenge does', async () => {
  const { challengeSlot, takeTurnstileToken } = await import('./turnstile');
  const first = takeTurnstileToken(slot);
  await vi.waitFor(() => expect(options).toHaveLength(1));
  expect(targets).toEqual([slot]);
  expect(appended).toBe(0);
  expect(challengeSlot()).toBeNull();
  options[0]['before-interactive-callback']?.();
  expect(challengeSlot()).toBe(slot);
  options[0].callback('token-1');
  expect(challengeSlot()).toBeNull();
  await expect(first).resolves.toBe('token-1');
  // Another check's Submit gets the page's one widget.
  const next = takeTurnstileToken(otherSlot);
  await vi.waitFor(() => expect(options).toHaveLength(2));
  expect(targets).toEqual([slot, otherSlot]);
  expect(removed).toEqual(['widget-1']);
  options[1].callback('token-2');
  await expect(next).resolves.toBe('token-2');
});

it('does not solve again when a token expires, only at the next check', async () => {
  const { takeTurnstileToken } = await import('./turnstile');
  const first = takeTurnstileToken(slot);
  await vi.waitFor(() => expect(options).toHaveLength(1));
  options[0].callback('token-1');
  await expect(first).resolves.toBe('token-1');
  expire(options[0]);
  expect(resets).toBe(0);
  const next = takeTurnstileToken(slot);
  await vi.waitFor(() => expect(resets).toBe(1));
  options[0].callback('token-2');
  await expect(next).resolves.toBe('token-2');
});

it('gives up after 15 s with an empty token when no challenge shows', async () => {
  const { TAKE_TIMEOUT_MS, takeTurnstileToken } = await import('./turnstile');
  const check = takeTurnstileToken(slot);
  await vi.waitFor(() => expect(options).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(TAKE_TIMEOUT_MS);
  await expect(check).resolves.toBe('');
});

it('waits past 15 s while a challenge shows, then takes the solved token', async () => {
  const { TAKE_TIMEOUT_MS, takeTurnstileToken } = await import('./turnstile');
  const check = takeTurnstileToken(slot);
  const state = settled(check);
  await vi.waitFor(() => expect(options).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(TAKE_TIMEOUT_MS / 3);
  options[0]['before-interactive-callback']?.();
  await vi.advanceTimersByTimeAsync(TAKE_TIMEOUT_MS * 4);
  expect(state.done).toBe(false);
  options[0]['after-interactive-callback']?.();
  options[0].callback('token-solved');
  await expect(check).resolves.toBe('token-solved');
});

it('waits for the visitor when a challenge times out, with no solve in the background', async () => {
  const { TAKE_TIMEOUT_MS, takeTurnstileToken } = await import('./turnstile');
  const first = takeTurnstileToken(slot);
  await vi.waitFor(() => expect(options).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(TAKE_TIMEOUT_MS);
  await expect(first).resolves.toBe('');
  timeOut(options[0]);
  const next = takeTurnstileToken(slot);
  options[0].callback('token-visitor');
  await expect(next).resolves.toBe('token-visitor');
});
