import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RoomProviderConfig } from './roomProvider';

// linkedom's document goes in before react-dom/client loads.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, {
  document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The messages' runtime keeps the locale there.
  localStorage: { getItem: () => null, setItem: () => undefined },
  Node: window.Node,
  window,
});

// A real room's provider and token, recorded instead of real (itemRoom.test).
const providers: { config: RoomProviderConfig }[] = [];
vi.mock('./roomProvider', () => ({
  RoomProvider: class {
    constructor(config: RoomProviderConfig) {
      providers.push({ config });
    }
    connect() {}
    disconnect() {}
    destroy() {}
    sendStateless() {}
  },
}));
// The next token requests' refusals; a reader's token otherwise.
const refusals: Error[] = [];
vi.mock('@/api/hooks', () => ({
  getMaterialCollaborationToken: vi.fn(async () => {
    const refusal = refusals.shift();
    if (refusal) throw refusal;
    return { access: 'read', room: 'material:q:schema:1', token: 't', url: '' };
  }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { ApiError, qk } = await import('@/api/client');
const { queryClient } = await import('@/api/queryClient');
const { dismissToast, finishToast, shownToasts, userToast } = await import(
  '@/components/ui/userToast'
);
const { m } = await import('@/i18n');
const { toastAccessLost, useAccessLostNotice } = await import(
  './accessLostNotice'
);
const { ItemRoom } = await import('./itemRoom');
const { markItemWorking } = await import('./roomRefusals');

beforeEach(() => {
  queryClient.clear();
  providers.length = 0;
  refusals.length = 0;
  dismissToast();
  for (const toast of Object.values(shownToasts()))
    if (toast) finishToast(toast.id);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A page showing material `id` in workspace `ws`, its read under `read`,
 * rendered with whether that read refused access. */
function page(id: string, read: readonly unknown[] = qk.material(id)) {
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const root = createRoot(document.getElementById('root') as never);
  function Page({ refused }: { refused: boolean }) {
    useAccessLostNotice(false, id, {
      read,
      refused,
      workspaceId: 'ws',
    });
    return null;
  }
  return {
    invalidate,
    render: (refused: boolean) =>
      act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <Page refused={refused} />
          </QueryClientProvider>
        )
      ),
    unmount: () => act(async () => root.unmount()),
  };
}

/** The item's read answering a fetch (`body`, the item live by default). */
const fetched = (
  id: string,
  body: object = { id },
  queryKey: readonly unknown[] = qk.material(id)
) => queryClient.fetchQuery({ queryFn: async () => body, queryKey });

/** The clock `ms` on, timers left alone. */
function later(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

const lost = () => shownToasts().error;

/** Dismisses the shown toast, its exit over. */
function dismissShown() {
  const shown = lost();
  if (!shown) throw new Error('no toast');
  dismissToast(shown.id);
  finishToast(shown.id);
}

// Review 2026-11-20 (1): a list dropping the item (its tree event) can refuse
// the page's read before the room's drain or 4403 arrives. The item worked
// here (its read answered a fetch on this page), so that order toasts, once:
// the toast took the mark, so a refusal after it, the toast gone, adds none.
it('toasts once for a read refused after a fetch answered on the page', async () => {
  const shown = page('read-first');
  await shown.render(false);
  await fetched('read-first');
  await shown.render(true);
  expect(lost()).toMatchObject({
    count: 1,
    id: 'access-lost',
    title: m.editor_access_lost(),
  });
  expect(shown.invalidate).toHaveBeenCalledWith({
    queryKey: qk.materials('ws'),
  });
  dismissShown();
  await shown.render(false);
  await shown.render(true);
  expect(lost()).toBeNull();
  await shown.unmount();
});

// Review 2026-11-20 (5): a hover's preload or a route's loader answers the
// read just before the page opens on it, so the page fetches nothing itself.
it('counts a fetch answered just before the page opened, still fresh', async () => {
  await fetched('preloaded');
  const shown = page('preloaded');
  await shown.render(false);
  await shown.render(true);
  expect(lost()).toMatchObject({ count: 1, id: 'access-lost' });
  await shown.unmount();
});

// Review 2026-11-20 (2, 4): opened unavailable, a copy painted before the
// read refused says only that it is unavailable: a cache write
// (`setQueryData`, as `patchFileInCache` makes during a mount's refetch), an
// answer marked stale since, or nothing at all. A room of the item that
// synced before this page showed it (an embed's) marked nothing.
it('stays silent for an item opened unavailable', async () => {
  markItemWorking(false, 'never');
  queryClient.setQueryData(qk.material('written'), { id: 'written' });
  await fetched('invalidated');
  await queryClient.invalidateQueries({
    queryKey: qk.material('invalidated'),
    refetchType: 'none',
  });
  for (const id of ['never', 'written', 'invalidated']) {
    const shown = page(id);
    await shown.render(false);
    queryClient.setQueryData(qk.material(id), { id });
    await shown.render(true);
    await shown.unmount();
  }
  expect(lost()).toBeNull();
});

// Review 2026-11-20, round 3 (1): an answer from an earlier visit is no sign
// of this one, however long its stale time: the quiz dialog's gate reads the
// quiz again as it closes (5 minutes fresh by default), and reopened a minute
// later on a quiz whose access went, it says only that it is unavailable.
it('stays silent for an answer from an earlier visit, fresh as its stale time keeps it', async () => {
  await fetched('earlier', { id: 'earlier' }, qk.quiz('earlier'));
  later(60_000);
  const shown = page('earlier', qk.quiz('earlier'));
  await shown.render(false);
  await shown.render(true);
  expect(lost()).toBeNull();
  await shown.unmount();
});

// Review 2026-11-20, round 3 (2): a trashed answer (the payer's read of an
// item another member trashed) is no sign it worked: purged, its read refused
// after it adds no toast.
it('marks nothing for an answer showing the item trashed', async () => {
  const shown = page('trashed');
  await shown.render(false);
  await fetched('trashed', { id: 'trashed', trash: { episodeId: 'ep' } });
  await shown.render(true);
  expect(lost()).toBeNull();
  await shown.unmount();
});

// Review 2026-11-20 (2, 5): a room that synced marks the item for as long as
// the page shows it, so a room replaced since (a tab hidden for 5 minutes, a
// moved room) that is refused before it syncs, then the read refused, still
// says it, once. Fails if a room's sync stops marking (`ItemRoom.onSynced`).
it('toasts for an item whose room synced, past a room replaced since and refused before it synced', async () => {
  const shown = page('q');
  await shown.render(false);
  const first = new ItemRoom('q', { read: true });
  await first.start();
  providers[0].config.onSynced?.({ state: true });
  first.destroy();
  refusals.push(new ApiError(404, 'Not Found'));
  const second = new ItemRoom('q', { read: true });
  await second.start();
  expect(second.getSnapshot()).toMatchObject({
    status: 'unavailable',
    synced: false,
  });
  await shown.render(true);
  expect(lost()).toMatchObject({ count: 1, id: 'access-lost' });
  second.destroy();
  await shown.unmount();
});

// Review 2026-11-20 (3): an access-lost toast waiting behind another error is
// not fired again, which would count it up (×2) once it shows.
it('leaves an access-lost toast waiting its turn as it is', () => {
  userToast({ title: 'Could not save', variant: 'error' });
  toastAccessLost();
  toastAccessLost();
  dismissShown();
  expect(lost()).toMatchObject({ count: 1, id: 'access-lost' });
});
