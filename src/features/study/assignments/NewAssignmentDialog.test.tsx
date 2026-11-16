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
const practice = vi.hoisted(() => ({
  failed: false,
  quizzes: [] as { id: string; questions: number; title: string }[],
}));
const navigate = vi.hoisted(() => vi.fn());
const frozen = vi.hoisted(() => ({ value: false }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@/features/workspace/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/workspace/access')>()),
  isWorkspaceReadOnly: () => frozen.value,
}));
vi.mock('../practice/MakePractice', () => ({
  MakePractice: ({ initialTopicId }: { initialTopicId?: string }) => (
    <div data-make-practice={initialTopicId ?? ''} />
  ),
}));
vi.mock('@/api/hooks', () => ({
  useCreateAssignment: () => ({ isPending: false, mutate: save }),
  useFiles: () => ({ data: [] }),
  useMaterials: () => ({ data: [] }),
  useMe: () => ({ data: { id: 'owner' } }),
  usePractice: () => ({
    data: { quizzes: practice.quizzes },
    isError: practice.failed,
    isPending: false,
    refetch: vi.fn(),
  }),
  useUpdateAssignment: () => ({ isPending: false, mutate: save }),
  useWorkspace: () => ({ data: {} }),
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
}));
vi.mock('./TaskFiles', () => ({
  TaskFileMenu: ({
    kinds,
    onPick,
    trigger,
  }: {
    kinds?: string[];
    onPick: (file: { id: string; name: string }) => void;
    trigger: ReactNode;
  }) => (
    <>
      {trigger}
      <button
        data-picker={kinds?.join()}
        onClick={() => onPick({ id: 'qz9', name: 'Mock paper' })}
        type="button"
      />
    </>
  ),
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
  navigate.mockReset();
  frozen.value = false;
  practice.failed = false;
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

const row = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent === label
  );
const press = (button?: Element) =>
  act(async () => {
    button?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });

it('closes for New quiz and Make a quiz, which open by link', async () => {
  const onClose = vi.fn();
  const root = await show(undefined, onClose);
  await press(row(m.dashboard_make_quiz()));
  expect(onClose).toHaveBeenCalledTimes(1);
  const makeSearch = navigate.mock.lastCall?.[0].search;
  expect(makeSearch({ study: 'assignments' })).toEqual({
    make: 'files',
    makeFrom: 'assignments',
  });
  expect(makeSearch({})).toEqual({ make: 'files', makeFrom: undefined });
  await press(row(m.assignment_new_quiz()));
  const { search } = navigate.mock.lastCall?.[0] ?? {};
  expect(search({ study: 'assignments' })).toEqual({
    add: 'create',
    newFromQuiz: undefined,
    study: 'assignments',
  });
  await act(async () => root.unmount());
});

it('gives way to the generate dialog', async () => {
  const onClose = vi.fn();
  const root = await show(undefined, onClose);
  await press(row(m.assignment_generate_questions()));
  expect(host.querySelector('[data-make-practice]')).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('offers no way to make a quiz in a frozen workspace', async () => {
  frozen.value = true;
  const root = await show();
  expect(row(m.assignment_new_quiz())).toBeUndefined();
  expect(host.textContent).toContain(m.assignment_no_quizzes());
  await act(async () => root.unmount());
});

it('says a list it could not read failed, not that there are no quizzes', async () => {
  practice.failed = true;
  const root = await show();
  expect(host.textContent).toContain(m.assignment_quizzes_failed());
  expect(host.textContent).not.toContain(m.assignment_make_quiz_to_begin());
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

it('shows grades automatically and answers after it closes by default', async () => {
  const root = await show();
  const values = [...host.querySelectorAll('[data-value]')].map((select) =>
    select.getAttribute('data-value')
  );
  expect(values).toContain('automatic');
  expect(values).toContain('closed');
  act(() => root.unmount());
});

it("assigns a member's practice to them alone, generating on their topic", async () => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        onClose={vi.fn()}
        onDone={vi.fn()}
        presetAssignee="ann"
        presetTopicId="t1"
        workspaceId="ws1"
      />
    )
  );
  expect(
    host.querySelector(`[aria-label="${m.assignment_field_assign_to()}"]`)
      ?.textContent
  ).toBe(m.workspace_members_one());
  await press(row(m.assignment_generate_questions()));
  expect(
    host
      .querySelector('[data-make-practice]')
      ?.getAttribute('data-make-practice')
  ).toBe('t1');
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
  // Nothing about who it is for, and files from anywhere.
  expect(assignField()).toBeNull();
  expect(host.querySelector('[data-task-files]')).not.toBeNull();
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

it('gives a task every field but Assign to and a draft, with a quiz from anywhere', async () => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        onClose={vi.fn()}
        onDone={vi.fn()}
        own
        workspaceId=""
      />
    )
  );
  // It starts plain, then takes a quiz.
  expect(host.querySelector('[data-value="unmarked"]')).not.toBeNull();
  await pick('unmarked', 'marked');
  const values = [...host.querySelectorAll('[data-value]')].map((select) =>
    select.getAttribute('data-value')
  );
  // Time limit, attempts, marking, grades and answers.
  expect(values).toEqual(
    expect.arrayContaining(['none', '1', 'ai_approve', 'automatic', 'closed'])
  );
  expect(assignField()).toBeNull();
  expect(host.textContent).toContain(m.assignment_switch_shuffle());
  expect(host.textContent).not.toContain(m.assignment_switch_draft());
  // Its quiz comes from the picker over every quiz, not this workspace's list.
  expect(searchBox()).toBeNull();
  await press(
    host.querySelector(`button[aria-label="${m.assignment_field_quiz()}"]`) ??
      undefined
  );
  await press(host.querySelector('[data-picker="quiz"]') ?? undefined);
  expect(
    host.querySelector(`button[aria-label="${m.assignment_field_quiz()}"]`)
      ?.textContent
  ).toContain('Mock paper');
  // A quiz needs its due date, as an assignment's does.
  await submitForm();
  expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain(m.assignment_due_required());
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
