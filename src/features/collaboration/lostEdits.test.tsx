import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// linkedom's document goes in before react-dom/client loads.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
const reload = vi.fn();
Object.defineProperty(window, 'location', { value: { reload } });
Object.assign(globalThis, {
  document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The messages' runtime keeps the locale there.
  localStorage: { getItem: () => null, setItem: () => undefined },
  Node: window.Node,
  window,
});

// The stored rows by document; what was held, deleted and dismissed.
const store = vi.hoisted(() => ({
  deletedShown: [] as { key: string; shown: unknown }[],
  dismissed: [] as string[],
  failing: false,
  held: [] as string[],
  picked: [] as { key: string; rows: unknown[] }[],
  released: [] as string[],
  rows: new Map<string, unknown[]>(),
}));
vi.mock('@/lib/editDrafts', async (load) => ({
  deleteShownDrafts: vi.fn(async (key: string, shown: unknown) => {
    store.deletedShown.push({ key, shown });
    return 5;
  }),
  // Bytes per document: 3 when its rows go, null when an editor holds it.
  deleteUnheldDrafts: vi.fn(
    async (key: string, pick: (row: { id: string }) => boolean) => {
      store.picked.push({
        key,
        rows: (store.rows.get(key) ?? []).filter((row) =>
          pick(row as { id: string })
        ),
      });
      return key.endsWith(':keys') ? null : 3;
    }
  ),
  draftDocumentHeld: () => false,
  draftKey: (actor: string, kind: string, id: string) =>
    `${actor}:${kind}:${id}`,
  holdDraftDocument: (key: string) => {
    store.held.push(key);
    return () => store.released.push(key);
  },
  readDrafts: async (key: string) => {
    if (store.failing) throw new Error('storage gone');
    return store.rows.get(key) ?? [];
  },
  shownRows: (await load<typeof import('@/lib/editDrafts')>()).shownRows,
}));
vi.mock('@/components/ui/userToast', () => ({
  dismissToast: (id: string) => store.dismissed.push(id),
  userToast: vi.fn(),
}));
const report = vi.hoisted(() => vi.fn());
vi.mock('@/lib/editIncidents', () => ({
  editIncidentReporter: () => report,
}));
// A note's drawing: its first row, shown.
const NOTE = [{ children: [{ text: 'Kept to copy.' }], type: 'p' }];
// Whether the offered drafts make a file; the files saved.
const drawable = vi.hoisted(() => ({ value: true }));
const saveShownEdits = vi.hoisted(() => vi.fn());
vi.mock('./deletedEditsFile', () => ({
  canSaveDeletedEdits: async () => drawable.value,
  saveShownEdits,
}));
vi.mock('./deletedNote', () => ({
  deletedNote: (rows: unknown[]) =>
    rows.length ? { shown: { rows: [rows[0]] }, value: NOTE } : null,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { deletedTarget, reloadDeleted, useDeletedEdits, useShowsDeleted } =
  await import('./lostEdits');
const { discardDeletedEdits, downloadShownEdits, offerDeletedEdits } =
  await import('./deletedEditsToast');
const { deleteUnheldDrafts } = await import('@/lib/editDrafts');
const { userToast } = await import('@/components/ui/userToast');
const { m } = await import('@/i18n');

beforeEach(() => {
  store.deletedShown = [];
  store.dismissed = [];
  store.failing = false;
  store.picked = [];
  store.held = [];
  store.released = [];
  store.rows.clear();
  reload.mockClear();
  report.mockClear();
});
afterEach(() => vi.clearAllMocks());

type State = ReturnType<typeof useDeletedEdits>;

/** The hook on a page showing `id`, deleted; resolves its settled state,
 * whether it shows edits to download, and the page's unmount. */
async function shown(id: string, kind: 'note' | 'quiz') {
  const target = deletedTarget('u', false, id, kind === 'quiz');
  const states: State[] = [];
  let shows = false;
  function Page() {
    states.push(useDeletedEdits(target, true, kind === 'note'));
    shows = useShowsDeleted(target);
    return null;
  }
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<Page />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root, shows, state: states.at(-1), target };
}

// Q39: a page showing a deleted quiz holds both its documents, the edits'
// one owner, and an offer of them already on screen goes; it keeps the quiz
// on screen while edits are stored, and lets go when the page goes. Until its
// room draws them, it has nothing to download (review 2026-11-20).
it("holds a deleted item's documents while it shows its stored edits", async () => {
  store.rows.set('u:material:q:keys', [{ id: 'k' }]);
  const { root, shows, state } = await shown('q', 'quiz');
  expect(state).toEqual({ status: 'kept' });
  expect(shows).toBe(false);
  expect(store.held).toEqual(['u:material:q', 'u:material:q:keys']);
  expect(store.dismissed).toEqual(['deleted-edits-material-q']);
  await act(async () => root.unmount());
  expect(store.released).toEqual(['u:material:q', 'u:material:q:keys']);
});

// Review 2026-11-20: a deleted note's stored edits are drawn here, as its
// Download draws them, and its Reload deletes only the rows drawn, counted
// as the person's discard apart from a lost item's drop.
it('draws a deleted note, and its Reload deletes only what it shows', async () => {
  const row = { id: 's:state' };
  store.rows.set('u:material:n', [row, { id: 'piece' }]);
  const { root, shows, state, target } = await shown('n', 'note');
  expect(state).toEqual({ note: NOTE, status: 'kept' });
  expect(shows).toBe(true);
  reloadDeleted(target!);
  await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  expect(store.deletedShown).toEqual([
    { key: 'u:material:n', shown: { rows: [row] } },
  ]);
  expect(report).toHaveBeenCalledWith('discard_unsaved', 'item_deleted', 5);
  expect(deleteUnheldDrafts).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

// Review 2026-11-20: a store that cannot be read shows the item unavailable
// and deletes nothing; the next page load's toast offers the edits.
it('shows a deleted item unavailable when its store cannot be read', async () => {
  store.failing = true;
  const { root, state } = await shown('n', 'note');
  expect(state).toEqual({ status: 'none' });
  expect(deleteUnheldDrafts).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

// Review 2026-11-20 (2): the toast's Discard deletes the rows it offered
// alone (a session opened since keeps its own), nothing of a document an
// editor holds (here the keys), and counts what went.
it('discards only the rows the toast offered', async () => {
  store.rows.set('u:material:q', [{ id: 'offered' }, { id: 'since' }]);
  store.rows.set('u:material:q:keys', [{ id: 'key' }]);
  await discardDeletedEdits({
    file: false,
    id: 'q',
    item: { kind: 'quiz', name: 'Cell quiz' },
    keys: ['u:material:q', 'u:material:q:keys'],
    offered: { 'u:material:q': ['offered'], 'u:material:q:keys': ['key'] },
  });
  expect(store.picked).toEqual([
    { key: 'u:material:q', rows: [{ id: 'offered' }] },
    { key: 'u:material:q:keys', rows: [{ id: 'key' }] },
  ]);
  expect(report).toHaveBeenCalledExactlyOnceWith(
    'discard_unsaved',
    'item_deleted',
    3
  );
});

// Review 2026-11-20 (4): edits that make no file are offered with Discard
// alone, the toast saying why; others with Download beside it.
it.each([
  [true, m.lost_edits_body()],
  [false, m.lost_edits_body_undrawable()],
])(
  'offers Download only for edits that make a file (%s)',
  async (makes, description) => {
    drawable.value = makes;
    await offerDeletedEdits({
      file: false,
      id: 'n',
      item: { kind: 'note', name: 'Cell notes' },
      keys: ['u:material:n'],
      offered: { 'u:material:n': ['a'] },
    });
    const [toast] = vi.mocked(userToast).mock.calls[0];
    expect(toast).toMatchObject({
      description,
      secondary: { label: m.action_discard() },
    });
    expect(toast.button?.label).toBe(makes ? m.action_download() : undefined);
  }
);

// Epo 2026-11-20: the open page's Download (its strip, its ⋮) saves the file
// from the rows it shows, matched by id and seq as Reload matches them (a row
// rewritten since is not drawn), a note's ⋮ also as Word, and deletes
// nothing; a file that could not be made says so.
it('downloads what the open page shows and deletes nothing', async () => {
  const row = { id: 's:state', seq: 1 };
  store.rows.set('u:material:n', [row, { id: 'since', seq: 1 }]);
  const { root, target } = await shown('n', 'note');
  const item = { kind: 'note' as const, name: 'Cell notes' };
  const destroy = vi.fn();
  saveShownEdits.mockResolvedValueOnce(
    new Map([['u:material:n', { doc: { destroy } }]])
  );
  await downloadShownEdits(target!, item, 'docx');
  expect(saveShownEdits).toHaveBeenCalledWith(
    { ...target, item },
    { 'u:material:n': [row] },
    'docx'
  );
  expect(destroy).toHaveBeenCalled();
  expect(store.deletedShown).toEqual([]);
  expect(deleteUnheldDrafts).not.toHaveBeenCalled();

  store.rows.set('u:material:n', [{ id: 's:state', seq: 2 }]);
  saveShownEdits.mockRejectedValueOnce(new Error('no file'));
  vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
  await downloadShownEdits(target!, item);
  expect(saveShownEdits).toHaveBeenLastCalledWith(
    { ...target, item },
    { 'u:material:n': [] },
    undefined
  );
  expect(userToast).toHaveBeenCalledWith({
    title: m.lost_edits_download_failed(),
    variant: 'error',
  });
  expect(deleteUnheldDrafts).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
