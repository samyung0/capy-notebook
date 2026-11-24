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
  GradedQuizDialog: () => <div data-graded />,
  NewAssignmentDialog: () => <div data-form />,
}));

const { createRoot } = await import('react-dom/client');
const { NewAssignmentMenu } = await import('./NewAssignmentMenu');

const host = document.createElement('div');
document.body.append(host);
const show = async () => {
  const root = createRoot(host);
  await act(async () => root.render(<NewAssignmentMenu workspaceId="ws1" />));
  return root;
};
const press = (label: string) =>
  act(async () => {
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === label)
      ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });

it("offers a class's Assignment and Graded quiz", async () => {
  const root = await show();
  await press(m.assignment_kind_assignment());
  expect(host.querySelector('[data-form]')).not.toBeNull();
  await press(m.assignment_kind_marked());
  expect(host.querySelector('[data-graded]')).not.toBeNull();
  act(() => root.unmount());
});
