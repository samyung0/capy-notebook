import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Extraction } from '@/api/types';
import { m } from '@/i18n';
import { useRunStep } from './ExtractionProgress';

const read = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/api/hooks', () => ({
  useCancelExtraction: () => ({}),
  useConfirmExtraction: () => ({}),
  useExtraction: () => read.value,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const run = (over: Partial<Extraction>): Extraction => ({
  answered: 0,
  createdAt: '2026-11-05T10:00:00Z',
  id: 'ex_1',
  recorded: 3,
  status: 'running',
  title: 'Past paper',
  workspaceId: 'ws_1',
  ...over,
});
const noop = vi.fn();
function Step() {
  const { body, title } = useRunStep({
    onBack: noop,
    onConfirmed: noop,
    onDone: noop,
    onLeave: noop,
    runId: 'ex_1',
  });
  return (
    <>
      <h1>{title}</h1>
      {body}
    </>
  );
}
const page = () => renderToStaticMarkup(<Step />);

it('keeps following the run when a poll fails', () => {
  read.value = { data: run({}), error: new Error('down') };
  const html = page();
  expect(html).toContain(m.make_quiz_reading_title());
  expect(html).not.toContain('data-error-surface');
});

it('says a run it cannot read is missing', () => {
  read.value = { error: new Error('gone') };
  expect(page()).toContain('data-error-surface="page"');
});

it("gives a failed run's reason by its code, never its own text", () => {
  read.value = {
    data: run({
      error: 'The server restarted while the questions were being read.',
      errorCode: 'interrupted',
      status: 'failed',
    }),
  };
  const html = page();
  expect(html).toContain('data-error-kind="interrupted"');
  expect(html).toContain(m.make_quiz_failed_interrupted());
  expect(html).not.toContain('server restarted');
});
