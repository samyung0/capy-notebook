import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Assignment, Workspace } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
// react-hook-form's setValue asks whether a field's ref is an HTMLElement.
Object.assign(globalThis, {
  document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
});

const save = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useCreateAssignment: () => ({ isPending: false, mutate: save }),
  useFiles: () => ({ data: [] }),
  useMaterials: () => ({ data: [] }),
  useMe: () => ({ data: { id: 'owner' } }),
  // The quiz New graded quiz's Questions step made.
  useQuiz: (id: string) => ({
    data: id
      ? {
          name: 'Mock paper',
          questions: [{ parts: [{ marks: 1 }] }, { parts: [{ marks: 2 }] }],
        }
      : undefined,
  }),
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
  DialogCancel: () => null,
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
// Each select's options, to pick one as its menu would.
const selects = vi.hoisted(() => new Map<string, (value: string) => void>());
vi.mock('@/components/ui/Select', () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children?: ReactNode;
    onValueChange?: (value: string) => void;
    value?: string;
  }) => {
    // Its trigger's label names it; the Workspace field is the first select.
    if (onValueChange && value !== undefined) selects.set(value, onValueChange);
    return <div data-value={value}>{children}</div>;
  },
  SelectContent: pass,
  SelectItem: pass,
  SelectTrigger: pass,
  SelectValue: () => null,
  selectTriggerVariants: () => '',
}));
vi.mock('./TaskFiles', () => ({
  ChooseFileRow: pass,
  TaskFilesField: () => <div data-task-files />,
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
    assignAll: false,
    // Left the workspace after this copy of the assignment was read.
    assignees: ['ann', 'gone'],
    marking: 'ai_approve',
    quizId: 'qz1',
    quizTitle: 'Cells',
    showAnswers: 'submitted',
    showGrades: 'automatic',
    shuffle: false,
  },
  noLate: false,
  title: 'Cells test',
} as unknown as Assignment;

const host = document.createElement('div');
document.body.append(host);
const show = async (value?: Assignment, onClose = vi.fn()) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        existing={value}
        onClose={onClose}
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
});

const row = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent === label
  );
const press = (button?: Element) =>
  act(async () => {
    button?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });

it('makes a new one an Assignment, with no Kind or Quiz field', async () => {
  const root = await show();
  expect(host.querySelector('[data-value="marked"]')).toBeNull();
  expect(
    host.querySelector(`[aria-label="${m.assignment_field_quiz()}"]`)
  ).toBeNull();
  expect(host.textContent).toContain(m.assignment_field_files());
  expect(host.querySelector('header')?.textContent).toContain(
    m.assignment_new()
  );
  act(() => root.unmount());
});

const graded = async (onBack = vi.fn(), own = false) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        graded={{ onBack, quizId: 'qz1', title: 'New graded quiz' }}
        onClose={vi.fn()}
        onDone={vi.fn()}
        own={own}
        workspaceId="ws1"
      />
    )
  );
  return root;
};

it("is New graded quiz's Settings step: its quiz's questions and marks, named after it", async () => {
  const onBack = vi.fn();
  const root = await graded(onBack);
  expect(host.textContent).toContain(m.practice_questions({ count: 2 }));
  expect(host.textContent).toContain(m.question_ui_marks({ count: '3' }));
  expect(
    host.querySelector<HTMLInputElement>(
      `[aria-label="${m.assignment_field_title()}"]`
    )?.value
  ).toBe('Mock paper');
  // When members see grades and answers sit beside Marking.
  const values = [...host.querySelectorAll('[data-value]')].map((select) =>
    select.getAttribute('data-value')
  );
  expect(values).toEqual(
    expect.arrayContaining(['none', '1', 'ai_approve', 'automatic', 'closed'])
  );
  await press(row(m.assignment_change_questions()));
  await press(row(m.action_back()));
  expect(onBack).toHaveBeenCalledTimes(2);
  // A graded quiz needs its due date before it is created.
  await submitForm();
  expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain(m.assignment_due_required());
  act(() => root.unmount());
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

it("assigns a member's work to them alone", async () => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        onClose={vi.fn()}
        onDone={vi.fn()}
        presetAssignee="ann"
        workspaceId="ws1"
      />
    )
  );
  expect(
    host.querySelector(`[aria-label="${m.assignment_field_assign_to()}"]`)
      ?.textContent
  ).toBe(m.workspace_members_one());
  act(() => root.unmount());
});

