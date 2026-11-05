import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Extraction } from '@/api/types';
import { m } from '@/i18n';
import { QuizRunRows } from './QuizRunRows';

const read = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/api/hooks', () => ({
  extractionQuery: () => ({ queryKey: ['x'] }),
  useExtraction: () => read.value,
}));
vi.mock('@/api/queryClient', () => ({ isMissing: () => false }));
vi.mock('@tanstack/react-query', () => ({
  useQueries: () => [read.value],
}));
// The server render reads a store's first state, so the run is the mock's.
vi.mock('./quizWaits', () => ({ openQuizWait: vi.fn() }));
vi.mock('./quizRuns', () => ({
  forgetQuizRun: vi.fn(),
  quizRunLinks: () => undefined,
  useQuizRuns: () => [
    { answers: [], id: 'ex_1', paper: ['p'], workspaceId: 'ws_1' },
  ],
}));

const run = (over: Partial<Extraction>): Extraction => ({
  answered: 0,
  confirmed: 12,
  createdAt: '2026-11-05T10:00:00Z',
  id: 'ex_1',
  recorded: 8,
  status: 'running',
  title: 'Past paper',
  workspaceId: 'ws_1',
  ...over,
});
const report = {
  expected: ['1'],
  figures: [],
  figuresLeftOut: [],
  missing: [],
  pages: 1,
  recorded: ['1', '2'],
  stopped: '' as const,
  windows: 1,
};
const rows = () => renderToStaticMarkup(<QuizRunRows waits={[]} />);

it('names the file a quiz stopped for and offers another try', () => {
  read.value = { data: run({}) };
  const html = renderToStaticMarkup(
    <QuizRunRows
      waits={[
        {
          answers: [],
          failures: [{ key: 'k', name: 'scan.pdf', reason: 'Not added' }],
          paper: [],
          status: 'failed',
          wait: {
            announced: false,
            answers: [],
            id: 'w',
            paper: [],
            title: 'Past paper',
            workspaceId: 'ws_1',
          },
        },
      ]}
    />
  );
  expect(html).toContain(m.make_quiz_panel_heading({ count: 2, done: 1 }));
  expect(html).toContain(
    m.source_import_file_error({ name: 'scan.pdf', reason: 'Not added' })
  );
  expect(html).toContain(m.make_quiz_try_again());
});

it('shows a running run with how far it has got', () => {
  read.value = { data: run({}) };
  const html = rows();
  expect(html).toContain(m.make_quiz_panel_heading({ count: 1, done: 0 }));
  expect(html).toContain(m.make_quiz_panel_copying({ count: 8, total: 12 }));
});

it('offers the quiz when it is done', () => {
  read.value = { data: run({ quizId: 'qz', report, status: 'done' }) };
  const html = rows();
  expect(html).toContain(m.make_quiz_panel_heading({ count: 1, done: 1 }));
  expect(html).toContain(m.make_quiz_panel_questions({ count: 2 }));
  expect(html).toContain(m.make_quiz_open_quiz());
});

it('says a done run with gaps may be incomplete', () => {
  read.value = {
    data: run({
      quizId: 'qz',
      report: { ...report, answersMissing: ['2'] },
      status: 'done',
    }),
  };
  expect(rows()).toContain(m.make_quiz_panel_incomplete());
});

it('offers another try when it failed, with no charge for the questions', () => {
  read.value = {
    data: run({ errorCode: 'extraction_empty', status: 'failed' }),
  };
  const html = rows();
  expect(html).toContain(m.make_quiz_try_again());
  expect(html).toContain(m.make_quiz_failed_empty().replaceAll("'", '&#x27;'));
});
