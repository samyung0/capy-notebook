import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
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

/** A fresh page: the mock's factory is the chunk's load. */
async function fresh(fail?: Error) {
  vi.resetModules();
  chunk.loads = 0;
  chunk.toast.mockClear();
  vi.doMock('./AddSourceDialog', () => {
    chunk.loads += 1;
    if (fail) throw fail;
    return { AddSourceDialog: () => <div data-add-source /> };
  });
  return await import('./LazyAddSourceDialog');
}

const settle = () =>
  act(async () => {
    await new Promise((settled) => setTimeout(settled));
  });

it('loads on intent, ahead of the open, and opens once loaded', async () => {
  const { AddSourceDialog, addSourceIntent } = await fresh();
  expect(chunk.loads).toBe(0);
  addSourceIntent.onPointerEnter();
  await settle();
  expect(chunk.loads).toBe(1);
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => {
    root.render(<AddSourceDialog onClose={() => {}} open workspaceId="ws_1" />);
    await new Promise((settled) => setTimeout(settled));
  });
  expect(document.querySelector('[data-add-source]')).not.toBeNull();
  expect(chunk.toast).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it('says so in a toast and closes when its code fails to load', async () => {
  const { AddSourceDialog } = await fresh(
    new Error('Failed to fetch dynamically imported module')
  );
  const onClose = vi.fn();
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => {
    root.render(<AddSourceDialog onClose={onClose} open workspaceId="ws_1" />);
    await new Promise((settled) => setTimeout(settled));
  });
  await settle();
  expect(chunk.toast).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-add-source]')).toBeNull();
  act(() => root.unmount());
});
