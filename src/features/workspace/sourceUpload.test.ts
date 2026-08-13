import { describe, expect, it } from 'vitest';

import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';

import {
  aggregateUploadPct,
  defaultParseMode,
  getFileKind,
  parseModeIssues,
  supportsFigures,
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
      'fast'
    );
    expect(
      parseModeIssues(
        file('paper.pdf', 11 * 1024 * 1024),
        'pdf',
        sourceUploadPolicy
      )
    ).toEqual({
      accurate: 'over 10 MB',
      fast: 'over 10 MB',
    });
    expect(
      defaultParseMode(
        file('paper.pdf', 11 * 1024 * 1024),
        'pdf',
        sourceUploadPolicy
      )
    ).toBe('none');
    expect(
      parseModeIssues(file('archive.zip'), 'unknown', sourceUploadPolicy)
    ).toEqual({
      accurate: 'format not supported',
      fast: 'format not supported',
    });
    expect(defaultParseMode(file('script.py'), 'txt', sourceUploadPolicy)).toBe(
      'none'
    );
  });

  it('offers image captioning only for modes that extract figures', () => {
    expect(supportsFigures('fast', 'pdf', sourceUploadPolicy)).toBe(true);
    expect(supportsFigures('accurate', 'pdf', sourceUploadPolicy)).toBe(true);
    expect(supportsFigures('none', 'pdf', sourceUploadPolicy)).toBe(false);
    expect(supportsFigures('fast', 'txt', sourceUploadPolicy)).toBe(false);
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
