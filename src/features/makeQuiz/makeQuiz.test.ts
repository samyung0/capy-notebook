import { describe, expect, it } from 'vitest';
import { EXTRACTION_PAGES_MAX } from '@/api/limits.generated';
import { m } from '@/i18n';
import {
  extractionNotice,
  extractionRequest,
  hasFileRoom,
  isOfferable,
  isPaperFile,
  pageKey,
  quizTitleFrom,
  togglePage,
} from './makeQuiz';

describe('Make a quiz', () => {
  it('reads question papers from PDFs, images, Word and PowerPoint', () => {
    expect(isPaperFile({ kind: 'pdf', name: 'a.pdf' })).toBe(true);
    expect(isPaperFile({ kind: 'image', name: 'a.png' })).toBe(true);
    expect(isPaperFile({ kind: 'doc', name: 'a.docx' })).toBe(true);
    expect(isPaperFile({ kind: 'slides', name: 'a.pptx' })).toBe(true);
    expect(isPaperFile({ kind: 'sheet', name: 'a.xlsx' })).toBe(false);
  });

  it('sends a drawn page with its image, in page order', () => {
    const pages = [
      { fileId: 'w', page: 1 },
      { fileId: 'w', page: 2 },
    ];
    expect(
      extractionRequest(
        'T',
        pages,
        new Set(['w:2']),
        [],
        new Map([
          ['w:1', 'one'],
          ['w:2', 'two'],
        ])
      ).paper
    ).toEqual([{ fileId: 'w', images: ['two'], pages: [2] }]);
  });

  it('offers files that are read or being read', () => {
    expect(isOfferable({ indexed: true, status: 'ready' })).toBe(true);
    expect(isOfferable({ indexed: false, status: 'processing' })).toBe(true);
    expect(isOfferable({ indexed: false, status: 'ready' })).toBe(false);
    expect(isOfferable({ indexed: true, status: 'failed' })).toBe(false);
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
