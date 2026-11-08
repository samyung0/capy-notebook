import { expect, it } from 'vitest';
import type { Assignment, TodoWorkspace } from '@/api/types';
import { type TodoView, todoCount, todoRows, todoSections } from './todoRows';

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

const view = (patch: Partial<TodoView> = {}): TodoView => ({
  classes: [],
  reversed: false,
  sort: 'due',
  tab: 'todo',
  types: [],
  ...patch,
});
const ids = (sections: ReturnType<typeof todoSections>) =>
  sections.map((s) => s.workspace.workspaceId);

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

it('sorts rows and classes by the newest post, and classes by name', () => {
  const classes = [
    workspace('Biology', [
      row('old', { postedAt: '2026-11-01T00:00:00Z' }),
      row('new', { postedAt: '2026-11-06T00:00:00Z' }),
    ]),
    workspace('Art', [row('mid', { postedAt: '2026-11-03T00:00:00Z' })]),
  ];
  const posted = todoSections(classes, view({ sort: 'posted' }));
  expect(ids(posted)).toEqual(['Biology', 'Art']);
  expect(posted[0]?.shown.map((a) => a.id)).toEqual(['new', 'old']);
  expect(ids(todoSections(classes, view({ sort: 'class' })))).toEqual([
    'Art',
    'Biology',
  ]);
  expect(
    ids(todoSections(classes, view({ reversed: true, sort: 'class' })))
  ).toEqual(['Biology', 'Art']);
});

it('lists the Done tab newest first, closed work by the day it closed', () => {
  const done = (id: string, doneAt: string) =>
    row(id, { mine: { done: true, doneAt } as Assignment['mine'] });
  const sections = todoSections(
    [
      workspace('a', [
        done('mon', '2026-11-03T00:00:00Z'),
        done('wed', '2026-11-05T00:00:00Z'),
        row('closed-tue', { closedAt: '2026-11-04T00:00:00Z' }),
      ]),
    ],
    view({ sort: 'done', tab: 'done' })
  );
  expect(sections[0]?.shown.map((a) => a.id)).toEqual([
    'wed',
    'closed-tue',
    'mon',
  ]);
});

it('keeps the classes and types the filter picks', () => {
  const classes = [
    workspace('a', [
      row('quiz', { kind: 'marked' }),
      row('task', { kind: 'unmarked' }),
    ]),
    workspace('b', [row('other', { kind: 'marked' })]),
  ];
  const sections = todoSections(
    classes,
    view({ classes: ['a'], types: ['task'] })
  );
  expect(ids(sections)).toEqual(['a']);
  expect(sections[0]?.shown.map((a) => a.id)).toEqual(['task']);
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
