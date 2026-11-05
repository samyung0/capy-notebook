import { parseHTML } from 'linkedom';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Assignment } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const idle = () => ({ isPending: false, mutate: vi.fn() });
vi.mock('@/api/hooks', () => ({
  useDeleteAssignment: idle,
  usePublishAssignment: idle,
  useRepublishAssignment: idle,
  useSetAssignmentClosed: idle,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('./NewAssignmentDialog', () => ({ NewAssignmentDialog: () => null }));
vi.mock('./NoAnswersWarning', () => ({ NoAnswersWarning: () => null }));

const { createRoot } = await import('react-dom/client');
const { AssignmentSettingsTab } = await import('./AssignmentSettingsTab');

const assignment = (manage: Partial<NonNullable<Assignment['manage']>>) =>
  ({
    attempts: 1,
    draft: false,
    id: 'as1',
    kind: 'marked',
    manage: { quizId: 'qz1', quizTitle: 'Cells', ...manage },
    postedAt: '2026-11-01T09:00:00Z',
    workspaceId: 'ws1',
  }) as Assignment;

const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
const show = (value: Assignment) => {
  root = createRoot(host);
  return act(async () =>
    root.render(<AssignmentSettingsTab assignment={value} />)
  );
};
afterEach(() => act(() => root.unmount()));

it('offers Edit quiz and Republish with the quiz in place', async () => {
  await show(assignment({}));
  expect(host.textContent).toContain(m.assignment_edit_quiz());
  expect(host.textContent).toContain(m.assignment_settings_republish());
});

it('has neither once its quiz is in the trash', async () => {
  await show(assignment({ quizTrashed: true }));
  expect(host.textContent).not.toContain(m.assignment_edit_quiz());
  expect(host.textContent).not.toContain(m.assignment_settings_republish());
  expect(host.textContent).toContain(m.assignment_settings_details());
});
