import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { useSourceTransfers } from '@/features/workspace/sourceTransfers';

const saved = vi.hoisted(() => [] as { blob: Blob; name: string }[]);
const open = vi.hoisted(() => ({ value: null as unknown }));
const exported = vi.hoisted(() => vi.fn());
vi.mock('@/features/notes/documentAdapters', () => ({
  downloadEditorFile: (blob: Blob, name: string) => saved.push({ blob, name }),
  exportNoteValue: vi.fn(),
}));
vi.mock('./sourceOpen', () => ({ takeSourceOpen: () => open.value }));
vi.mock('@/office-runtime/exportCheckpoint', () => ({
  exportCheckpoint: exported,
}));

const { downloadFile } = await import('./downloadItem');

const base = new TextEncoder().encode('published');
const session = (fields: object) =>
  Promise.resolve({
    base: Promise.resolve(base),
    session: { checkpoint: 0, indexedCheckpoint: 0, state: null, ...fields },
  });
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

afterEach(() => {
  saved.length = 0;
  exported.mockReset();
});

describe('Download', () => {
  it('merges saved edits while a publication waits to become the base', async () => {
    // Checkpoints equal (just published) yet the session carries the edits,
    // all stored against the base it still opens on.
    open.value = session({
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
    open.value = session({});
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
    open.value = session({
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
    open.value = session({
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
});
