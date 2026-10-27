import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import {
  fileCanClone,
  fileCanMoveTo,
  fileIsIngesting,
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
