import type { AnyRouter } from '@tanstack/react-router';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it } from 'vitest';

const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
const { createRoot } = await import('react-dom/client');
const { FirstLoadLoader } = await import('./BootLoader');

/** The router state FirstLoadLoader reads, with its first load to resolve. */
function fakeRouter(resolved: boolean) {
  const listeners = new Set<() => void>();
  const state: { resolvedLocation?: object } = {
    resolvedLocation: resolved ? {} : undefined,
  };
  const router = {
    state,
    subscribe: (_event: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AnyRouter;
  const resolve = () => {
    state.resolvedLocation = {};
    for (const listener of listeners) listener();
  };
  return { resolve, router };
}

const loading = () => document.querySelector('[role="status"]') !== null;

// Q905: index.html's loader stays until the first page draws, with no blank
// between them.
it('shows the boot loader until the first load resolves', async () => {
  const { resolve, router } = fakeRouter(false);
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<FirstLoadLoader router={router} />));
  expect(loading()).toBe(true);
  await act(async () => resolve());
  expect(loading()).toBe(false);
  await act(async () => root.unmount());
});

it('shows nothing once the first load has resolved', async () => {
  const { router } = fakeRouter(true);
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<FirstLoadLoader router={router} />));
  expect(loading()).toBe(false);
  await act(async () => root.unmount());
});
