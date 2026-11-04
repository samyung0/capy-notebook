import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { dropDeviceCopies, storeDeviceCopy } from '@/lib/sourceCache';
import { keepDeviceCopy, sweepDeviceCopies } from './deviceCopy';

vi.mock('@/api/auth', () => ({ USE_MSW: false }));
vi.mock('@/lib/sourceCache', () => ({
  deviceCopyMaterials: vi.fn(async () => ['kept', 'lost']),
  dropDeviceCopies: vi.fn(async () => undefined),
  prepareDeviceCopies: vi.fn(async () => undefined),
  storeDeviceCopy: vi.fn(async () => undefined),
}));

const row = () => ({
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
    });
    page.dispatchEvent(new Event('pagehide'));
    expect(storeDeviceCopy).not.toHaveBeenCalled();
    type(doc, 'typed');
    page.dispatchEvent(new Event('pagehide'));
    page.dispatchEvent(new Event('pagehide'));
    expect(storeDeviceCopy).toHaveBeenCalledTimes(1);
    keep.stop();
  });

  it('waits for nothing unsent before it writes', () => {
    const doc = new Y.Doc();
    let clean = false;
    const keep = keepDeviceCopy(doc, {
      clean: () => clean,
      owner: 'user',
      row,
    });
    type(doc, 'typed');
    page.dispatchEvent(new Event('pagehide'));
    expect(storeDeviceCopy).not.toHaveBeenCalled();
    clean = true;
    keep.close();
    expect(storeDeviceCopy).toHaveBeenCalledTimes(1);
  });
});

describe('sweepDeviceCopies', () => {
  it('drops the copies of what the account can no longer read', async () => {
    await sweepDeviceCopies('user', async () => ['kept']);
    expect(vi.mocked(dropDeviceCopies).mock.calls).toEqual([['lost']]);
  });
});
