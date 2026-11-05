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
vi.mock('@/api/hooks', () => ({
  useCreateAssignment: () => ({ isPending: false, mutate: save }),
  useFiles: () => ({ data: [] }),
  useMaterials: () => ({ data: [] }),
  useMe: () => ({ data: { id: 'owner' } }),
  usePractice: () => ({ data: { quizzes: [] } }),
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
  PopoverContent: () => null,
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
const show = async (value?: Assignment) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NewAssignmentDialog
        existing={value}
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

beforeEach(() => save.mockReset());

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
