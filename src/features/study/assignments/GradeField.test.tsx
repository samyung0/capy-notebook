import { parseHTML } from 'linkedom';
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Assignment, AssignmentMemberRow } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, {
  document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
});
// React reads `oninput` on the document to know input events exist.
Object.assign(document, { oninput: null });

const grade = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useSetAssignmentGrade: () => ({ isPending: false, mutate: grade }),
}));

const { createRoot } = await import('react-dom/client');
const { GradeField } = await import('./GradeField');

const assignment = {
  id: 'as1',
  kind: 'unmarked',
  points: 20,
  workspaceId: 'ws1',
} as Assignment & { points: number };
const member = { name: 'Ann', userId: 'ann' } as AssignmentMemberRow;

const host = document.createElement('div');
document.body.append(host);
const enter = async (value: string) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(<GradeField assignment={assignment} member={member} />)
  );
  const field = host.querySelector('input') as HTMLInputElement;
  const proto = (
    window as unknown as { HTMLInputElement: { prototype: object } }
  ).HTMLInputElement.prototype;
  await act(async () => {
    // Past React's own value tracker, as typing would be.
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    field.dispatchEvent(new window.Event('focusout', { bubbles: true }));
  });
  return root;
};

beforeEach(() => grade.mockReset());

// Epo 2026-11-14: staff grade a member out of the points, in half points.
it('saves a grade on leaving the field', async () => {
  const root = await enter('7.5');
  await vi.waitFor(() =>
    expect(grade).toHaveBeenCalledWith(
      { points: 7.5, userId: 'ann' },
      expect.anything()
    )
  );
  act(() => root.unmount());
});

it('refuses a grade above the points', async () => {
  const root = await enter('25');
  await vi.waitFor(() =>
    expect(host.textContent).toContain(m.assignment_grade_max({ points: '20' }))
  );
  expect(grade).not.toHaveBeenCalled();
  act(() => root.unmount());
});
