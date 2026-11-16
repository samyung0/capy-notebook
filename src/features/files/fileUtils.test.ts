import { describe, expect, it } from 'vitest';
import type { SourceFile, Workspace } from '@/api/types';
import { m } from '@/i18n';
import {
  canConvertLegacy,
  failedNotIndexedMessage,
  fileCanClone,
  fileCanMoveTo,
  fileIsIngesting,
  legacyOfficeTarget,
  notIndexedMessage,
} from './fileUtils';

describe('fileIsIngesting', () => {
  it('treats pending and processing as in-flight ingest', () => {
    expect(fileIsIngesting('pending')).toBe(true);
    expect(fileIsIngesting('processing')).toBe(true);
  });

  it('lets ready and failed files be opened', () => {
    expect(fileIsIngesting('ready')).toBe(false);
    expect(fileIsIngesting('failed')).toBe(false);
    expect(fileIsIngesting(undefined)).toBe(false);
  });
});

describe('fileCanClone', () => {
  it('offers Clone on ready and partial files only', () => {
    expect(fileCanClone({ indexed: false, status: 'ready' })).toBe(true);
    // Partial: failed with its index still served (parts design Q2).
    expect(fileCanClone({ indexed: true, status: 'failed' })).toBe(true);
    expect(fileCanClone({ indexed: false, status: 'failed' })).toBe(false);
    expect(fileCanClone({ indexed: true, status: 'processing' })).toBe(false);
    expect(fileCanClone({ indexed: false, status: 'pending' })).toBe(false);
  });
});

describe('fileCanMoveTo', () => {
  it("offers Move to… to the workspace's owner and the file's payer", () => {
    expect(fileCanMoveTo({ isPayer: true }, { isOwner: false })).toBe(true);
    expect(fileCanMoveTo({ isPayer: false }, { isOwner: true })).toBe(true);
    expect(fileCanMoveTo({ isPayer: false }, { isOwner: false })).toBe(false);
  });
});

describe('notIndexedMessage', () => {
  it('says a recording had no speech, apart from the size limits', () => {
    expect(notIndexedMessage({ indexLimit: 'no_speech' })).toBe(
      m.files_not_indexed_no_speech()
    );
    expect(notIndexedMessage({ indexLimit: 'audio_duration_limit' })).toBe(
      m.files_not_indexed_too_large()
    );
    expect(notIndexedMessage({ indexLimit: undefined })).toBe(
      m.files_not_indexed()
    );
  });
});

// A legacy Office upload is converted and renamed by the server (Epo
// 2026-11-11), so a legacy name means the conversion has not finished.
describe('legacy Office files', () => {
  it('names the format each legacy ending is converted to', () => {
    expect(legacyOfficeTarget('Essay.DOC')).toBe('docx');
    expect(legacyOfficeTarget('grades.xls')).toBe('xlsx');
    expect(legacyOfficeTarget('talk.v2.ppt')).toBe('pptx');
    expect(legacyOfficeTarget('essay.docx')).toBe(null);
    expect(legacyOfficeTarget('doc')).toBe(null);
  });

  // Convert goes to whoever the file's ⋮ Retry processing goes to.
  it('offers Convert on an unconverted file to who may reprocess it', () => {
    const owner = {
      capabilities: { canEdit: true },
      isOwner: true,
    } as Workspace;
    const file = (fields: Partial<SourceFile>) =>
      ({
        isPayer: false,
        name: 'essay.doc',
        status: 'ready',
        workspaceId: 'ws_1',
        ...fields,
      }) as SourceFile;
    expect(canConvertLegacy(file({}), owner, false)).toBe(true);
    expect(canConvertLegacy(file({ status: 'failed' }), owner, false)).toBe(
      true
    );
    // Converting already, converted, or never an old Office file.
    expect(canConvertLegacy(file({ status: 'pending' }), owner, false)).toBe(
      false
    );
    expect(canConvertLegacy(file({ status: 'processing' }), owner, false)).toBe(
      false
    );
    expect(canConvertLegacy(file({ name: 'essay.docx' }), owner, false)).toBe(
      false
    );
    expect(canConvertLegacy(file({ name: 'archive.zip' }), owner, false)).toBe(
      false
    );
    // An editor or member, the owner of a read-only workspace, and before the
    // workspace loads.
    expect(
      canConvertLegacy(
        file({ isPayer: true }),
        { ...owner, isOwner: false },
        false
      )
    ).toBe(false);
    expect(
      canConvertLegacy(
        file({}),
        { ...owner, capabilities: { canEdit: false } } as Workspace,
        false
      )
    ).toBe(false);
    expect(canConvertLegacy(file({}), undefined, false)).toBe(false);
    // No workspace: its payer, unless frozen.
    const alone = file({ isPayer: true, workspaceId: '' });
    expect(canConvertLegacy(alone, undefined, false)).toBe(true);
    expect(canConvertLegacy(alone, undefined, true)).toBe(false);
    expect(
      canConvertLegacy({ ...alone, isPayer: false }, undefined, false)
    ).toBe(false);
  });

  it('says a failed legacy file could not be converted', () => {
    expect(failedNotIndexedMessage({ name: 'grades.xls' })).toBe(
      m.files_convert_failed()
    );
    expect(failedNotIndexedMessage({ name: 'grades.xlsx' })).toBe(
      m.files_not_indexed_failed()
    );
  });
});
