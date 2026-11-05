import { parseHTML } from 'linkedom';
import { act } from 'react';
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
const closedListeners = vi.hoisted(() => new Set<(id: string) => void>());
vi.mock('@/api/hooks', () => ({
  onAssignmentClosed: (listener: (id: string) => void) => {
    closedListeners.add(listener);
    return () => closedListeners.delete(listener);
  },
  saveAssignmentAnswers: api.save,
  useSubmitAssignmentAttempt: () => ({ isPending: false, mutate: api.submit }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
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
    root.render(<AssignmentTake attempt={value} workspaceId="ws1" />)
  );
};
const typeAnswer = () =>
  act(async () =>
    host.querySelector<HTMLButtonElement>('[data-type]')?.click()
  );
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

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

// Epo 2026-11-05: staff closing the assignment ends the attempt open on the page,
// with what is on the page, and no other assignment's closing does.
it('submits what is on the page when its assignment closes', async () => {
  await show(attempt());
  await typeAnswer();
  const close = (id: string) =>
    act(async () => {
      for (const listener of closedListeners) listener(id);
    });
  await close('as_other');
  expect(api.submit).not.toHaveBeenCalled();
  await close('as1');
  await close('as1');
  expect(api.submit).toHaveBeenCalledTimes(1);
  expect(api.submit.mock.calls[0][0]).toEqual({
    answers: { p1: 'typed' },
    id: 'at1',
  });
});
