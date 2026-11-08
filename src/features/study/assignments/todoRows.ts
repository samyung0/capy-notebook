import type { Assignment, TodoDonePage, TodoWorkspace } from '@/api/types';
import type { TodoSort, TodoType } from '@/lib/listSearch';

/** What a class's To do lists: answers waiting for its staff, and what was given
 * to the viewer and is still open, done or not. */
export function todoRows(items: Assignment[], manages: boolean) {
  const mine = items.filter((a) => a.mine && !a.draft && !a.closedAt);
  return {
    done: mine.filter((a) => a.mine?.done),
    open: mine.filter((a) => !a.mine?.done),
    toApprove: manages
      ? items.filter((a) => (a.manage?.toApprove ?? 0) > 0)
      : [],
  };
}

/** What the nav's dot and the To do tab count: open work and answers waiting. */
export const todoCount = (workspaces: TodoWorkspace[]) =>
  workspaces.reduce((sum, w) => {
    const { open, toApprove } = todoRows(w.items, w.manages);
    return sum + open.length + toApprove.length;
  }, 0);

export interface TodoView {
  /** Workspace ids; empty keeps every class. */
  classes: string[];
  /** The sort's order turned around. */
  reversed: boolean;
  sort: Exclude<TodoSort, 'done'>;
  types: TodoType[];
}

const time = (iso: string | undefined, missing: number) =>
  iso ? Date.parse(iso) : missing;
/** A row's place, smallest first; work with no date goes last. */
const KEY: Record<TodoView['sort'], (a: Assignment) => number> = {
  class: (a) => time(a.dueAt, Number.POSITIVE_INFINITY),
  due: (a) => time(a.dueAt, Number.POSITIVE_INFINITY),
  posted: (a) => -Date.parse(a.postedAt),
};
const compare = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1);
const typeOf = (a: Assignment): TodoType =>
  a.kind === 'marked' ? 'quiz' : 'task';

/** The To do tab's sections: a class with something to show, its rows in the
 * sort's order. Classes go by their first row; by due, those with answers
 * waiting come first, and Class goes by name. */
export function todoSections(workspaces: TodoWorkspace[], view: TodoView) {
  const key = KEY[view.sort];
  const keep = (a: Assignment) =>
    view.types.length === 0 || view.types.includes(typeOf(a));
  const order = (items: Assignment[]) => {
    const sorted = items.filter(keep).sort((a, b) => compare(key(a), key(b)));
    return view.reversed ? sorted.reverse() : sorted;
  };
  const sections = workspaces
    .filter(
      (w) => view.classes.length === 0 || view.classes.includes(w.workspaceId)
    )
    .map((workspace) => {
      const rows = todoRows(workspace.items, workspace.manages);
      const shown = order(rows.open);
      const toApprove = order(rows.toApprove);
      return {
        first: Math.min(...[...toApprove, ...shown].map(key)),
        shown,
        toApprove,
        workspace,
      };
    })
    .filter((s) => s.toApprove.length > 0 || s.shown.length > 0)
    .sort((a, b) => {
      if (view.sort === 'class')
        return a.workspace.name.localeCompare(b.workspace.name);
      if (view.sort === 'due') {
        const waiting =
          Number(b.toApprove.length > 0) - Number(a.toApprove.length > 0);
        if (waiting !== 0) return waiting;
      }
      return compare(a.first, b.first);
    });
  return view.reversed ? sections.reverse() : sections;
}

/** The Done tab's pages as one list of classes, in the server's order: a class
 * split across pages keeps its first place and gathers its rows. Pages go by
 * offset, so a row a later page repeats (work that closed meanwhile shifts
 * them) is skipped. */
export function mergeTodoPages(pages: TodoDonePage[]) {
  const merged: TodoWorkspace[] = [];
  const at = new Map<string, number>();
  const seen = new Set<string>();
  for (const page of pages)
    for (const w of page.workspaces) {
      const items = w.items.filter((a) => !seen.has(a.id));
      for (const a of items) seen.add(a.id);
      if (items.length === 0) continue;
      const i = at.get(w.workspaceId);
      if (i === undefined) {
        at.set(w.workspaceId, merged.length);
        merged.push({ ...w, items });
      } else merged[i]?.items.push(...items);
    }
  return merged;
}
