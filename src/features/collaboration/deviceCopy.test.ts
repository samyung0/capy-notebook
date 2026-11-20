import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { draftMaterials, materialHeldHere } from '@/lib/editDrafts';
import { dropDeviceCopies, storeDeviceCopy } from '@/lib/sourceCache';
import {
  dropDeletedCopies,
  keepDeviceCopy,
  sweepDeviceCopies,
} from './deviceCopy';

vi.mock('@/api/auth', () => ({ USE_MSW: false }));
vi.mock('@/lib/editDrafts', () => ({
  draftMaterials: vi.fn(),
  loadSweepKept: vi.fn(),
  materialHeldHere: vi.fn(() => false),
}));
vi.mock('@/lib/sourceCache', () => ({
  deviceCopyMaterials: vi.fn(async () => ['kept', 'lost']),
  dropDeviceCopies: vi.fn(async () => undefined),
  prepareDeviceCopies: vi.fn(async () => undefined),
  storeDeviceCopy: vi.fn(async () => undefined),
}));

const row = () => ({
  canEditContent: true,
  document: 'content' as const,
  kind: 'note' as const,
  materialId: 'note',
  owner: 'user',
  room: 'room',
  standalone: false,
  title: 'Note',
  version: 3,
});

const type = (doc: Y.Doc, text: string) =>
  doc.getText('content').insert(0, text);

const page = new EventTarget();

beforeEach(() => {
  vi.stubGlobal('window', page);
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { visibilityState: 'visible' })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('keepDeviceCopy', () => {
  it('writes a changed, clean document as it closes, and only once', () => {
    const doc = new Y.Doc();
    const keep = keepDeviceCopy(doc, {
      clean: () => true,
      owner: 'user',
      row,
      seeded: true,
    });
    type(doc, 'typed');
    keep.close();
    keep.close();
    expect(storeDeviceCopy).toHaveBeenCalledTimes(1);
    const [written, state] = vi.mocked(storeDeviceCopy).mock.calls[0];
    expect(written.room).toBe('room');
    const read = new Y.Doc();
    Y.applyUpdate(read, state);
    expect(read.getText('content').toString()).toBe('typed');
  });

  it('writes again on the page going, once it changed since the last write', () => {
    const doc = new Y.Doc();
    const keep = keepDeviceCopy(doc, {
      clean: () => true,
      owner: 'user',
      row,
      seeded: true,
    });
    page.dispatchEvent(new Event('pagehide'));
    expect(storeDeviceCopy).not.toHaveBeenCalled();
    type(doc, 'typed');
    page.dispatchEvent(new Event('pagehide'));
    page.dispatchEvent(new Event('pagehide'));
    expect(storeDeviceCopy).toHaveBeenCalledTimes(1);
    keep.stop();
  });

  // A rename or a demotion reaches the copy with the document unchanged, so
  // the next open paints with the current title and tools (ItemRoom.keepAs).
  it('writes a new label with the document as it was', () => {
    const doc = new Y.Doc();
    let title = 'Note';
    const keep = keepDeviceCopy(doc, {
      clean: () => true,
      owner: 'user',
      row: () => ({ ...row(), canEditContent: false, title }),
      seeded: true,
    });
    title = 'Renamed';
    keep.relabel();
    keep.close();
    expect(storeDeviceCopy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storeDeviceCopy).mock.calls[0][0]).toMatchObject({
      canEditContent: false,
      title: 'Renamed',
    });
  });

  it('waits for nothing unsent before it writes', () => {
    const doc = new Y.Doc();
    let clean = false;
    const keep = keepDeviceCopy(doc, {
      clean: () => clean,
      owner: 'user',
      row,
      seeded: true,
    });
    type(doc, 'typed');
    page.dispatchEvent(new Event('pagehide'));
    expect(storeDeviceCopy).not.toHaveBeenCalled();
    clean = true;
    keep.close();
    expect(storeDeviceCopy).toHaveBeenCalledTimes(1);
  });
});

describe('keepDeviceCopy without a copy to start from', () => {
  it('writes what it holds even if nothing changed since it began', () => {
    keepDeviceCopy(new Y.Doc(), {
      clean: () => true,
      owner: 'user',
      row,
      seeded: false,
    }).close();
    expect(storeDeviceCopy).toHaveBeenCalledTimes(1);
  });
});

describe('sweepDeviceCopies', () => {
  // Review 2026-11-20 (3): drafts kept for another reason than a deletion
  // (lost access) keep no copy.
  it('drops the copies of what the account can no longer read', async () => {
    await sweepDeviceCopies(
      'user',
      async () => ['kept'],
      async () => new Set()
    );
    expect(vi.mocked(dropDeviceCopies).mock.calls).toEqual([['lost']]);
  });

  // Review 2026-11-20 (2): a deleted quiz's Download takes its questions
  // from this copy while the draft sweep keeps its edits.
  it('keeps the copy of an unreadable item the draft sweep kept edits of', async () => {
    await sweepDeviceCopies(
      'user',
      async () => ['kept'],
      async () => new Set(['lost'])
    );
    expect(dropDeviceCopies).not.toHaveBeenCalled();
  });

  // Review 2026-11-20 (4): deleted after the draft sweep, a page here
  // showing its edits holds them, and decides its copy.
  it('keeps the copy of an unreadable item whose drafts a page here holds', async () => {
    vi.mocked(materialHeldHere).mockImplementation(
      (owner, id) => owner === 'user' && id === 'lost'
    );
    await sweepDeviceCopies(
      'user',
      async () => ['kept'],
      async () => new Set()
    );
    expect(dropDeviceCopies).not.toHaveBeenCalled();
    vi.mocked(materialHeldHere).mockReturnValue(false);
  });

  it('leaves every copy for the next load when the draft sweep did not run', async () => {
    const readable = vi.fn(async () => ['kept']);
    await sweepDeviceCopies('user', readable, async () => null);
    expect(readable).not.toHaveBeenCalled();
    expect(dropDeviceCopies).not.toHaveBeenCalled();
  });
});

// Review 2026-11-20 (3): a deleted item's copy follows the sweep's rule.
describe('dropDeletedCopies', () => {
  it('drops the copy once this device holds no edits to the item', async () => {
    vi.mocked(draftMaterials).mockResolvedValue(new Set(['other']));
    await dropDeletedCopies('user', 'quiz', { document: 'keys' });
    expect(vi.mocked(dropDeviceCopies).mock.calls).toEqual([['quiz', 'keys']]);
  });

  // The edits being written count: the store is read once they landed.
  it('keeps the copy while this device holds edits to the item', async () => {
    const stored: string[] = [];
    vi.mocked(draftMaterials).mockImplementation(async () => new Set(stored));
    const after = Promise.resolve().then(() => stored.push('quiz'));
    await dropDeletedCopies('user', 'quiz', { after });
    expect(draftMaterials).toHaveBeenCalledWith('user');
    expect(dropDeviceCopies).not.toHaveBeenCalled();
  });
});
