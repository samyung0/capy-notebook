import { parseHTML } from 'linkedom';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';

/* A refresh that fails never takes a running attempt off the page, and an
   opening whose own read failed asks to retry rather than taking a cached copy. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const read = vi.hoisted(() => ({
  attempt: {} as Record<string, unknown>,
}));
vi.mock('@/api/hooks', () => ({
  useAssignment: () => ({ data: undefined }),
  useAssignmentAttempt: () => read.attempt,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
}));
vi.mock('./AssignmentTake', () => ({
  AssignmentTake: () => <p data-take />,
}));
vi.mock('./AssignmentSubmitted', () => ({ AssignmentSubmitted: () => null }));
vi.mock('./AttemptResults', () => ({ AttemptResults: () => null }));

const { createRoot } = await import('react-dom/client');
const { AssignmentAttemptPage } = await import('./AssignmentAttemptPage');

const running = { assignmentId: 'as1', status: 'running' };
const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot> | null = null;
const show = async (attempt: Record<string, unknown>) => {
  read.attempt = { isPending: false, refetch: vi.fn(), ...attempt };
  root ??= createRoot(host);
  await act(async () =>
    root?.render(<AssignmentAttemptPage attemptId="at1" workspaceId="ws1" />)
  );
};
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it('keeps a running attempt on the page when a refresh fails', async () => {
  await show({ data: running, isError: false, isFetchedAfterMount: true });
  expect(host.querySelector('[data-take]')).toBeTruthy();
  await show({
    data: running,
    error: new Error('down'),
    isError: true,
    isFetchedAfterMount: true,
  });
  expect(host.querySelector('[data-take]')).toBeTruthy();
});

it('asks to retry when this opening read nothing of a cached running attempt', async () => {
  await show({
    data: running,
    error: new Error('down'),
    isError: true,
    isFetchedAfterMount: true,
  });
  expect(host.querySelector('[data-take]')).toBeNull();
  expect(host.textContent).toContain(m.assignment_load_failed());
  expect(host.textContent).toContain(m.action_retry());
});
