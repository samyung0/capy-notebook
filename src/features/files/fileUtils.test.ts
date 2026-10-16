import { describe, expect, it } from 'vitest';
import { fileCanClone, fileIsIngesting } from './fileUtils';

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
