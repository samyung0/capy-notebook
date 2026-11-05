import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Assignment } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const save = vi.hoisted(() => vi.fn());
const practice = vi.hoisted(() => ({
  quizzes: [] as { id: string; questions: number; title: string }[],
}));
vi.mock('@/api/hooks', () => ({
  useCreateAssignment: () => ({ isPending: false, mutate: save }),
  useFiles: () => ({ data: [] }),
  useMaterials: () => ({ data: [] }),
  useMe: () => ({ data: { id: 'owner' } }),
  usePractice: () => ({ data: practice, isPending: false }),
  useUpdateAssignment: () => ({ isPending: false, mutate: save }),
  useWorkspaceMembers: () => ({
    data: [
      { name: 'Ann', role: 'viewer', userId: 'ann' },
      { name: 'Me', role: 'owner', userId: 'owner' },
    ],
  }),
}));
// No portals: the phone header's button and the form's footer render in place.
const pass = ({ children }: { children?: ReactNode }) => children;
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: pass,
  DialogContent: pass,
  DialogFooter: pass,
  DialogTitle: ({
    action,
    children,
  }: {
    action?: ReactNode;
    children: ReactNode;
  }) => (
    <header>
      {children}
      {action}
    </header>
  ),
}));
vi.mock('@/components/ui/Select', () => ({
  Select: pass,
  SelectContent: pass,
  SelectItem: pass,
  SelectTrigger: pass,
  SelectValue: () => null,
}));
vi.mock('@/components/ui/Popover', () => ({
  Popover: pass,
  PopoverContent: pass,
  PopoverTrigger: pass,
}));
vi.mock('@/components/ui/Switch', () => ({ Switch: () => null }));
vi.mock('./NoAnswersWarning', () => ({ NoAnswersWarning: () => null }));

const { createRoot } = await import('react-dom/client');
const { NewAssignmentDialog } = await import('./NewAssignmentDialog');

const existing = {
  attempts: 1,
  draft: false,
  dueAt: '2026-12-01T10:00:00Z',
  files: [],
  id: 'as1',
  kind: 'marked',
  latePenaltyPct: 0,
  manage: {
    approveAiMarks: true,
    assignAll: false,
    // Left the workspace after this copy of the assignment was read.
    assignees: ['ann', 'gone'],
    quizId: 'qz1',
    quizTitle: 'Cells',
    showAnswers: true,
    shuffle: false,
  },
  noLate: false,
  title: 'Cells test',
} as unknown as Assignment;

const host = document.createElement('div');
document.body.append(host);
const show = async (
  value?: Assignment,
  newQuiz?: (how: 'blank' | 'file' | 'generate') => void
) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        existing={value}
        newQuiz={newQuiz}
        onClose={vi.fn()}
        onDone={vi.fn()}
        workspaceId="ws1"
      />
    )
  );
  return root;
};
const submitForm = () =>
  act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true })
      );
  });

beforeEach(() => {
  save.mockReset();
  practice.quizzes = [];
});

const searchBox = () =>
  host.querySelector(`[aria-label="${m.assignment_search_quizzes()}"]`);

it('asks for a quiz to be made when there are none, with no search', async () => {
  const root = await show();
  expect(host.textContent).toContain(m.assignment_make_quiz_to_begin());
  expect(searchBox()).toBeNull();
  await act(async () => root.unmount());
});

it('searches once there are quizzes', async () => {
  practice.quizzes = [{ id: 'q1', questions: 3, title: 'Cells' }];
  const root = await show();
  expect(host.textContent).not.toContain(m.assignment_make_quiz_to_begin());
  expect(searchBox()).not.toBeNull();
  await act(async () => root.unmount());
});

it('sends each maker row to its own dialog', async () => {
  const newQuiz = vi.fn();
  const root = await show(undefined, newQuiz);
  for (const [label, how] of [
    [m.assignment_new_quiz(), 'blank'],
    [m.dashboard_make_quiz(), 'file'],
    [m.assignment_generate_questions(), 'generate'],
  ]) {
    const row = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === label
    );
    await act(async () => {
      row?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(newQuiz).toHaveBeenLastCalledWith(how);
  }
  await act(async () => root.unmount());
});

it('sends the form once, whichever Create is pressed', async () => {
  const root = await show(existing);
  const form = host.querySelector('form');
  const buttons = [...host.querySelectorAll('button')].filter(
    (button) => button.textContent === m.action_save()
  );
  // Both submit the form, which is the one way a save goes out.
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.getAttribute('form')).toBe(form?.getAttribute('id'));
  }
  await act(async () => buttons[1]?.click());
  expect(save).not.toHaveBeenCalled();
  await submitForm();
  expect(save).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it('saves an edit without an assignee who has left', async () => {
  const root = await show(existing);
  await submitForm();
  expect(save.mock.calls[0][0].assignees).toEqual(['ann']);
  act(() => root.unmount());
});
