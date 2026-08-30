import { describe, expect, it } from 'vitest';
import {
  isOfficeHostMessage,
  isOfficeRuntimeMessage,
  OFFICE_PROTOCOL_VERSION,
} from './officeProtocol';
import {
  isCurrentOfficeRuntimeMessage,
  isCurrentOfficeSave,
  officeRuntimeKey,
  resolveInitialOfficeMode,
  runOfficeSave,
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
    expect(isOfficeHostMessage({ ...load, mode: 'edit' })).toBe(true);
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

  it('includes the file, content URL, and revision in the runtime identity', () => {
    expect(officeRuntimeKey(fileA, 1)).not.toBe(officeRuntimeKey(fileB, 1));
    expect(officeRuntimeKey(fileA, 1)).not.toBe(officeRuntimeKey(fileA, 2));
    expect(officeRuntimeKey(fileA, 1)).not.toBe(
      officeRuntimeKey({ ...fileA, url: `${fileA.url}?v=2` }, 1)
    );
  });

  it('rejects a completion from another runtime generation', () => {
    expect(isCurrentOfficeSave(1, 2, true)).toBe(false);
  });

  it.each(['ready', 'mode', 'dirty', 'error', 'save'])(
    'rejects a late revision-one %s event after revision two loads',
    () => {
      expect(isCurrentOfficeRuntimeMessage(1, 2)).toBe(false);
      expect(isCurrentOfficeRuntimeMessage(2, 2)).toBe(true);
    }
  );

  it('accepts only the still-mounted runtime that initiated the save', () => {
    expect(isCurrentOfficeSave(1, 1, true)).toBe(true);
    expect(isCurrentOfficeSave(1, 1, false)).toBe(false);
  });

  it.each([
    ['resolved', true],
    ['rejected', false],
  ])(
    'ignores a late %s save after the runtime changes',
    async (_, resolveSave) => {
      let currentGeneration = 1;
      const committed: number[] = [];
      const rejected: string[] = [];
      let settleSave: ((value: { revision: number }) => void) | undefined;
      let rejectSave: ((reason: Error) => void) | undefined;
      const pending = new Promise<{ revision: number }>((resolve, reject) => {
        settleSave = resolve;
        rejectSave = reject;
      });

      const saving = runOfficeSave({
        bytes: new Uint8Array([1, 2, 3]),
        expectedRevision: 1,
        isCurrent: () => isCurrentOfficeSave(1, currentGeneration, true),
        onCommitted: (saved) => committed.push(saved.revision),
        onRejected: (error) => rejected.push(error.message),
        onSave: () => pending,
      });
      currentGeneration = 2;
      if (resolveSave) settleSave?.({ revision: 2 });
      else rejectSave?.(new Error('save failed'));
      await saving;

      expect(committed).toEqual([]);
      expect(rejected).toEqual([]);
    }
  );
});

describe('office runtime lifecycle', () => {
  it('starts directly in edit only when the host can save', () => {
    expect(resolveInitialOfficeMode('edit', true, true)).toBe('edit');
    expect(resolveInitialOfficeMode('edit', false, true)).toBe('view');
    expect(resolveInitialOfficeMode('edit', true, false)).toBe('view');
    expect(resolveInitialOfficeMode('view', true, true)).toBe('view');
  });
});
