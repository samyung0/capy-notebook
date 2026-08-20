import { describe, expect, it } from 'vitest';
import { fileIsIngesting } from './fileUtils';

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
