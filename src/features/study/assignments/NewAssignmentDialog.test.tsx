import { parseHTML } from 'linkedom';
import { act, type ReactNode, useEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Assignment, Workspace } from '@/api/types';
import { getLocale, m } from '@/i18n';
import type { GradedSource } from './gradedSource';

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
// React reads `oninput` on the document to know input events exist.
Object.assign(document, { oninput: null });

const save = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useCreateAssignment: () => ({ isPending: false, mutate: save }),
  useFiles: () => ({ data: [] }),
  useMaterials: () => ({ data: [] }),
  useMe: () => ({ data: { id: 'owner' } }),
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
// A quiz's questions as members would get them: 2 marks and 3.
vi.mock('@/features/quizzes/liveQuizReads', () => ({
  useQuizFileQuestions: (quizId: string) =>
    quizId === 'qz1'
      ? [{ parts: [{ marks: 2 }] }, { parts: [{ marks: 1 }, { marks: 2 }] }]
      : undefined,
}));

const { createRoot } = await import('react-dom/client');
const { NewAssignmentDialog, useAssignmentForm } = await import(
  './NewAssignmentDialog'
);

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

/** New graded quiz's Settings, its last step, once the first picked `source`. */
function GradedSettings({
  own,
  source,
}: {
  own?: boolean;
  source: GradedSource;
}) {
  const { button, fields, form, pick } = useAssignmentForm({
    graded: true,
    own,
    workspaceId: 'ws1',
  });
  useEffect(() => pick(source), []);
  return (
    <>
      {button}
      <form {...form}>{fields}</form>
    </>
  );
}
const graded = async (source: Partial<GradedSource> = {}, own = false) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <GradedSettings
        own={own}
        source={{ name: 'Osmosis practice', send: vi.fn(), ...source }}
      />
    )
  );
  return root;
};
/** Types into a field as a person would, so React sees the change. */
const type = (label: string, value: string) =>
  act(async () => {
    const input = host.querySelector(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`no ${label} field`);
    // A browser's input with no type is a text one; linkedom's has none.
    if (!input.getAttribute('type')) input.setAttribute('type', 'text');
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

// Epo 2026-11-20: Settings comes after the questions, starting on their name;
// Create sends the pick with the settings, AI-made questions as a draft.
it("starts New graded quiz's Settings on the pick's name, and sends the pick with them", async () => {
  const send = vi.fn<GradedSource['send']>(() => Promise.resolve());
  const root = await graded({ draft: true, send });
  expect(
    host
      .querySelector(`input[aria-label="${m.assignment_field_title()}"]`)
      ?.getAttribute('value')
  ).toBe('Osmosis practice');
  expect(host.textContent).toContain(m.assignment_create_draft());
  await type(m.assignment_field_due(), '2026-11-27T09:00');
  await submitForm();
  expect(save).not.toHaveBeenCalled();
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    draft: true,
    kind: 'marked',
    title: 'Osmosis practice',
  });
  act(() => root.unmount());
});

// Epo 2026-11-20: a file's Points (its total) moved to Settings; it is marked
// by hand and answered by upload, as its Settings tab shows them.
it("asks a file's Settings for its Points, marked by hand and answered by upload", async () => {
  const send = vi.fn<GradedSource['send']>(() => Promise.resolve());
  const root = await graded({ file: true, name: 'Past paper', send });
  await type(m.assignment_field_due(), '2026-11-27T09:00');
  await submitForm();
  expect(send).not.toHaveBeenCalled();
  expect(host.textContent).toContain(m.assignment_total_required());
  await type(m.assignment_field_points(), '40');
  await submitForm();
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    allowUploads: true,
    marking: 'manual',
    title: 'Past paper',
    totalMarks: 40,
    uploadOnly: true,
  });
  act(() => root.unmount());
});

// Epo 2026-11-20: a quiz's Points are its questions' marks, shown fixed.
it("shows a quiz's Points from its questions, fixed", async () => {
  const send = vi.fn<GradedSource['send']>(() => Promise.resolve());
  const root = await graded({ name: 'Cells', quizId: 'qz1', send });
  const points = host.querySelector<HTMLInputElement>(
    `input[aria-label="${m.assignment_field_points()}"]`
  );
  expect(points?.value).toBe('5');
  expect(points?.disabled).toBe(true);
  await type(m.assignment_field_due(), '2026-11-27T09:00');
  await submitForm();
  expect(send.mock.calls[0]?.[0]).toMatchObject({ title: 'Cells' });
  expect(send.mock.calls[0]?.[0].totalMarks).toBeUndefined();
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
  const root = await graded({}, true);
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
