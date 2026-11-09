import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Extraction } from '@/api/types';
import { m } from '@/i18n';
import { announceExtractionEnd } from './extractionEnd';
import { addQuizRun, dismissQuizRuns } from './quizRuns';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/userToast', () => ({ userToast: toast }));

const links = () => ({
  openQuiz: vi.fn(),
  pickAgain: vi.fn(),
  review: vi.fn(),
});

const run = (over: Partial<Extraction>): Extraction => ({
  answered: 12,
  createdAt: '2026-11-04T10:00:00Z',
  id: 'ex_1',
  recorded: 12,
  status: 'done',
  title: 'Past paper',
  workspaceId: 'ws_1',
  ...over,
});

describe('announceExtractionEnd', () => {
  beforeEach(() => {
    toast.mockClear();
    dismissQuizRuns();
  });

  it('offers the finished quiz when its run page is not open', () => {
    const open = links();
    announceExtractionEnd(run({ quizId: 'qz_1' }), undefined, open);
    const options = toast.mock.calls[0][0];
    expect(options.title).toBe(
      m.make_quiz_ready_toast({ title: 'Past paper' })
    );
    options.button.onClick();
    expect(open.openQuiz).toHaveBeenCalledWith('ws_1', 'qz_1');
  });

  it('offers the questions found when the run waits off screen', () => {
    const open = links();
    announceExtractionEnd(
      run({
        found: {
          answerFiles: 0,
          availableCredits: 100,
          chargedCredits: 2,
          paperName: 'Past paper.pdf',
          paperPages: 2,
          questions: [{ first: 1, label: '1', last: 1, parts: [] }],
          unreadAnswers: [],
        },
        status: 'confirming',
      }),
      undefined,
      open
    );
    toast.mock.calls[0][0].button.onClick();
    expect(open.review).toHaveBeenCalledWith('ws_1', 'ex_1');
  });

  it('leaves a run in the panel to the panel', () => {
    addQuizRun({ answers: [], id: 'ex_1', paper: ['p'], workspaceId: 'ws_1' });
    announceExtractionEnd(run({ quizId: 'qz_1' }), undefined, links());
    expect(toast).not.toHaveBeenCalled();
  });

  it('says why a run failed, by its code', () => {
    announceExtractionEnd(
      run({
        error: 'No questions could be read from the selected pages.',
        errorCode: 'extraction_empty',
        status: 'failed',
      }),
      undefined,
      links()
    );
    expect(toast.mock.calls[0][0]).toMatchObject({
      description: m.make_quiz_failed_empty(),
      variant: 'error',
    });
  });

  it('leaves a run to its own page', () => {
    announceExtractionEnd(run({ quizId: 'qz_1' }), 'ex_1', links());
    expect(toast).not.toHaveBeenCalled();
  });
});