const assignField = () =>
  host.querySelector(`[aria-label="${m.assignment_field_assign_to()}"]`);
const pick = (from: string, to: string) =>
  act(async () => selects.get(from)?.(to));

it('saves a task for its maker alone, with its title, due date and files', async () => {
  const root = await show({
    dueAt: '2026-12-01T15:59:00Z',
    files: [{ fileId: 'f1', kind: 'pdf', name: 'Chapter 4' }],
    id: 'as1',
    kind: 'unmarked',
    noLate: false,
    own: true,
    title: 'Read chapter 4',
  } as unknown as Assignment);
  // Nothing about who it is for, files from anywhere, and no points.
  expect(assignField()).toBeNull();
  expect(host.querySelector('[data-task-files]')).not.toBeNull();
  expect(
    host.querySelector(`[aria-label="${m.assignment_field_points()}"]`)
  ).toBeNull();
  expect(host.querySelector('header')?.textContent).toContain(
    m.todo_edit_task()
  );
  await submitForm();
  expect(save.mock.calls[0][0]).toMatchObject({
    allowUploads: false,
    assignAll: false,
    assignees: ['owner'],
    draft: false,
    dueAt: '2026-12-01T15:59:00Z',
    files: [{ fileId: 'f1' }],
    kind: 'unmarked',
    title: 'Read chapter 4',
  });
  act(() => root.unmount());
});

it("gives a personal workspace's graded quiz every field but Assign to and a draft", async () => {
  const root = await graded(vi.fn(), true);
  expect(assignField()).toBeNull();
  expect(host.textContent).toContain(m.assignment_switch_shuffle());
  expect(host.textContent).not.toContain(m.assignment_switch_draft());
  act(() => root.unmount());
});

it('saves a task with a quiz for its maker alone', async () => {
  const root = await show({
    ...existing,
    attempts: 2,
    manage: { ...existing.manage, assignees: ['owner'], marking: 'manual' },
    own: true,
  } as Assignment);
  await submitForm();
  expect(save.mock.calls[0][0]).toMatchObject({
    assignAll: false,
    assignees: ['owner'],
    attempts: 2,
    kind: 'marked',
    marking: 'manual',
    quizId: 'qz1',
  });
  act(() => root.unmount());
});

it("follows To do's Workspace in place: a task with none, an assignment in a class the caller runs", async () => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        onClose={vi.fn()}
        onDone={vi.fn()}
        title="Add task"
        workspaceId=""
        workspaces={
          [
            { id: 'mine', kind: 'class', name: 'Mine', role: 'owner' },
            { id: 'joined', kind: 'class', name: 'Joined', role: 'viewer' },
          ] as unknown as Workspace[]
        }
      />
    )
  );
  const title = () =>
    host.querySelector<HTMLInputElement>(
      `[aria-label="${m.assignment_field_title()}"]`
    );
  // Opens as a task with no workspace: for nobody else, files from anywhere.
  expect(host.querySelector('[data-value="none"]')).not.toBeNull();
  expect(assignField()).toBeNull();
  expect(host.querySelector('[data-task-files]')).not.toBeNull();
  const form = host.querySelector('form');
  await pick('none', 'mine');
  // The same form, now an assignment's: who it is for, and the class's files.
  expect(host.querySelector('form')).toBe(form);
  expect(assignField()).not.toBeNull();
  expect(host.querySelector('[data-task-files]')).toBeNull();
  await pick('mine', 'joined');
  expect(assignField()).toBeNull();
  expect(host.querySelector('[data-task-files]')).not.toBeNull();
  expect(title()).not.toBeNull();
  act(() => root.unmount());
});

it('grades a class Assignment on points, with Show grades and the late penalty', async () => {
  const root = await show({
    ...existing,
    dueAt: '2026-12-01T10:00:00Z',
    kind: 'unmarked',
    latePenaltyPct: 20,
    manage: { ...existing.manage, assignees: ['ann'], showGrades: 'manual' },
    points: 20,
  } as Assignment);
  expect(
    host.querySelector<HTMLInputElement>(
      `[aria-label="${m.assignment_field_points()}"]`
    )?.value
  ).toBe('20');
  expect(host.textContent).toContain(m.assignment_field_grades());
  await submitForm();
  expect(save.mock.calls[0][0]).toMatchObject({
    kind: 'unmarked',
    latePenaltyPct: 20,
    points: 20,
    showGrades: 'manual',
  });
  act(() => root.unmount());
});
