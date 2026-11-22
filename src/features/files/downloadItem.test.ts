import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { useSourceTransfers } from '@/features/workspace/sourceTransfers';

const saved = vi.hoisted(() => [] as { blob: Blob; name: string }[]);
const exported = vi.hoisted(() => vi.fn());
vi.mock('@/features/notes/documentAdapters', () => ({
  downloadEditorFile: (blob: Blob, name: string) => saved.push({ blob, name }),
  exportNoteValue: vi.fn(),
}));
vi.mock('@/lib/sourceCache', () => ({
  cacheSource: async () => {},
  readCachedSource: async () => null,
}));
vi.mock('./sourceProvider', () => ({ warmSourceSocket: vi.fn() }));
vi.mock('@/office-runtime/exportCheckpoint', () => ({
  exportCheckpoint: exported,
}));

const { api } = await import('@/api/client');
const { downloadFile } = await import('./downloadItem');
const { prefetchSourceOpen, takeSourceOpen } = await import('./sourceOpen');

const base = new TextEncoder().encode('published');
const get = vi.spyOn(api, 'get');
/** The source session the server answers from now on. */
const session = (fields: object) =>
  get.mockResolvedValue({
    baseSourceSHA256: 'b'.repeat(64),
    checkpoint: 0,
    indexedCheckpoint: 0,
    sourceURL: 'https://bucket.test/base',
    state: null,
    ...fields,
  });
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(base))
  );
});
afterEach(() => {
  saved.length = 0;
  exported.mockReset();
  vi.unstubAllGlobals();
});

describe('Download', () => {
  it('merges saved edits while a publication waits to become the base', async () => {
    // Checkpoints equal (just published) yet the session carries the edits,
    // all stored against the base it still opens on.
    session({
      checkpoint: 3,
      indexedCheckpoint: 3,
      state: toBase64(new Uint8Array([1, 2, 3])),
      stateSeedSHA256: 'seed',
    });
    exported.mockResolvedValue(new TextEncoder().encode('latest'));
    await downloadFile(
      { id: 'f_4', kind: 'doc', name: 'plan.docx', workspaceId: 'ws_1' },
      new QueryClient()
    );
    expect(await saved[0]?.blob.text()).toBe('latest');
  });

  it('saves the published file when nothing saved is past it', async () => {
    session({});
    await downloadFile(
      { id: 'f_1', kind: 'doc', name: 'plan.docx', workspaceId: 'ws_1' },
      new QueryClient()
    );
    expect(saved[0]?.name).toBe('plan.docx');
    expect(await saved[0]?.blob.text()).toBe('published');
    expect(useSourceTransfers.getState().transfers).toEqual([]);
  });

  it("saves a text file's saved edits as its text", async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'edited text');
    session({
      checkpoint: 2,
      indexedCheckpoint: 1,
      state: toBase64(Y.encodeStateAsUpdate(doc)),
    });
    await downloadFile(
      { id: 'f_2', kind: 'md', name: 'notes.md', workspaceId: 'ws_1' },
      new QueryClient()
    );
    expect(await saved[0]?.blob.text()).toBe('edited text');
  });

  it("merges an Office file's saved edits over its base in the browser", async () => {
    session({
      checkpoint: 2,
      indexedCheckpoint: 1,
      state: toBase64(new Uint8Array([1, 2, 3])),
      stateSeedSHA256: 'seed',
    });
    exported.mockResolvedValue(new TextEncoder().encode('merged'));
    await downloadFile(
      { id: 'f_3', kind: 'doc', name: 'plan.docx', workspaceId: '' },
      new QueryClient()
    );
    expect(exported).toHaveBeenCalledWith(
      'docx',
      expect.any(ArrayBuffer),
      expect.any(ArrayBuffer),
      'seed'
    );
    expect(await saved[0]?.blob.text()).toBe('merged');
  });

  // Q818 A: Download reads the session itself, never the one the route read
  // at open, so an edit saved since (within the open's 30 s) is in the file.
  it('saves an edit typed and checkpointed since the file opened', async () => {
    session({});
    vi.spyOn(api, 'post').mockResolvedValue({
      epoch: 1,
      room: 'source:f_5:epoch:1',
      token: 't',
      url: 'wss://c',
    });
    prefetchSourceOpen('f_5', true);
    await takeSourceOpen('f_5', 'edit');
    session({
      checkpoint: 1,
      indexedCheckpoint: 0,
      state: toBase64(new Uint8Array([4, 5])),
      stateSeedSHA256: 'seed',
    });
    exported.mockResolvedValue(new TextEncoder().encode('typed'));
    await downloadFile(
      { id: 'f_5', kind: 'doc', name: 'plan.docx', workspaceId: 'ws_1' },
      new QueryClient()
    );
    expect(await saved[0]?.blob.text()).toBe('typed');
  });

  it("reads afresh while the route's open still waits for its view", async () => {
    session({});
    prefetchSourceOpen('f_6', false);
    session({
      checkpoint: 1,
      indexedCheckpoint: 0,
      state: toBase64(new Uint8Array([4, 5])),
      stateSeedSHA256: 'seed',
    });
    exported.mockResolvedValue(new TextEncoder().encode('saved since'));
    await downloadFile(
      { id: 'f_6', kind: 'doc', name: 'plan.docx', workspaceId: 'ws_1' },
      new QueryClient()
    );
    expect(await saved[0]?.blob.text()).toBe('saved since');
  });
});
