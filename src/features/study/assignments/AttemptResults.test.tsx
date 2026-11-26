import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Assignment, AssignmentAttempt } from '@/api/types';
import { getLocale, m } from '@/i18n';

/* Show grades Manual (S7): before release a member's results list their
   answers with no mark. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('@/api/hooks', () => ({
  useFile: () => ({ data: undefined }),
  useMarkAssignmentAnswer: () => ({ mutate: vi.fn() }),
  useStartAssignment: () => ({ isPending: false, mutate: vi.fn() }),
  useWorkspace: () => ({ data: undefined }),
}));
// The file viewer's lazy parts: the card by its file's name alone.
vi.mock('./LazyPaper', () => ({
  PaperPages: () => null,
  QuestionPaperCard: ({ file }: { file: { name: string } | null }) => (
    <p>{file?.name}</p>
  ),
  QuestionPaperView: () => null,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ workspaceId: 'ws' }),
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import(
  '@tanstack/react-query'
);
const { AttemptResults } = await import('./AttemptResults');

const part = (id: string) => ({
  answer: { accepted: ['osmosis'], type: 'short' },
  blocks: [{ text: 'Name it', type: 'text' }],
  id,
  marks: 2,
  solution: [],
});
const attempt = {
  answers: { p1: 'osmosis' },
  correct: 0,
  gradesHidden: true,
  mark: 0,
  paperFiles: [],
  questions: [
    {
      id: 'q1',
      labels: 'letters',
      layout: 'paper',
      parts: [part('p1')],
      stem: [],
    },
    {
      id: 'q2',
      labels: 'letters',
      layout: 'paper',
      parts: [part('p2')],
      stem: [],
    },
  ],
  status: 'submitted',
  submittedAt: '2026-11-08T10:00:00Z',
  title: 'Past paper',
  total: 0,
} as unknown as AssignmentAttempt;

const hiddenText = async (gradesHidden: boolean) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <AttemptResults
        assignment={
          { gradesHidden, postedBy: 'Kate', workspaceId: 'ws1' } as Assignment
        }
        attempt={attempt}
      />
    )
  );
  return { host, root, text: host.textContent ?? '' };
};

it('lists answers without marks while grades wait for release', async () => {
  const { host, root, text } = await hiddenText(true);
  expect(text).toContain(m.assignment_grades_hidden_note({ name: 'Kate' }));
  // Each question whole with its answer (Epo 2026-11-25), its worth in place
  // of a mark.
  expect(text).toContain('Name it');
  expect(
    [...host.querySelectorAll('input, textarea')].map(
      (field) => (field as HTMLInputElement).value
    )
  ).toContain('osmosis');
  expect(text).not.toContain('/ 2');
  act(() => root.unmount());
});

// Epo 2026-11-25: shown grades still wait while a mark does: being graded.
it('says it is being graded while a mark waits under shown grades', async () => {
  const { root, text } = await hiddenText(false);
  expect(text).toContain(m.assignment_being_graded_note());
  act(() => root.unmount());
});

// Epo 2026-11-22: every question drawn whole as the Questions tab draws it,
// nothing folding, each part's answer and marking where its answer would be.
it('draws a question whole with its answer and marking points', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const open = {
    answer: { accepted: [], type: 'open' },
    blocks: [{ text: 'Explain how water enters', type: 'text' }],
    id: 'p1',
    marks: 2,
    markscheme: [{ marks: 2, text: 'Names the membrane' }],
    pending: true,
    solution: [],
  };
  await act(async () =>
    root.render(
      <AttemptResults
        assignment={{ postedBy: 'Kate', workspaceId: 'ws1' } as Assignment}
        attempt={
          {
            ...attempt,
            answers: { p1: 'By osmosis' },
            gradesHidden: false,
            questions: [{ ...attempt.questions[0], parts: [open] }],
            showAnswers: true,
            userName: 'Ben',
            waitingMarks: 2,
          } as unknown as AssignmentAttempt
        }
      />
    )
  );
  // A member's view: staff's mark menus need a fuller DOM than this one.
  const text = host.textContent ?? '';
  expect(text).toContain('Explain how water enters');
  expect(text).toContain('By osmosis');
  expect(text).toContain(m.assignment_awarded());
  expect(text).toContain('Names the membrane');
  expect(text).toContain(`${m.assignment_not_marked()}– / 2`);
  expect(host.querySelector('[aria-expanded]')).toBeNull();
  act(() => root.unmount());
});

it('labels the parts of a question under its stem, each with its mark', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const marked = (id: string, text: string, awarded: number) => ({
    ...part(id),
    awarded,
    blocks: [{ text, type: 'text' }],
  });
  await act(async () =>
    root.render(
      <AttemptResults
        assignment={{ postedBy: 'Kate', workspaceId: 'ws1' } as Assignment}
        attempt={
          {
            ...attempt,
            answers: { a: 'osmosis', b: 'diffusion' },
            gradesHidden: false,
            questions: [
              {
                ...attempt.questions[0],
                parts: [
                  marked('a', 'First part', 2),
                  marked('b', 'Second part', 0),
                ],
                stem: [{ text: 'A shared stem', type: 'text' }],
              },
            ],
            showAnswers: true,
            userName: 'Ben',
          } as unknown as AssignmentAttempt
        }
      />
    )
  );
  // The question's own parts, not those of the answers' views inside them.
  const list = host.querySelector('article > div > ol');
  const parts = [...(list?.children ?? [])].map((li) => li.textContent ?? '');
  expect(host.querySelector('article header')?.textContent).toContain('2 / 4');
  expect(host.textContent).toContain('A shared stem');
  expect(parts).toHaveLength(2);
  expect(parts[0]).toContain('(a)');
  expect(parts[0]).toContain('First part');
  expect(parts[0]).toContain(`${m.practice_outcome_right()}2 / 2`);
  expect(parts[1]).toContain('(b)');
  expect(parts[1]).toContain(`${m.practice_outcome_wrong()}0 / 2`);
  act(() => root.unmount());
});

// Epo 2026-11-20 (mock QEetGvcmf2vvkVfqcYAKLz boards 6 and 7): a graded quiz
// from a file reads as a hand-in, its one question's comment as Feedback.
const paperAssignment = {
  files: [{ fileId: 'f1', kind: 'pdf', name: 'Cell structure.pdf' }],
  paperFile: true,
  postedBy: 'Kate',
  workspaceId: 'ws1',
} as unknown as Assignment;
const paperAttempt = {
  ...attempt,
  answers: {},
  correct: 31.5,
  gradesHidden: false,
  mark: 31.5,
  paperFiles: [
    {
      id: 'a1',
      kind: 'image',
      name: 'Cell answers.jpg',
      sizeBytes: 1000,
      status: 'ready',
    },
  ],
  questions: [
    {
      ...attempt.questions[0],
      comment: 'Good labelling',
      commentByName: 'Kate Malone',
      parts: [
        {
          answer: { type: 'open' },
          awarded: 31.5,
          blocks: [],
          id: 'p1',
          itemAwards: [31.5],
          marks: 40,
          markscheme: [{ marks: 40, text: 'Cell structure.pdf' }],
          solution: [],
        },
      ],
    },
  ],
  total: 40,
  userName: 'Ben',
} as unknown as AssignmentAttempt;

async function renderPaper(assignment: Assignment, shown: AssignmentAttempt) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AttemptResults assignment={assignment} attempt={shown} />
      </QueryClientProvider>
    )
  );
  return { host, root, text: host.textContent ?? '' };
}

// A member's: the comment under the numbers, then the paper and their work as
// the Files block's cards (Epo 2026-11-25, mock NgtaKfyZp9yk2uh9Ysxhhi).
it("shows a file quiz's member the feedback, their files and the paper, with no question row", async () => {
  const { root, text } = await renderPaper(paperAssignment, paperAttempt);
  expect(text).toContain('Kate Malone · Good labelling');
  expect(text).toContain(m.assignment_your_work());
  expect(text).toContain('Cell answers.jpg');
  expect(text).toContain('Cell structure.pdf');
  expect(text).not.toContain('Q1');
  act(() => root.unmount());
});

// Epo 2026-11-20 ("a file is not a quiz question"): staff read it as a
// hand-in too, its one mark and comment in Grade.
it("gives staff a file quiz's grade and answers, with no question row", async () => {
  const { root, text, host } = await renderPaper(
    { ...paperAssignment, manage: {} } as Assignment,
    paperAttempt
  );
  expect(text).toContain(m.assignment_col_grade());
  expect(text).toContain(m.assignment_answers());
  expect(text).toContain('Cell answers.jpg');
  expect(text).not.toContain('Q1');
  const comment = host.querySelector<HTMLInputElement>(
    `input[aria-label="${m.assignment_comment_for({ name: 'Ben' })}"]`
  );
  expect(comment?.value).toBe('Good labelling');
  const mark = host.querySelector<HTMLInputElement>(
    `input[aria-label="${m.assignment_grade_of({ name: 'Ben' })}"]`
  );
  expect(mark?.value).toBe('31.5');
  act(() => root.unmount());
});

it("shows a file quiz's files alone while grades wait for release", async () => {
  const { root, text } = await renderPaper(
    { ...paperAssignment, gradesHidden: true },
    { ...paperAttempt, gradesHidden: true }
  );
  expect(text).toContain(m.assignment_grades_hidden_note({ name: 'Kate' }));
  expect(text).toContain('Cell answers.jpg');
  expect(text).not.toContain('Good labelling');
  expect(text).not.toContain('Q1');
  act(() => root.unmount());
});
