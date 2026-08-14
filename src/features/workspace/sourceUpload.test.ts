import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client';
import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';

import {
  aggregateUploadPct,
  capSourceUploads,
  defaultParseMode,
  getFileKind,
  MAX_SOURCE_UPLOAD_FILES,
  mapWithConcurrency,
  parseModeIssues,
  retryAfterMs,
  supportsFigures,
  withUploadRetry,
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

describe('upload batch limits', () => {
  it('caps incoming files against the batch maximum', () => {
    const { accepted, rejected } = capSourceUploads(18, [1, 2, 3, 4]);
    expect(accepted).toEqual([1, 2]);
    expect(rejected).toBe(2);
    expect(MAX_SOURCE_UPLOAD_FILES).toBe(20);
  });

  it('runs a bounded worker pool in original order', async () => {
    let inflight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await Promise.resolve();
      inflight -= 1;
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(
      results.map((r) => (r.status === 'fulfilled' ? r.value : 0))
    ).toEqual([10, 20, 30, 40, 50]);
  });

  it('backs off 429s using retryAfterSeconds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await withUploadRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new ApiError(429, 'Too Many Requests', undefined, {
            retryAfterSeconds: 2,
          });
        }
        return 'ok';
      },
      async (ms) => {
        waits.push(ms);
      }
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
    expect(
      retryAfterMs(new ApiError(403, 'Forbidden', undefined, { code: 'x' }))
    ).toBeNull();
  });
});
