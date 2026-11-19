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
  useUpdateAssignment: idle,
  useWorkspaceMembers: () => ({ data: [] }),
}));
// The details' fields themselves are the dialog's, tested there.
vi.mock('./assignmentFields', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assignmentFields')>();
  const none = () => null;
  return {
    ...actual,
    AnswersSelect: none,
    AssignToField: none,
    AttemptsSelect: none,
    DateField: none,
    FilesField: none,
    GradesSelect: none,
    LatePenaltySelect: none,
    MarkingSelect: none,
    SwitchRow: none,
    TimeLimitSelect: none,
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('./NoAnswersWarning', () => ({ NoAnswersWarning: () => null }));

const { createRoot } = await import('react-dom/client');
const { AssignmentSettingsTab } = await import('./AssignmentSettingsTab');

const assignment = (manage: Partial<NonNullable<Assignment['manage']>>) =>
  ({
    attempts: 1,
    draft: false,
    files: [] as Assignment['files'],
    id: 'as1',
    kind: 'marked',
    manage: { quizId: 'qz1', quizTitle: 'Cells', ...manage },
    postedAt: '2026-11-01T09:00:00Z',
    workspaceId: 'ws1',
  }) as unknown as Assignment;

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

it('offers Republish with the quiz in place', async () => {
  await show(assignment({}));
  expect(host.textContent).toContain(m.assignment_republish());
});

// Epo 2026-11-15: a graded quiz's draft publishes from its header.
it("keeps a task draft's Publish on Settings", async () => {
  await show({
    ...assignment({}),
    draft: true,
    kind: 'unmarked',
  } as Assignment);
  expect(host.textContent).toContain(m.assignment_publish());
});

// Epo 2026-11-14: a class's Assignment takes Points, and graded, Show grades.
it('gives a graded Assignment its Points and Show grades, a task neither', async () => {
  const unmarked = {
    ...assignment({ assignees: [], showGrades: 'automatic' }),
    kind: 'unmarked',
    points: 20,
  } as Assignment;
  const points = `[aria-label="${m.assignment_field_points()}"]`;
  await show(unmarked);
  expect(host.querySelector<HTMLInputElement>(points)?.value).toBe('20');
  expect(host.textContent).toContain(m.assignment_field_grades());
  act(() => root.unmount());
  await show({ ...unmarked, own: true, points: undefined } as Assignment);
  expect(host.querySelector(points)).toBeNull();
  expect(host.textContent).not.toContain(m.assignment_field_grades());
});
