import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

// The menu's items as plain buttons, as its dropdown would offer them.
vi.mock('@/components/ui/Menu', () => ({
  Menu: ({
    items,
    trigger,
  }: {
    items: { label: string; onClick: () => void }[];
    trigger: ReactNode;
  }) => (
    <>
      {trigger}
      {items.map((item) => (
        <button key={item.label} onClick={item.onClick} type="button">
          {item.label}
        </button>
      ))}
    </>
  ),
}));
vi.mock('./LazyNewAssignmentDialog', () => ({
  GradedQuizDialog: ({ own }: { own?: boolean }) => (
    <div data-graded={String(!!own)} />
  ),
  NewAssignmentDialog: ({ own, title }: { own?: boolean; title?: string }) => (
    <div data-form={String(!!own)} data-title={title ?? ''} />
  ),
}));

const { createRoot } = await import('react-dom/client');
const { NewAssignmentMenu } = await import('./NewAssignmentMenu');

const host = document.createElement('div');
document.body.append(host);
const show = async (own: boolean) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(<NewAssignmentMenu own={own} workspaceId="ws1" />)
  );
  return root;
};
const press = (label: string) =>
  act(async () => {
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === label)
      ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });

it("offers a class's Assignment and Graded quiz", async () => {
  const root = await show(false);
  await press(m.assignment_kind_assignment());
  expect(host.querySelector('[data-form="false"]')).not.toBeNull();
  await press(m.assignment_kind_marked());
  expect(host.querySelector('[data-graded="false"]')).not.toBeNull();
  act(() => root.unmount());
});

it("offers a personal workspace's Task and Graded quiz, both for oneself", async () => {
  const root = await show(true);
  expect(host.textContent).not.toContain(m.assignment_kind_assignment());
  await press(m.assignment_kind_task());
  expect(
    host.querySelector('[data-form="true"]')?.getAttribute('data-title')
  ).toBe(m.todo_new_task());
  await press(m.assignment_kind_marked());
  expect(host.querySelector('[data-graded="true"]')).not.toBeNull();
  act(() => root.unmount());
});
