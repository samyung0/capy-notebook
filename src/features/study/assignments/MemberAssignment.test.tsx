import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Assignment } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const start = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useSetAssignmentDone: () => ({ isPending: false, mutate: vi.fn() }),
  useStartAssignment: () => ({ isPending: false, mutate: start }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
  useNavigate: () => navigate,
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));

const { createRoot } = await import('react-dom/client');
const { MemberAssignment } = await import('./MemberAssignment');

const assignment = {
  id: 'as1',
  kind: 'marked',
  title: 'Cells test',
  workspaceId: 'ws1',
} as Assignment;

it('leaves a way back and Start after a start that failed', async () => {
  start.mockImplementation(
    (_id: string, options: { onError: (error: Error) => void }) =>
      options.onError(new Error('down'))
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<MemberAssignment assignment={assignment} />)
  );
  expect(start).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(m.study_panel_assignments());
  expect(host.textContent).toContain('Cells test');
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === m.assignment_start()
  );
  await act(async () => button?.click());
  expect(start).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});

it('opens the attempt once the assignment reads it, though the start never called back', async () => {
  start.mockReset();
  navigate.mockReset();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<MemberAssignment assignment={assignment} />)
  );
  expect(start).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
  const started = {
    ...assignment,
    mine: { runningAttemptId: 'at1' },
  } as Assignment;
  await act(async () => root.render(<MemberAssignment assignment={started} />));
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      search: expect.objectContaining({ assignment: 'as1', attempt: 'at1' }),
    })
  );
  expect(start).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
