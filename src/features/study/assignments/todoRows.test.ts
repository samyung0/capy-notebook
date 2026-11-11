import { expect, it } from 'vitest';
import type { Assignment, TodoWorkspace } from '@/api/types';
import {
  doneSections,
  mergeTodoPages,
  type TodoView,
  todoCount,
  todoRows,
  todoSections,
} from './todoRows';

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

it('splits a class into open, done and answers waiting for whoever runs it', () => {
  const waiting = row('waiting', {
    manage: { toApprove: 2 } as Assignment['manage'],
    mine: undefined,
  });
  const done = row('done', { mine: { done: true } as Assignment['mine'] });
  const open = row('open');
  const items = [waiting, done, open, row('closed', { closedAt: 'x' })];
  expect(todoRows(items)).toEqual({
    approvedOff: [],
    done: [done],
    open: [open],
    toApprove: [waiting],
  });
});

it('lists a task with a quiz for its maker, and its answers waiting', () => {
  const task = row('task', {
    manage: { toApprove: 1 } as Assignment['manage'],
    own: true,
  });
  expect(todoRows([task])).toMatchObject({ open: [task], toApprove: [task] });
});

const view = (patch: Partial<TodoView> = {}): TodoView => ({
  ascending: true,
  sort: 'due',
  types: [],
  ...patch,
});
const ids = (sections: ReturnType<typeof todoSections>) =>
  sections.map((s) => s.workspace.workspaceId);
const rowIds = (section?: ReturnType<typeof todoSections>[number]) =>
  section?.rows.map((r) => r.a.id);

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
    view()
  );
  expect(ids(sections)).toEqual(['waiting', 'soon', 'later', 'no-due']);
});

// Epo 2026-11-10: done for them is done, closed or not: what's done or ticked
// off by hand leaves To do for Done.
it('lists answers waiting, then open rows, and leaves the ticked ones out', () => {
  const [section] = todoSections(
    [
      workspace(
        'a',
        [
          row('done', { mine: { done: true } as Assignment['mine'] }),
          row('quiz-ticked', {
            kind: 'marked',
            mine: { checkedOff: true, done: false } as Assignment['mine'],
          }),
          row('later', { dueAt: '2026-11-09T00:00:00Z' }),
          row('soon', { dueAt: '2026-11-03T00:00:00Z' }),
          row('waiting', {
            manage: { toApprove: 2 } as Assignment['manage'],
            mine: undefined,
          }),
          row('waiting-ticked', {
            manage: {
              approvalsCheckedOff: true,
              toApprove: 1,
            } as Assignment['manage'],
            mine: undefined,
          }),
        ],
        true
      ),
    ],
    view()
  );
  expect(rowIds(section)).toEqual(['waiting', 'soon', 'later']);
  expect(section?.open).toBe(3);
});

it('ticks a Done row finished or ticked off by hand', () => {
  const [section] = doneSections([
    {
      workspaces: [
        workspace('a', [
          row('handed-in', { mine: { done: true } as Assignment['mine'] }),
          row('by-hand', {
            mine: { checkedOff: true, done: false } as Assignment['mine'],
          }),
          row('closed', {
            closedAt: 'x',
            mine: { done: false } as Assignment['mine'],
          }),
        ]),
      ],
    },
  ]);
  expect(section?.rows.map((r) => r.ticked)).toEqual([true, true, false]);
});

it('sorts rows by title, and classes by name', () => {
  const classes = [
    workspace('Biology', [
      row('b', { title: 'Osmosis' }),
      row('a', { title: 'Cells' }),
    ]),
    workspace('Art', [row('c', { title: 'Colour' })]),
  ];
  const sections = todoSections(classes, view({ sort: 'title' }));
  expect(ids(sections)).toEqual(['Art', 'Biology']);
  expect(rowIds(sections[1])).toEqual(['a', 'b']);
  const reversed = todoSections(
    classes,
    view({ ascending: false, sort: 'title' })
  );
  expect(ids(reversed)).toEqual(['Biology', 'Art']);
  expect(rowIds(reversed[0])).toEqual(['b', 'a']);
});

it('keeps the tasks with no workspace first under either sort', () => {
  const classes = [
    workspace('Art', [row('a', { dueAt: '2026-11-01T00:00:00Z', title: 'A' })]),
    workspace('', [row('loose', { title: 'Z' })]),
  ];
  expect(ids(todoSections(classes, view()))).toEqual(['', 'Art']);
  expect(
    ids(todoSections(classes, view({ ascending: false, sort: 'title' })))
  ).toEqual(['', 'Art']);
});

it('moves answers staff ticked off down with the ticked rows', () => {
  const ticked = row('ticked', {
    manage: { approvalsCheckedOff: true, toApprove: 1 } as Assignment['manage'],
    mine: undefined,
  });
  expect(todoRows([ticked])).toMatchObject({
    approvedOff: [ticked],
    toApprove: [],
  });
  expect(todoCount([workspace('a', [ticked], true)])).toBe(0);
});

it('merges the Done pages, a class split across pages keeping its place', () => {
  const merged = mergeTodoPages([
    { workspaces: [workspace('a', [row('1')]), workspace('b', [row('2')])] },
    { workspaces: [workspace('a', [row('3')])] },
  ]);
  expect(merged.map((w) => w.workspaceId)).toEqual(['a', 'b']);
  expect(merged[0]?.items.map((a) => a.id)).toEqual(['1', '3']);
});

it('skips a Done row a later page repeats', () => {
  const merged = mergeTodoPages([
    { workspaces: [workspace('a', [row('1'), row('2')])] },
    { workspaces: [workspace('a', [row('2'), row('3')])] },
  ]);
  expect(merged[0]?.items.map((a) => a.id)).toEqual(['1', '2', '3']);
});

it('keeps the types the filter picks', () => {
  const classes = [
    workspace('a', [
      row('quiz', { kind: 'marked' }),
      row('task', { kind: 'unmarked' }),
    ]),
    workspace('b', [row('other', { kind: 'marked' })]),
  ];
  const sections = todoSections(classes, view({ types: ['task'] }));
  expect(ids(sections)).toEqual(['a']);
  expect(rowIds(sections[0])).toEqual(['task']);
});

it('counts open work and answers waiting for the nav dot', () => {
  const waiting = row('waiting', {
    manage: { toApprove: 3 } as Assignment['manage'],
    mine: undefined,
  });
  const done = row('done', { mine: { done: true } as Assignment['mine'] });
  expect(todoCount([workspace('a', [row('open'), done, waiting], true)])).toBe(
    2
  );
});
