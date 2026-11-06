import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';

// linkedom's document goes in before react-dom/client loads (see
// ChatPanel.test.tsx).
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const chunk = vi.hoisted(() => ({
  dismiss: vi.fn(),
  loading: vi.fn(() => 'waiting'),
  loads: 0,
  toast: vi.fn(),
}));
vi.mock('@/api/queryClient', () => ({ showErrorToast: chunk.toast }));
vi.mock('@/i18n', () => ({ m: { common_loading: () => 'Loading' } }));
vi.mock('@/components/ui/userToast', () => ({
  dismissToast: chunk.dismiss,
  userToast: chunk.loading,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

/** A fresh page: the mock's factory is the chunk's load, waiting for `gate`. */
async function fresh(gate: () => Promise<unknown> = () => Promise.resolve()) {
  vi.resetModules();
  chunk.loads = 0;
  chunk.dismiss.mockClear();
  chunk.loading.mockClear();
  chunk.toast.mockClear();
  vi.doMock('./AddSourceDialog', async () => {
    chunk.loads += 1;
    await gate();
    return { AddSourceDialog: () => <div data-add-source /> };
  });
  return await import('./LazyAddSourceDialog');
}

const settle = () =>
  act(async () => {
    await new Promise((settled) => setTimeout(settled));
  });
const shown = () => document.querySelector('[data-add-source]');
const hung = () => new Promise(() => undefined);
/** A load that goes on when the test says, whenever it began. */
function deferred() {
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  return { gate: () => held, release };
}

const opened = async (
  module: Awaited<ReturnType<typeof fresh>>,
  onClose: () => void
) => {
  const { AddSourceDialog } = module;
  const root = createRoot(document.getElementById('root') as never);
  act(() =>
    root.render(<AddSourceDialog onClose={onClose} open workspaceId="ws_1" />)
  );
  return root;
};

/** What `connectResume` keeps in session storage across the provider's redirect. */
function seedResume() {
  const stored = new Map([
    [
      'capy:connect-resume',
      JSON.stringify({ provider: 'google', workspaceId: 'ws_1' }),
    ],
  ]);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => stored.delete(key),
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  return stored;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('loads on intent, ahead of the open, and opens at once with nothing else to wait for', async () => {
  const module = await fresh();
  expect(chunk.loads).toBe(0);
  module.addSourceIntent.onPointerEnter();
  await settle();
  expect(chunk.loads).toBe(1);
  const root = await opened(module, () => {});
  expect(shown()).not.toBeNull();
  expect(chunk.loading).not.toHaveBeenCalled();
  expect(chunk.toast).not.toHaveBeenCalled();
  act(() => root.unmount());
}, 60_000);

it('asks for nothing on intent while offline, or from a failed preload says nothing', async () => {
  const module = await fresh(() => Promise.reject(new Error('import failed')));
  vi.stubGlobal('navigator', { onLine: false });
  module.addSourceIntent.onFocus();
  await settle();
  expect(chunk.loads).toBe(0);
  vi.stubGlobal('navigator', { onLine: true });
  module.addSourceIntent.onFocus();
  await settle();
  expect(chunk.loads).toBe(1);
  expect(chunk.toast).not.toHaveBeenCalled();
}, 60_000);

it('says so in a toast and closes when its code fails to load, ending a resume', async () => {
  const stored = seedResume();
  const module = await fresh(() =>
    Promise.reject(new Error('Failed to fetch dynamically imported module'))
  );
  const onClose = vi.fn();
  const root = await opened(module, onClose);
  await settle();
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(shown()).toBeNull();
  // Re-entering the page doesn't try Import again.
  expect(stored.size).toBe(0);
  act(() => root.unmount());
}, 60_000);

it('shows it is loading from 300 ms, and gives up on a stalled import at 20 s', async () => {
  const stored = seedResume();
  const module = await fresh(hung);
  vi.useFakeTimers();
  const onClose = vi.fn();
  const root = await opened(module, onClose);
  act(() => vi.advanceTimersByTime(299));
  expect(chunk.loading).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(chunk.loading).toHaveBeenCalledWith(
    expect.objectContaining({ variant: 'loading' })
  );
  act(() => vi.advanceTimersByTime(19_699));
  expect(chunk.toast).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  expect(chunk.dismiss).toHaveBeenCalledWith('waiting');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(stored.size).toBe(0);
  act(() => root.unmount());
}, 60_000);

it.each([
  ['press', () => new window.Event('pointerdown')],
  ['key', () => new window.Event('keydown')],
])(
  'a %s once it says it is loading means the user moved on: nothing arrives',
  async (_, event) => {
    const stored = seedResume();
    const { gate, release } = deferred();
    const module = await fresh(gate);
    vi.useFakeTimers();
    const onClose = vi.fn();
    const root = await opened(module, onClose);
    act(() => vi.advanceTimersByTime(300));
    act(() => {
      document.dispatchEvent(event());
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(chunk.dismiss).toHaveBeenCalledWith('waiting');
    expect(chunk.toast).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
    vi.useRealTimers();
    release();
    await settle();
    expect(shown()).toBeNull();
    act(() => root.unmount());
  },
  60_000
);

it('a press within the 300 ms is the click itself: a double click still opens', async () => {
  const { gate, release } = deferred();
  const module = await fresh(gate);
  const onClose = vi.fn();
  const root = await opened(module, onClose);
  act(() => {
    document.dispatchEvent(new window.Event('pointerdown'));
  });
  expect(onClose).not.toHaveBeenCalled();
  release();
  await settle();
  await settle();
  expect(shown()).not.toBeNull();
  act(() => root.unmount());
}, 60_000);

it('a page that goes away while it loads ends the wait', async () => {
  const module = await fresh(hung);
  vi.useFakeTimers();
  const onClose = vi.fn();
  const root = await opened(module, onClose);
  act(() => vi.advanceTimersByTime(300));
  act(() => root.unmount());
  expect(chunk.dismiss).toHaveBeenCalledWith('waiting');
  act(() => vi.advanceTimersByTime(30_000));
  expect(chunk.toast).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
}, 60_000);
