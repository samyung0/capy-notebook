import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { StudyQuestion, SummaryTopic } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const state = vi.hoisted(() => ({
  questions: [] as StudyQuestion[],
}));
const topic: SummaryTopic = {
  asked: 3,
  group: 'topic',
  label: 'needs_practice',
  name: 'Osmosis',
  partial: 1,
  right: 1,
  topicId: 't1',
  unattempted: 1,
  wrong: 1,
};
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
const kept = {
  answers: { p: 'osmosis' },
  at: '2026-11-20T10:00:00Z',
  question: { id: 'q3', labels: {}, layout: 'stack', parts: [], stem: [] },
};
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryClient: () => ({}),
}));
vi.mock('@/api/hooks', () => ({
  invalidateStudy: vi.fn(),
  useMemberAnswer: () => ({ data: kept, isError: false, isPending: false }),
  useMemberProfile: () => ({
    data: { name: 'Cara Moss', topics: [topic] },
  }),
  useStudyQuestions: () => ({
    data: { questions: state.questions },
    isError: false,
    isPending: false,
  }),
  useStudyTopics: () => ({ data: { topics: [topic] } }),
}));
// In place of the portal and the runner: the dialog's title and the item.
vi.mock('@/components/ui/Dialog', () => ({
  SimpleDialog: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: ReactNode;
  }) => (
    <div data-dialog>
      {title}
      {children}
    </div>
  ),
}));
vi.mock('@/components/app/ListToolbar', () => ({
  ListToolbar: () => null,
  toggleValue: vi.fn(),
}));
// The member's answer as their graded quiz result shows it: the list layout.
vi.mock('@/features/quizzes/QuestionRunner', () => ({
  QuestionRunner: ({
    layout,
    question,
  }: {
    layout?: string;
    question: { id: string };
  }) => <div data-layout={layout} data-runner={question.id} />,
}));
vi.mock('../ReviewQuestion', () => ({
  CheckedQuestion: () => null,
  QuestionItem: ({ item }: { item: { itemId: string } }) => (
    <div data-item={item.itemId} />
  ),
}));

const { createRoot } = await import('react-dom/client');
const { TopicQuestionsPage } = await import('./TopicQuestions');

const question = (
  questionId: string,
  result: StudyQuestion['result'],
  misses = 0
): StudyQuestion => ({
  group: 'topic',
  materialId: 'qz',
  materialTitle: 'Osmosis check',
  misses,
  question: {
    id: questionId,
    labels: {},
    layout: 'stack',
    parts: [],
    stem: [],
  } as never,
  questionId,
  result,
  text: `Question ${questionId}`,
  topicId: 't1',
  topicName: 'Osmosis',
  ...(result === 'unattempted' ? {} : { at: '2026-11-20T10:00:00Z' }),
});

const host = document.createElement('div');
document.body.append(host);
const show = async (memberId?: string) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <TopicQuestionsPage memberId={memberId} topic="t1" workspaceId="ws" />
    )
  );
  return root;
};
const rowTexts = () =>
  [...host.querySelectorAll('li')].map(
    (li) => li.querySelector('.line-clamp-2')?.textContent
  );

beforeEach(() => {
  state.questions = [
    question('q1', 'right'),
    question('q2', 'unattempted'),
    question('q3', 'wrong', 2),
    question('q4', 'partial', 1),
  ];
});

it('lists the most missed first and practises a row in place in the list', async () => {
  const root = await show();
  expect(host.querySelector('h1')?.textContent).toBe('Osmosis');
  expect(rowTexts()).toEqual([
    'Question q3',
    'Question q4',
    'Question q2',
    'Question q1',
  ]);
  const rows = host.querySelectorAll<HTMLButtonElement>('li button');
  await act(async () => rows[1].click());
  expect(host.querySelector('[data-item]')?.getAttribute('data-item')).toBe(
    'q4'
  );
  expect(host.querySelector('[data-dialog]')?.textContent).toContain(
    m.practice_position({ position: 2, total: 4 })
  );
  act(() => root.unmount());
});

it("opens a member's answered question for staff with their latest answer", async () => {
  // The member read comes without question content.
  state.questions = state.questions.map(({ question: _, ...q }) => q);
  const root = await show('u1');
  expect(host.textContent).toContain('Cara Moss');
  expect(host.querySelectorAll('li').length).toBe(4);
  // The three answered rows open; the one not tried has nothing to show.
  const rows = host.querySelectorAll<HTMLButtonElement>('li button');
  expect(rows.length).toBe(3);
  await act(async () => rows[0].click());
  const runner = host.querySelector('[data-runner]');
  expect(runner?.getAttribute('data-runner')).toBe('q3');
  expect(runner?.getAttribute('data-layout')).toBe('list');
  expect(host.querySelector('[data-dialog]')?.textContent).toContain(
    m.topic_questions_open_quiz({ title: 'Osmosis check' })
  );
  act(() => root.unmount());
});
