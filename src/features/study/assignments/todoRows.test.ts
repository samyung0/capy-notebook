import { expect, it } from 'vitest';
import type { Assignment, TodoWorkspace } from '@/api/types';
import { todoRows, todoSections } from './todoRows';

const row = (id: string, patch: Partial<Assignment> = {}) =>
  ({
    draft: false,
    id,
    mine: { done: false },
    ...patch,
  }) as Assignment;
const workspace = (workspaceId: string, items: Assignment[], manages = false) =>
  ({
    iconId: '',
    items,
    manages,
    name: workspaceId,
    workspaceId,
  }) as TodoWorkspace;

it('splits a class into open, done and answers waiting for its staff', () => {
  const waiting = row('waiting', {
    manage: { toApprove: 2 } as Assignment['manage'],
    mine: undefined,
  });
  const done = row('done', { mine: { done: true } as Assignment['mine'] });
  const open = row('open');
  const items = [waiting, done, open, row('closed', { closedAt: 'x' })];
  expect(todoRows(items, true)).toEqual({
    done: [done],
    open: [open],
    toApprove: [waiting],
  });
  expect(todoRows(items, false).toApprove).toEqual([]);
});

it('orders sections by answers waiting, then the soonest due', () => {
  const sections = todoSections(
    [
      workspace('no-due', [row('a')]),
      workspace('later', [row('b', { dueAt: '2026-11-19T00:00:00Z' })]),
      workspace('soon', [row('c', { dueAt: '2026-11-05T00:00:00Z' })]),
      workspace(
        'waiting',
        [
          row('d', {
            manage: { toApprove: 1 } as Assignment['manage'],
            mine: undefined,
          }),
        ],
        true
      ),
    ],
    false
  );
  expect(sections.map((s) => s.workspace.workspaceId)).toEqual([
    'waiting',
    'soon',
    'later',
    'no-due',
  ]);
});

it('shows a class with only done work once Show done is on', () => {
  const finished = workspace('finished', [
    row('a', { mine: { done: true } as Assignment['mine'] }),
  ]);
  expect(todoSections([finished], false)).toEqual([]);
  expect(todoSections([finished], true)[0]?.shown).toHaveLength(1);
});
