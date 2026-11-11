import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { Assignment } from '@/api/types';
import { getLocale, m } from '@/i18n';

/* A task its maker opens inside its workspace ticks as the To do page does. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const tick = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useDeleteAssignment: () => ({ mutate: vi.fn() }),
  useTodoTick: () => ({ mutate: tick }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: ({
    confirmLabel,
    onConfirm,
  }: {
    confirmLabel: string;
    onConfirm: () => void;
  }) => (
    <button data-confirm onClick={onConfirm} type="button">
      {confirmLabel}
    </button>
  ),
  SimpleDialog: ({
    children,
    footer,
  }: {
    children: ReactNode;
    footer: ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock('./LazyNewAssignmentDialog', () => ({
  NewAssignmentDialog: () => null,
}));
vi.mock('./TodoSection', () => ({
  assignmentFileIcon: () => 'pdf',
  useOpenAssignment: () => vi.fn(),
}));

const { createRoot } = await import('react-dom/client');
const { OwnTaskDetails } = await import('./TodoDialog');

const task = (fields: Partial<Assignment>) =>
  ({
    files: [],
    mine: { done: false },
    own: true,
    postedAt: '2026-11-11T10:00:00Z',
    workspaceId: 'ws1',
    ...fields,
  }) as Assignment;

async function open(shown: Assignment) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <OwnTaskDetails
        onClose={vi.fn()}
        task={shown}
        workspace={{ iconId: 'i', id: 'ws1', name: 'Biology' }}
      />
    )
  );
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === m.assignment_mark_as_done())
      ?.click()
  );
  return { host, root };
}

it("ticks a task's quiz off To do after asking, where a plain task's tick is its done", async () => {
  const quiz = await open(
    task({ id: 'as1', kind: 'marked', marks: 3, questions: 3, title: 'Cells' })
  );
  expect(tick).not.toHaveBeenCalled();
  await act(async () =>
    (quiz.host.querySelector('[data-confirm]') as HTMLElement).click()
  );
  expect(tick).toHaveBeenLastCalledWith([
    { checked: true, id: 'as1', task: false, workspaceId: 'ws1' },
  ]);
  act(() => quiz.root.unmount());

  const plain = await open(
    task({ id: 'as2', kind: 'unmarked', title: 'Read chapter 4' })
  );
  expect(tick).toHaveBeenLastCalledWith([
    { checked: true, id: 'as2', task: true, workspaceId: 'ws1' },
  ]);
  act(() => plain.root.unmount());
});
