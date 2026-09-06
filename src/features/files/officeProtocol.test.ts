import { describe, expect, it } from 'vitest';
import {
  isOfficeHostMessage,
  isOfficeRuntimeMessage,
  OFFICE_PROTOCOL_VERSION,
} from './officeProtocol';
import {
  isCurrentOfficeRuntimeMessage,
  officeRuntimeKey,
} from './useOfficeRuntime';

describe('office host protocol', () => {
  it('requires a load to choose its first runtime mode', () => {
    const load = {
      bytes: new ArrayBuffer(4),
      canEdit: true,
      fileName: 'notes.docx',
      format: 'docx' as const,
      revision: 1,
      type: 'load' as const,
      version: OFFICE_PROTOCOL_VERSION,
    };

    expect(isOfficeHostMessage({ ...load, mode: 'view' })).toBe(true);
    expect(isOfficeHostMessage({ ...load, mode: 'edit' })).toBe(false);
    expect(
      isOfficeHostMessage({
        ...load,
        collaboration: { epoch: 1, initialUpdate: new ArrayBuffer(2) },
        mode: 'edit',
      })
    ).toBe(true);
    expect(isOfficeHostMessage(load)).toBe(false);
  });

  it('does not allow an existing runtime to switch document engines in place', () => {
    expect(
      isOfficeHostMessage({
        mode: 'edit',
        type: 'set-mode',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
    expect(
      isOfficeHostMessage({
        bytes: new ArrayBuffer(4),
        revision: 2,
        type: 'save-committed',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
  });

  it('accepts capability updates sent after the iframe loads', () => {
    expect(
      isOfficeHostMessage({
        canEdit: true,
        type: 'set-capabilities',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
  });

  it('rejects capability updates without a boolean permission', () => {
    expect(
      isOfficeHostMessage({
        canEdit: 'true',
        type: 'set-capabilities',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
  });

  it('requires every runtime event to identify its loaded revision', () => {
    expect(
      isOfficeRuntimeMessage({
        dirty: true,
        revision: 2,
        type: 'dirty',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
    expect(
      isOfficeRuntimeMessage({
        dirty: true,
        type: 'dirty',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
  });

  it('rejects malformed data from the isolated runtime', () => {
    expect(
      isOfficeRuntimeMessage({
        analysis: { format: 'docx', pageCount: Number.POSITIVE_INFINITY },
        revision: 2,
        type: 'ready',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
    expect(
      isOfficeRuntimeMessage({
        bytes: 'not an ArrayBuffer',
        revision: 2,
        type: 'save',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(false);
    expect(
      isOfficeRuntimeMessage({
        dirty: false,
        revision: 2,
        type: 'dirty',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
  });
});

describe('office save fencing', () => {
  const fileA = { id: 'file-a', url: '/api/files/file-a/content' };
  const fileB = { id: 'file-b', url: '/api/files/file-b/content' };

  it('keeps the editor mounted across metadata and content URL refetches', () => {
    expect(officeRuntimeKey(fileA, 1)).not.toBe(officeRuntimeKey(fileB, 1));
    expect(officeRuntimeKey(fileA, 1)).toBe(officeRuntimeKey(fileA, 2));
    expect(officeRuntimeKey(fileA, 1)).toBe(
      officeRuntimeKey({ ...fileA, url: `${fileA.url}?v=2` }, 1)
    );
  });

  it.each(['ready', 'mode', 'dirty', 'error', 'save'])(
    'rejects a late revision-one %s event after revision two loads',
    () => {
      expect(isCurrentOfficeRuntimeMessage(1, 2)).toBe(false);
      expect(isCurrentOfficeRuntimeMessage(2, 2)).toBe(true);
    }
  );
});

describe('source collaboration bridge', () => {
  it('requires epochs and request identities for replica updates and flush receipts', () => {
    const update = {
      bytes: new ArrayBuffer(2),
      epoch: 4,
      type: 'update',
      version: OFFICE_PROTOCOL_VERSION,
    };
    expect(isOfficeHostMessage(update)).toBe(true);
    expect(isOfficeHostMessage({ ...update, epoch: -1 })).toBe(false);
    expect(isOfficeRuntimeMessage({ ...update, revision: 2 })).toBe(true);
    expect(
      isOfficeRuntimeMessage({ ...update, revision: 2, type: 'flushed' })
    ).toBe(false);
    expect(
      isOfficeRuntimeMessage({
        ...update,
        id: 'checkpoint-1',
        revision: 2,
        type: 'flushed',
      })
    ).toBe(true);
    expect(
      isOfficeRuntimeMessage({
        type: 'initialized',
        version: OFFICE_PROTOCOL_VERSION,
      })
    ).toBe(true);
  });
});
