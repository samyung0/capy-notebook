import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { qk } from '@/api/client';
import { getLocale } from '@/i18n';

vi.mock('@/api/auth', () => ({
  authHeaders: async () => ({}),
  USE_MSW: false,
}));

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
const { createRoot } = await import('react-dom/client');
const { useVisitWorkspace } = await import('./hooks');

afterEach(() => vi.unstubAllGlobals());

/** Opens workspace `id` as a member or a visitor with To do on screen, and
 * returns how often To do was read again and whether it is left stale. */
async function visit(id: string, visitor: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  );
  const qc = new QueryClient();
  let reads = 0;
  const todo = {
    queryFn: () => {
      reads += 1;
      return Promise.resolve([]);
    },
    queryKey: qk.todo,
    staleTime: Number.POSITIVE_INFINITY,
  };
  await qc.prefetchQuery(todo);
  const stop = new QueryObserver(qc, todo).subscribe(() => undefined);
  let send: ReturnType<typeof useVisitWorkspace> = () => undefined;
  function Probe() {
    send = useVisitWorkspace();
    return null;
  }
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>
    )
  );
  await act(async () => send({ id, visitor }));
  // The visit's answer, then a read it starts.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => root.unmount());
  stop();
  return {
    reads: reads - 1,
    stale: qc.getQueryState(qk.todo)?.isInvalidated,
    visited: qc.getMutationCache().getAll()[0]?.state.status,
  };
}

// Q910: a member's open moves nothing in To do, so it is not read again; a
// visitor's open can add the workspace to it.
it("marks To do stale on a member's open and reads it again on a visitor's", async () => {
  expect(await visit('ws_member', false)).toEqual({
    reads: 0,
    stale: true,
    visited: 'success',
  });
  expect(await visit('ws_visitor', true)).toMatchObject({
    reads: 1,
    visited: 'success',
  });
});
