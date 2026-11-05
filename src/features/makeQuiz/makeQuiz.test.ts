import { describe, expect, it } from 'vitest';
import { EXTRACTION_PAGES_MAX } from '@/api/limits.generated';
import { m } from '@/i18n';
import {
  extractionFailure,
  extractionNotice,
  extractionRequest,
  hasFileRoom,
  isOfferable,
  isPaperFile,
  isReadingFile,
  isUnreadable,
  pageKey,
  quizTitleFrom,
  togglePage,
} from './makeQuiz';

describe('Make a quiz', () => {
  it('reads question papers from PDFs and images', () => {
    expect(isPaperFile({ kind: 'pdf' })).toBe(true);
    expect(isPaperFile({ kind: 'image' })).toBe(true);
    expect(isPaperFile({ kind: 'doc' })).toBe(false);
  });

  it('offers files that are read or being read', () => {
    expect(isOfferable({ indexed: true, status: 'ready' })).toBe(true);
    expect(isOfferable({ indexed: false, status: 'processing' })).toBe(true);
    expect(isOfferable({ indexed: false, status: 'ready' })).toBe(false);
    expect(isOfferable({ indexed: true, status: 'failed' })).toBe(false);
  });

  it('waits only for files on their way in, and tells a file that ended unread', () => {
    expect(isReadingFile({ status: 'pending' })).toBe(true);
    expect(isReadingFile({ status: 'processing' })).toBe(true);
    expect(isReadingFile({ status: 'failed' })).toBe(false);
    expect(isUnreadable({ indexed: false, status: 'failed' })).toBe(true);
    expect(isUnreadable({ indexed: false, status: 'ready' })).toBe(true);
    expect(isUnreadable({ indexed: false, status: 'processing' })).toBe(false);
    // A partial file failed but keeps its index.
    expect(isUnreadable({ indexed: true, status: 'failed' })).toBe(false);
  });

  it("names a failed run's reason by its code", () => {
    expect(extractionFailure('provider_busy')).toBe(m.make_quiz_failed_busy());
    expect(extractionFailure('storage_full')).toBe(
      m.make_quiz_failed_storage()
    );
    expect(extractionFailure('extraction_empty')).toBe(
      m.make_quiz_failed_empty()
    );
    expect(extractionFailure('interrupted')).toBe(
      m.make_quiz_failed_interrupted()
    );
    expect(extractionFailure('quiz_invalid')).toBe(
      m.make_quiz_failed_invalid()
    );
    expect(extractionFailure('extraction_failed')).toBe(
      m.make_quiz_failed_fallback()
    );
    expect(extractionFailure(undefined)).toBe(m.make_quiz_failed_fallback());
  });

  it('counts answer files toward the ten-file cap', () => {
    expect(hasFileRoom(1, 8)).toBe(true);
    expect(hasFileRoom(1, 9)).toBe(false);
  });

  it('selects and clears pages up to the cap', () => {
    const one = togglePage(new Set(), 'f:1');
    expect(one.has('f:1')).toBe(true);
    expect(togglePage(one, 'f:1').size).toBe(0);
    const full = new Set(
      Array.from({ length: EXTRACTION_PAGES_MAX }, (_, i) => `f:${i + 1}`)
    );
    expect(togglePage(full, 'f:99').size).toBe(EXTRACTION_PAGES_MAX);
    expect(togglePage(full, 'f:1').size).toBe(EXTRACTION_PAGES_MAX - 1);
  });

  it('groups selected pages by file in page order', () => {
    const pages = [
      { fileId: 'a', page: 1 },
      { fileId: 'a', page: 2 },
      { fileId: 'a', page: 3 },
      { fileId: 'b', page: 1 },
      { fileId: 'c', page: 1 },
    ];
    const selected = new Set(
      [pages[0], pages[2], pages[3]].map((page) => pageKey(page))
    );
    expect(extractionRequest('Paper', pages, selected, ['s'])).toEqual({
      answerFileIds: ['s'],
      paper: [
        { fileId: 'a', pages: [1, 3] },
        { fileId: 'b', pages: [1] },
      ],
      title: 'Paper',
    });
  });

  it('names the quiz after the paper, the next number when taken', () => {
    expect(quizTitleFrom('Past paper 2025 P1.pdf', [])).toBe(
      'Past paper 2025 P1'
    );
    expect(
      quizTitleFrom('Past paper 2025 P1.pdf', [
        'past paper 2025 p1',
        'Past paper 2025 P1 2',
      ])
    ).toBe('Past paper 2025 P1 3');
  });

  it('says what a run left out', () => {
    const report = {
      figuresLeftOut: [],
      missing: [],
      stopped: '' as const,
    };
    expect(extractionNotice(report)).toBeNull();
    expect(extractionNotice({ ...report, missing: ['4', '7'] })).toBe(
      m.make_quiz_missing({ labels: '4, 7' })
    );
    expect(extractionNotice({ ...report, answersMissing: ['4', '7(b)'] })).toBe(
      m.make_quiz_answers_missing({ labels: '4, 7(b)' })
    );
    expect(extractionNotice({ ...report, stopped: 'credits' })).toBe(
      m.make_quiz_stopped_credits()
    );
  });
});
