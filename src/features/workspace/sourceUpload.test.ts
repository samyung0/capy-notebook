import { describe, expect, it } from 'vitest';

import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';

import {
  aggregateUploadPct,
  defaultParseMode,
  getFileKind,
  parseModeIssues,
} from './sourceUpload';

const file = (name: string, size = 1) => ({ name, size }) as File;

describe('source upload policy', () => {
  it('classifies the complete frontend extension list from the server policy', () => {
    expect(getFileKind('notes.mdc', sourceUploadPolicy)).toBe('md');
    expect(getFileKind('script.py', sourceUploadPolicy)).toBe('txt');
    expect(getFileKind('data.csv', sourceUploadPolicy)).toBe('sheet');
    expect(getFileKind('archive.zip', sourceUploadPolicy)).toBe('unknown');
    expect(getFileKind('README', sourceUploadPolicy)).toBe('unknown');
  });

  it('selects parser modes using server-provided limits', () => {
    expect(defaultParseMode(file('paper.pdf'), 'pdf', sourceUploadPolicy)).toBe(
      'normal'
    );
    expect(
      defaultParseMode(
        file('paper.pdf', 11 * 1024 * 1024),
        'pdf',
        sourceUploadPolicy
      )
    ).toBe('advanced');
    expect(
      parseModeIssues(
        file('paper.pdf', 21 * 1024 * 1024),
        'pdf',
        sourceUploadPolicy
      )
    ).toEqual({
      advanced: null,
      normal: 'over 10 MB',
    });
    expect(defaultParseMode(file('script.py'), 'txt', sourceUploadPolicy)).toBe(
      'none'
    );
  });
});

describe('aggregate upload progress', () => {
  it('weights progress by bytes rather than file count', () => {
    expect(
      aggregateUploadPct([
        { size: 1, uploadPct: 100 },
        { size: 3, uploadPct: 0 },
      ])
    ).toBe(25);
  });

  it('handles empty and missing progress values', () => {
    expect(aggregateUploadPct([])).toBe(0);
    expect(aggregateUploadPct([{ size: 100 }])).toBe(0);
  });
});
