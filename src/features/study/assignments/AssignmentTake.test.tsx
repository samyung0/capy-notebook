import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssignmentAttempt } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const api = vi.hoisted(() => ({
  save: vi.fn(),
  submit: vi.fn(),
}));
type AssignmentEvent = { assignmentId: string; type: string };
const listeners = vi.hoisted(() => new Set<(event: AssignmentEvent) => void>());
const closed = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  onAssignmentEvent: (listener: (event: AssignmentEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  saveAssignmentAnswers: api.save,
  useSubmitAssignmentAttempt: () => ({ isPending: false, mutate: api.submit }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: invalidate }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: toast }));
// No portals: the confirm dialog renders in place.
const pass = ({ children }: { children?: ReactNode }) => children;
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: pass,
  DialogContent: pass,
  DialogFooter: pass,
  DialogTitle: pass,
}));
vi.mock('@/features/quizzes/QuestionRunner', () => ({
  QuestionRunner: ({
    onChange,
  }: {
    onChange: (part: string, value: string) => void;
  }) => (
    <button data-type onClick={() => onChange('p1', 'typed')} type="button">
      type
    </button>
  ),
}));

const { createRoot } = await import('react-dom/client');
const { AssignmentTake } = await import('./AssignmentTake');

const attempt = (over: Partial<AssignmentAttempt> = {}) =>
  ({
    answers: {},
    assignmentId: 'as1',
    id: 'at1',
    now: new Date().toISOString(),
    questions: [
      {
        id: 'q1',
        labels: 'letters',
        layout: 'paper',
        parts: [
          {
            answer: { type: 'short' },
            blocks: [{ text: 'Say', type: 'text' }],
            id: 'p1',
            marks: 1,
          },
        ],
        stem: [],
      },
    ],
    removedAssetIds: [],
    title: 'Test',
    ...over,
  }) as AssignmentAttempt;

const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
const show = (value: AssignmentAttempt) => {
  root = createRoot(host);
  return act(async () =>
    root.render(
      <AssignmentTake attempt={value} onClosed={closed} workspaceId="ws1" />
    )
  );
};
const typeAnswer = () =>
  act(async () =>
    host.querySelector<HTMLButtonElement>('[data-type]')?.click()
  );
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
const hear = (assignmentId: string, type: string) =>
  act(async () => {
    for (const listener of listeners) listener({ assignmentId, type });
  });

beforeEach(() => {
  vi.useFakeTimers();
  api.save.mockReset();
  api.submit.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it('saves again once a save that a change came during ends', async () => {
  let finish = () => {};
  api.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  api.save.mockResolvedValue(undefined);
  await show(attempt());
  await typeAnswer();
  await wait(2000);
  expect(api.save).toHaveBeenCalledTimes(1);
  // The second change's own wait ends while the first save is out.
  await typeAnswer();
  await wait(2000);
  expect(api.save).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(api.save).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain(m.assignment_saved());
});

it('leaves Submit to press after the submit at zero failed', async () => {
  api.submit.mockImplementation(
    (_body: unknown, options: { onError: (error: Error) => void }) =>
      options.onError(new Error('down'))
  );
  const now = new Date();
  await show(
    attempt({
      deadlineAt: new Date(now.getTime() - 1000).toISOString(),
      now: now.toISOString(),
    })
  );
  expect(api.submit).toHaveBeenCalledTimes(1);
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === m.assignment_submit()
  );
  expect(button?.hasAttribute('disabled')).toBe(false);
});

it('keeps the confirm dialog open with a refused submit', async () => {
  toast.mockClear();
  api.submit.mockImplementation(
    (_body: unknown, options: { onError: (error: Error) => void }) =>
      options.onError(new Error('down'))
  );
  await show(attempt({}));
  const named = () =>
    [...document.querySelectorAll('button')].filter(
      (item) => item.textContent === m.assignment_submit()
    );
  await act(async () => named()[0]?.click());
  await act(async () => named().at(-1)?.click());
  expect(api.submit).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    m.assignment_submit_failed_body()
  );
  expect(toast).not.toHaveBeenCalled();
  expect(named().at(-1)?.hasAttribute('disabled')).toBe(false);
});

// Epo 2026-11-05: staff closing the assignment ends the attempt open on the page,
// with what is on the page, and no other assignment's closing does.
it('submits what is on the page when its assignment closes', async () => {
  await show(attempt());
  await typeAnswer();
  const close = (id: string) => hear(id, 'assignment_closed');
  await close('as_other');
  expect(api.submit).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  await close('as1');
  expect(closed).toHaveBeenCalled();
  await close('as1');
  expect(api.submit).toHaveBeenCalledTimes(1);
  expect(api.submit.mock.calls[0][0]).toEqual({
    answers: { p1: 'typed' },
    id: 'at1',
  });
});

// Epo 2026-11-05: Republish reaches the open page, which reads the new questions
// and lets go of what no longer fits.
it('rereads when republished, and drops an answer whose option moved', async () => {
  const mcq = (options: string[]) =>
    attempt({
      answers: { p1: [1] },
      questions: [
        {
          id: 'q1',
          labels: 'letters',
          layout: 'paper',
          parts: [
            {
              answer: { options, type: 'mcq' },
              blocks: [{ text: 'Pick', type: 'text' }],
              id: 'p1',
              marks: 1,
            },
          ],
          stem: [],
        },
      ],
    } as Partial<AssignmentAttempt>);
  api.save.mockResolvedValue(undefined);
  await show(mcq(['a', 'b']));
  invalidate.mockClear();
  await hear('as_other', 'assignment_republished');
  expect(invalidate).not.toHaveBeenCalled();
  await hear('as1', 'assignment_republished');
  expect(invalidate).toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith({
    title: m.assignment_questions_updated(),
  });
  expect(api.submit).not.toHaveBeenCalled();

  await act(async () =>
    root.render(
      <AssignmentTake
        attempt={mcq(['b', 'a'])}
        onClosed={closed}
        workspaceId="ws1"
      />
    )
  );
  await wait(5000);
  expect(api.save).toHaveBeenLastCalledWith('at1', {});
});
