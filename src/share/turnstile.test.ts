import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/* One Turnstile widget per shared page (Q309), against a fake Turnstile and
   a bare document: it renders at the first check, solves again only when a
   check asks, and a check stops waiting after 15 s. */

interface FakeOptions {
  callback: (token: string) => void;
  'expired-callback': () => void;
  'refresh-expired'?: string;
}

let options: FakeOptions[];
let resets: number;

/** A token's expiry as Turnstile handles it: the widget solves again by
 * itself unless rendered with `'refresh-expired': 'never'`. */
function expire(widget: FakeOptions) {
  widget['expired-callback']();
  if (widget['refresh-expired'] !== 'never') widget.callback('token-refreshed');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
  options = [];
  resets = 0;
  vi.stubGlobal('window', {
    turnstile: {
      render: (_box: unknown, given: FakeOptions) => {
        options.push(given);
        return `widget-${options.length}`;
      },
      reset: () => {
        resets++;
      },
    },
  });
  vi.stubGlobal('document', {
    body: { append: () => undefined },
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
  const first = takeTurnstileToken();
  const second = takeTurnstileToken();
  await vi.waitFor(() => expect(options).toHaveLength(1));
  options[0].callback('token-1');
  await vi.waitFor(() => expect(resets).toBe(1));
  options[0].callback('token-2');
  await expect(first).resolves.toBe('token-1');
  await expect(second).resolves.toBe('token-2');
  expect(options).toHaveLength(1);
});

it('does not solve again when a token expires, only at the next check', async () => {
  const { takeTurnstileToken } = await import('./turnstile');
  const first = takeTurnstileToken();
  await vi.waitFor(() => expect(options).toHaveLength(1));
  options[0].callback('token-1');
  await expect(first).resolves.toBe('token-1');
  expire(options[0]);
  expect(resets).toBe(0);
  const next = takeTurnstileToken();
  await vi.waitFor(() => expect(resets).toBe(1));
  options[0].callback('token-2');
  await expect(next).resolves.toBe('token-2');
});

it('gives up after 15 s with an empty token', async () => {
  const { TAKE_TIMEOUT_MS, takeTurnstileToken } = await import('./turnstile');
  const check = takeTurnstileToken();
  await vi.waitFor(() => expect(options).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(TAKE_TIMEOUT_MS);
  await expect(check).resolves.toBe('');
});
