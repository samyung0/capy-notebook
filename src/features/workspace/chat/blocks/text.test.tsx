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

const chunk = vi.hoisted(() => ({ loads: 0, toast: vi.fn() }));
vi.mock('@/api/queryClient', () => ({ showErrorToast: chunk.toast }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const TEXT = '**Light** drives it.';
const found = (selector: string) => document.querySelector(selector);

/** A fresh page: each load of the chunk waits for, or fails with, `gate`. */
async function page(gate: () => Promise<unknown>) {
  vi.resetModules();
  chunk.loads = 0;
  vi.doMock('./proseBody', async () => {
    chunk.loads += 1;
    await gate();
    return {
      ProseBody: ({ text }: { text: string }) => <b data-drawn>{text}</b>,
    };
  });
  return await import('./text');
}

async function draw(Prose: Awaited<ReturnType<typeof page>>['Prose']) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => {
    root.render(<Prose text={TEXT} />);
    await new Promise((settled) => setTimeout(settled));
  });
  return root;
}

const settled = (ms = 0) =>
  act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });

const fails = () => Promise.reject(new Error('import failed'));

/** The `online` listener a test's page registers, to fire by hand. */
function offline() {
  const online = vi.fn();
  vi.stubGlobal('navigator', { onLine: false });
  vi.stubGlobal('addEventListener', online);
  return online;
}

beforeEach(() => chunk.toast.mockClear());
afterEach(() => vi.unstubAllGlobals());

it('holds the words unseen until its code lands, then draws the Markdown', async () => {
  let release = () => {};
  const { Prose } = await page(
    () =>
      new Promise<void>((done) => {
        release = done;
      })
  );
  const root = await draw(Prose);
  const held = found('[data-prose="loading"]');
  expect(held?.textContent).toBe(TEXT);
  expect(held?.getAttribute('aria-busy')).toBe('true');
  expect(found('[data-drawn]')).toBeNull();
  release();
  await settled();
  await settled();
  expect(found('[data-prose]')).toBeNull();
  expect(found('[data-drawn]')?.textContent).toBe(TEXT);
  act(() => root.unmount());
}, 60_000);

it('shows the words, marked busy, past 2 s of waiting, and formats when the code lands', async () => {
  let release = () => {};
  const { Prose } = await page(
    () =>
      new Promise<void>((done) => {
        release = done;
      })
  );
  const root = await draw(Prose);
  expect(found('[data-prose="loading"]')).not.toBeNull();
  await settled(2100);
  const shown = found('[data-prose="slow"]');
  expect(shown?.textContent).toBe(TEXT);
  expect(shown?.getAttribute('aria-busy')).toBe('true');
  release();
  await settled();
  await settled();
  expect(found('[data-prose]')).toBeNull();
  expect(found('[data-drawn]')?.textContent).toBe(TEXT);
  act(() => root.unmount());
}, 60_000);

it('shows the words as they are when its code fails online, with one update toast', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const { Prose } = await page(fails);
  const root = await draw(Prose);
  await settled();
  const shown = found('[data-prose="failed"]');
  expect(shown?.textContent).toBe(TEXT);
  expect(shown?.getAttribute('aria-busy')).toBeNull();
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  // Another answer drawing asks nothing more of it.
  const loads = chunk.loads;
  await act(async () => {
    root.render(
      <>
        <Prose text={TEXT} />
        <Prose text="Another answer." />
      </>
    );
    await new Promise((done) => setTimeout(done));
  });
  expect(chunk.loads).toBe(loads);
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
}, 60_000);

it('stays quiet offline, and formats when the code loads back online', async () => {
  const online = offline();
  let gate: () => Promise<unknown> = fails;
  const { Prose } = await page(() => gate());
  const root = await draw(Prose);
  await settled();
  expect(found('[data-prose="failed"]')?.textContent).toBe(TEXT);
  expect(chunk.toast).not.toHaveBeenCalled();
  expect(online).toHaveBeenCalledWith('online', expect.any(Function), {
    once: true,
  });
  gate = () => Promise.resolve();
  vi.stubGlobal('navigator', { onLine: true });
  await act(async () => {
    online.mock.calls[0][1]();
    await new Promise((done) => setTimeout(done));
  });
  await settled();
  expect(found('[data-prose]')).toBeNull();
  expect(found('[data-drawn]')?.textContent).toBe(TEXT);
  expect(chunk.toast).not.toHaveBeenCalled();
  act(() => root.unmount());
}, 60_000);

it('says so once back online when the browser keeps the failed import', async () => {
  const online = offline();
  const { Prose } = await page(fails);
  const root = await draw(Prose);
  await settled();
  expect(chunk.toast).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { onLine: true });
  await act(async () => {
    online.mock.calls[0][1]();
    await new Promise((done) => setTimeout(done));
  });
  await settled();
  expect(found('[data-prose="failed"]')?.textContent).toBe(TEXT);
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
}, 60_000);

it('a preload offline asks for nothing, and an answer online still formats', async () => {
  offline();
  const { preloadProse, Prose } = await page(() => Promise.resolve());
  preloadProse();
  await settled();
  expect(chunk.loads).toBe(0);
  vi.stubGlobal('navigator', { onLine: true });
  const root = await draw(Prose);
  await settled();
  await settled();
  expect(found('[data-drawn]')?.textContent).toBe(TEXT);
  expect(chunk.toast).not.toHaveBeenCalled();
  act(() => root.unmount());
}, 60_000);

it('a preload that fails says nothing; the answer that needs it does', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const { preloadProse, Prose } = await page(fails);
  preloadProse();
  await settled();
  expect(chunk.loads).toBe(1);
  expect(chunk.toast).not.toHaveBeenCalled();
  const root = await draw(Prose);
  await settled();
  expect(found('[data-prose="failed"]')?.textContent).toBe(TEXT);
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
}, 60_000);

/** The page's idle callback, run by hand. */
function idle() {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  return () => {
    for (const callback of callbacks.splice(0)) callback();
  };
}

it('loads once the page is idle after a workspace opens (Q681)', async () => {
  vi.stubGlobal('navigator', { onLine: true });
  const runIdle = idle();
  const { preloadProseWhenIdle } = await page(() => Promise.resolve());
  preloadProseWhenIdle();
  await settled();
  expect(chunk.loads).toBe(0);
  runIdle();
  await settled();
  expect(chunk.loads).toBe(1);
}, 60_000);

it('offline at idle asks for nothing, and loads once back online', async () => {
  const online = offline();
  const runIdle = idle();
  const { preloadProseWhenIdle } = await page(() => Promise.resolve());
  preloadProseWhenIdle();
  runIdle();
  await settled();
  expect(chunk.loads).toBe(0);
  expect(online).toHaveBeenCalledWith('online', expect.any(Function), {
    once: true,
  });
  vi.stubGlobal('navigator', { onLine: true });
  online.mock.calls[0][1]();
  await settled();
  expect(chunk.loads).toBe(1);
  expect(chunk.toast).not.toHaveBeenCalled();
}, 60_000);
