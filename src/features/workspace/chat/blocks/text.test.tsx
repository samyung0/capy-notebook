import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

// The locale resolves before a window exists, then linkedom's document goes in
// before react-dom/client loads (see ChatPanel.test.tsx).
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const chunk = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/api/queryClient', () => ({ showErrorToast: chunk.toast }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const TEXT = '**Light** drives it.';
const found = (selector: string) => document.querySelector(selector);

/** A fresh page: the chunk's load waits for, or fails with, `gate`. */
async function draw(gate: () => Promise<unknown>) {
  vi.resetModules();
  vi.doMock('./proseBody', async () => {
    await gate();
    return {
      ProseBody: ({ text }: { text: string }) => <b data-drawn>{text}</b>,
    };
  });
  const { Prose } = await import('./text');
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => {
    root.render(<Prose text={TEXT} />);
    await new Promise((settled) => setTimeout(settled));
  });
  return root;
}

const settled = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done));
  });

beforeEach(() => chunk.toast.mockClear());
afterEach(() => vi.unstubAllGlobals());

it('holds the words unseen until its code lands, then draws the Markdown', async () => {
  let release = () => {};
  const root = await draw(
    () =>
      new Promise<void>((done) => {
        release = done;
      })
  );
  expect(found('[data-prose="loading"]')?.textContent).toBe(TEXT);
  expect(found('[data-drawn]')).toBeNull();
  release();
  await settled();
  await settled();
  expect(found('[data-prose]')).toBeNull();
  expect(found('[data-drawn]')?.textContent).toBe(TEXT);
  act(() => root.unmount());
}, 60_000);

it('shows the words as they are when its code fails online, with the update toast', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const root = await draw(() => Promise.reject(new Error('import failed')));
  await settled();
  expect(found('[data-prose="failed"]')?.textContent).toBe(TEXT);
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
}, 60_000);

it('stays quiet offline and tries again once back online', async () => {
  const online = vi.fn();
  vi.stubGlobal('navigator', { onLine: false });
  vi.stubGlobal('addEventListener', online);
  const root = await draw(() => Promise.reject(new Error('import failed')));
  await settled();
  expect(found('[data-prose="failed"]')?.textContent).toBe(TEXT);
  expect(chunk.toast).not.toHaveBeenCalled();
  expect(online).toHaveBeenCalledWith('online', expect.any(Function), {
    once: true,
  });
  act(() => root.unmount());
}, 60_000);
