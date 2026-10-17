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

/** The route loads `fileId` (URL `mode`, a navigation unless `preload`). */
function load(
  fileId: string,
  { mode, preload = false }: { mode?: string; preload?: boolean } = {}
) {
  const abortController = new AbortController();
  prefetchOfficeFile(new QueryClient(), fileId, {
    abortController,
    location: { search: mode ? { mode } : {} },
    preload,
  });
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
  it("starts the open in the URL's mode once the rows arrive", async () => {
    rows.set('file:f_deck', async () => DECK);
    load('f_deck', { mode: 'edit' });
    await vi.waitFor(() =>
      expect(prefetchSourceOpen).toHaveBeenCalledWith('f_deck', 'edit')
    );
  });

  it('starts no open once the route was left before the file row arrived', async () => {
    const file = deferred<unknown>();
    rows.set('file:f_left', () => file.promise);
    const route = load('f_left', { mode: 'edit' });
    route.abort();
    file.resolve(DECK);
    await settle();
    expect(prefetchSourceOpen).not.toHaveBeenCalled();
  });
});
