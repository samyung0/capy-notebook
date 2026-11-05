import { describe, expect, it } from 'vitest';
import { ApiError, parseErrorBody } from '@/api/client';
import { EXTRACTION_PAGES_MAX } from '@/api/limits.generated';
import { m } from '@/i18n';
import {
  affordableQuestions,
  extractionFailure,
  extractionNotice,
  extractionRefusal,
  extractionRequest,
  foundPagesLabel,
  hasAnswerRoom,
  hasPaperRoom,
  isOfferable,
  isQuizFile,
  isReadingFile,
  isUnreadable,
  isWholeFile,
  pageKey,
  pickedPages,
  quizTitleFrom,
  runProgress,
  toggleAllPages,
  togglePage,
} from './makeQuiz';

describe('Make a quiz', () => {
  it('reads every indexed file but a spreadsheet and audio', () => {
    expect(isQuizFile({ kind: 'pdf', name: 'a.pdf' })).toBe(true);
    expect(isQuizFile({ kind: 'image', name: 'a.png' })).toBe(true);
    expect(isQuizFile({ kind: 'doc', name: 'a.docx' })).toBe(true);
    expect(isQuizFile({ kind: 'slides', name: 'a.pptx' })).toBe(true);
    expect(isQuizFile({ kind: 'md', name: 'a.md' })).toBe(true);
    expect(isQuizFile({ kind: 'sheet', name: 'a.csv' })).toBe(true);
    expect(isQuizFile({ kind: 'sheet', name: 'a.xlsx' })).toBe(false);
    expect(isQuizFile({ kind: 'audio', name: 'a.mp3' })).toBe(false);
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

  it('names a refused start by its code', () => {
    const refused = (message: string) =>
      new ApiError(
        400,
        'Bad Request',
        'detail',
        parseErrorBody({ errors: [{ message }] })
      );
    expect(extractionRefusal(refused('too_much_text'))).toBe(
      m.make_quiz_refused_text()
    );
    expect(extractionRefusal(refused('no_indexed_text'))).toBe(
      m.make_quiz_refused_no_text()
    );
    expect(extractionRefusal(refused('other'))).toBeNull();
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

  it('takes five question files and three answer files', () => {
    expect(hasPaperRoom(4)).toBe(true);
    expect(hasPaperRoom(5)).toBe(false);
    expect(hasAnswerRoom(2)).toBe(true);
    expect(hasAnswerRoom(3)).toBe(false);
  });

  it('picks pages up to the cap across files, and all of a file', () => {
    let selected: ReadonlySet<string> = new Set();
    selected = toggleAllPages(selected, 'a', 30);
    expect(selected.size).toBe(30);
    selected = toggleAllPages(selected, 'b', 30);
    expect(selected.size).toBe(EXTRACTION_PAGES_MAX);
    expect(pickedPages(selected, 'b')).toHaveLength(10);
    expect(togglePage(selected, pageKey({ fileId: 'b', page: 20 })).size).toBe(
      EXTRACTION_PAGES_MAX
    );
    selected = toggleAllPages(selected, 'a', 30);
    expect(pickedPages(selected, 'a')).toEqual([]);
  });

  it('asks only text files to go whole', () => {
    expect(isWholeFile({ kind: 'md', name: 'a.md' })).toBe(true);
    expect(isWholeFile({ kind: 'doc', name: 'a.doc' })).toBe(true);
    expect(isWholeFile({ kind: 'doc', name: 'a.docx' })).toBe(false);
    expect(isWholeFile({ kind: 'slides', name: 'a.pptx' })).toBe(false);
    expect(isWholeFile({ kind: 'pdf', name: 'a.pdf' })).toBe(false);
    expect(isWholeFile({ kind: 'image', name: 'a.png' })).toBe(false);
  });

  it('builds a request of each file and its picked pages, in order', () => {
    const selected = new Set(['a:3', 'a:1', 's:2', 'd:1']);
    const drawn = new Map([['d:1', 'jpeg']]);
    expect(
      extractionRequest('Paper', ['a'], ['s', 'd', 'notes'], selected, drawn)
    ).toEqual({
      answers: [
        { fileId: 's', pages: [2] },
        { fileId: 'd', images: ['jpeg'], pages: [1] },
        { fileId: 'notes', pages: [] },
      ],
      paper: [{ fileId: 'a', pages: [1, 3] }],
      title: 'Paper',
    });
  });

  it('offers the questions the credits left pay for', () => {
    expect(affordableQuestions(12, 100)).toBe(12);
    expect(affordableQuestions(12, 21)).toBe(5);
    expect(affordableQuestions(12, 3)).toBe(0);
  });

  it('says where a found question is', () => {
    expect(foundPagesLabel({ first: 2, last: 2, parts: [] })).toBe(
      m.make_quiz_found_page({ page: 2 })
    );
    expect(foundPagesLabel({ first: 2, last: 3, parts: ['a', 'b'] })).toBe(
      `${m.make_quiz_found_pages({ first: 2, last: 3 })} · ${m.make_quiz_found_parts({ parts: 'a, b' })}`
    );
  });

  it('spends half the bar copying and half answering', () => {
    expect(runProgress({ answered: 0, confirmed: 12, recorded: 8 })).toEqual({
      label: m.make_quiz_panel_copying({ count: 8, total: 12 }),
      value: (8 / 12) * 50,
    });
    expect(runProgress({ answered: 6, confirmed: 12, recorded: 12 })).toEqual({
      label: m.make_quiz_panel_answers({ count: 6, total: 12 }),
      value: 75,
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
