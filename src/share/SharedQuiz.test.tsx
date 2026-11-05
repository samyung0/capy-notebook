import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type {
  AnonymousEmbed,
  AnonymousQuiz,
  GradedQuestion,
  Question,
} from '@/api/types';
import {
  exampleAnswers,
  exampleQuestion,
} from '@/features/questions/questionFixtures';
import { getLocale, m } from '@/i18n';

/* A shared page's check, the same for every visitor (Epo 2026-11-05, Q640 B): a
   closed part marks, an open part reads Not marked with its marking points and
   solution, nothing offers to check it again, and the check sends only the
   answers. */

// The locale resolves before a window exists; then linkedom's document goes
// in before react-dom/client loads, which reads it once.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const anonymous = vi.hoisted(() => ({
  gradeAnonymousNoteQuiz: vi.fn(),
  gradeAnonymousQuiz: vi.fn(),
}));
vi.mock('@/api/anonymous', async (importActual) => ({
  ...(await importActual<typeof import('@/api/anonymous')>()),
  ...anonymous,
}));
vi.mock('@/lib/localDb', () => ({
  localQuizAttempts: async () => [],
  saveLocalQuizAttempt: async () => {},
}));

const { createRoot } = await import('react-dom/client');
const { PublicQuizEmbed } = await import('./PublicQuizEmbed');
const { SharedQuiz } = await import('./SharedQuiz');

const open = exampleQuestion('q_open', exampleAnswers[6]);
const closed = exampleQuestion('q_closed', exampleAnswers[2]);
const point = open.parts[0].markscheme?.[0].text as string;
const solution = 'Worked through the folds.';

/** What the server answers: its Not marked open part, with the key, and a
 * marked closed part. */
const answer = (id: string): GradedQuestion =>
  (id === open.id
    ? {
        correct: 0,
        question: {
          ...open,
          parts: [
            {
              ...open.parts[0],
              awarded: 0,
              pending: true,
              solution: [{ text: solution, type: 'text' }],
            },
          ],
        } satisfies Question,
        total: 1,
      }
    : {
        correct: 1,
        question: {
          ...closed,
          parts: [{ ...closed.parts[0], awarded: 1 }],
        } satisfies Question,
        total: 1,
      }) as GradedQuestion;

const questions = [
  { ...open, parts: [{ ...open.parts[0], answer: { type: 'open' } }] },
  { ...closed, parts: [{ ...closed.parts[0], answer: { type: 'boolean' } }] },
] as AnonymousQuiz['questions'];

/** Renders `page`, then checks its open question and its closed one. */
async function check(page: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        {page}
      </QueryClientProvider>
    );
  });
  const button = (name: string) =>
    [...host.querySelectorAll('button')].filter(
      (item) => item.textContent === name
    );
  await act(async () => button(m.question_ui_check())[0]?.click());
  const openText = host.textContent ?? '';
  const seen = {
    checkAgain: button(m.question_ui_check_again()).length,
    // Only the closed question is left to check.
    checksLeft: button(m.question_ui_check()).length,
    markingPoint: openText.includes(point),
    notMarked: openText.includes(m.assignment_not_marked()),
    solution: openText.includes(solution),
  };
  await act(async () => button(m.question_ui_true())[0]?.click());
  await act(async () => button(m.question_ui_check())[0]?.click());
  const closedRight = host.textContent?.includes(m.question_ui_result_right());
  act(() => root.unmount());
  host.remove();
  return { ...seen, closedRight };
}

const MARKED = {
  checkAgain: 0,
  checksLeft: 1,
  closedRight: true,
  markingPoint: true,
  notMarked: true,
  solution: true,
};

it('marks the closed part and leaves the open part Not marked on a shared quiz', async () => {
  anonymous.gradeAnonymousQuiz.mockImplementation(
    async (_token, { questionId }) => answer(questionId)
  );
  const seen = await check(
    <SharedQuiz
      quiz={
        {
          author: { name: 'Mia' },
          id: 'qz_1',
          name: 'Cells',
          questions,
          updatedAt: '2026-11-06T00:00:00Z',
        } as AnonymousQuiz
      }
      token="qz_1.sig"
    />
  );
  expect(seen).toEqual(MARKED);
  expect(anonymous.gradeAnonymousQuiz).toHaveBeenCalledWith('qz_1.sig', {
    answers: {},
    questionId: open.id,
  });
});

it('does the same for a quiz embedded in a shared note', async () => {
  anonymous.gradeAnonymousNoteQuiz.mockImplementation(
    async (_token, _quiz, { questionId }) => answer(questionId)
  );
  const seen = await check(
    <PublicQuizEmbed
      embed={{ id: 'qz_2', kind: 'quiz', questions } as AnonymousEmbed}
      token="note.sig"
    />
  );
  expect(seen).toEqual(MARKED);
  expect(anonymous.gradeAnonymousNoteQuiz).toHaveBeenCalledWith(
    'note.sig',
    'qz_2',
    { answers: {}, questionId: open.id }
  );
});
