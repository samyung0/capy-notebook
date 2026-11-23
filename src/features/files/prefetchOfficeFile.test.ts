import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prefetchSourceOpen, rows } = vi.hoisted(() => ({
  prefetchSourceOpen: vi.fn(),
  rows: new Map<string, () => Promise<unknown>>(),
}));
// Each row answers when the test says so.
vi.mock('@/api/hooks', () => ({
  fileQuery: (id: string) => ({
    queryFn: () => rows.get(`file:${id}`)!(),
    queryKey: ['file', id],
  }),
  meQuery: () => ({
    queryFn: () => rows.get('me')!(),
    queryKey: ['me'],
  }),
  workspaceQuery: (id: string) => ({
    queryFn: () => rows.get(`workspace:${id}`)!(),
    queryKey: ['workspace', id],
  }),
}));
vi.mock('./sourceOpen', () => ({ prefetchSourceOpen }));
vi.mock('./DocxView', () => ({}));
vi.mock('./PptxView', () => ({}));
vi.mock('./SheetView', () => ({}));

import { prefetchOfficeFile } from './prefetchOfficeFile';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The route loads `fileId` (a navigation unless `preload`). */
function load(fileId: string, { preload = false }: { preload?: boolean } = {}) {
  const abortController = new AbortController();
  prefetchOfficeFile(new QueryClient(), fileId, { abortController, preload });
  return abortController;
}

/** Lets the loader's awaits settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const WORKSPACE = { capabilities: { canEditContent: true } };

beforeEach(() => {
  prefetchSourceOpen.mockReset();
  rows.clear();
  rows.set('workspace:ws_1', async () => WORKSPACE);
});

const DECK = { hasBytes: true, name: 'deck.pptx', workspaceId: 'ws_1' };

describe("an Office file's open from its route", () => {
  // Q608 A: View always, Edit beside it whenever the capability allows,
  // whatever mode the view then shows (a `?mode=` link or the saved one).
  it('starts View and, for an editor, Edit once the rows arrive', async () => {
    rows.set('file:f_deck', async () => DECK);
    load('f_deck');
    await vi.waitFor(() =>
      expect(prefetchSourceOpen).toHaveBeenCalledWith('f_deck', true)
    );
    rows.set('workspace:ws_1', async () => ({
      capabilities: { canEditContent: false },
    }));
    load('f_deck');
    await vi.waitFor(() =>
      expect(prefetchSourceOpen).toHaveBeenLastCalledWith('f_deck', false)
    );
  });

  it('starts View alone for a file opened from the Trash', async () => {
    rows.set('file:f_trashed', async () => ({ ...DECK, trash: {} }));
    load('f_trashed');
    await vi.waitFor(() =>
      expect(prefetchSourceOpen).toHaveBeenCalledWith('f_trashed', false)
    );
  });

  it('opens a standalone file for editing by its owner, View alone while frozen', async () => {
    rows.set('file:f_own', async () => ({ ...DECK, workspaceId: '' }));
    rows.set('me', async () => ({ account: { state: 'active' } }));
    load('f_own');
    await vi.waitFor(() =>
      expect(prefetchSourceOpen).toHaveBeenCalledWith('f_own', true)
    );
    rows.set('me', async () => ({ account: { state: 'over_quota_frozen' } }));
    load('f_own');
    await vi.waitFor(() =>
      expect(prefetchSourceOpen).toHaveBeenLastCalledWith('f_own', false)
    );
  });

  it("starts nothing for a hover's preload, a file that is not Office or one without bytes", async () => {
    const read = vi.fn(async () => DECK);
    rows.set('file:f_hover', read);
    load('f_hover', { preload: true });
    rows.set('file:f_pdf', async () => ({ ...DECK, name: 'notes.pdf' }));
    load('f_pdf');
    rows.set('file:f_empty', async () => ({ ...DECK, hasBytes: false }));
    load('f_empty');
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(prefetchSourceOpen).not.toHaveBeenCalled();
  });

  it('starts no open once the route was left before the file row arrived', async () => {
    const file = deferred<unknown>();
    rows.set('file:f_left', () => file.promise);
    const route = load('f_left');
    route.abort();
    file.resolve(DECK);
    await settle();
    expect(prefetchSourceOpen).not.toHaveBeenCalled();
  });
});
