import type { Assignment, TodoDonePage, TodoWorkspace } from '@/api/types';
import type { TodoSort, TodoType } from '@/lib/listSearch';

/** Done, or ticked off To do by hand without doing it (Epo 2026-11-10). */
export const isTicked = (a: Assignment) =>
  !!(a.mine?.done || a.mine?.checkedOff);

/** A plain task: its tick is its done. A quiz or one handed in with files is
 * done by submitting or handing in, and a tick by hand only clears To do. */
export const isPlainTask = (a: Assignment) =>
  a.kind === 'unmarked' && !a.allowUploads;

/** What a class's To do lists: answers waiting for its staff, and what was given
 * to the viewer and is still open, ticked or not. `approvedOff` holds the
 * answers staff ticked off until more come in. */
export function todoRows(items: Assignment[], manages: boolean) {
  const mine = items.filter((a) => a.mine && !a.draft && !a.closedAt);
  const waiting = manages
    ? items.filter((a) => (a.manage?.toApprove ?? 0) > 0)
    : [];
  return {
    approvedOff: waiting.filter((a) => a.manage?.approvalsCheckedOff),
    done: mine.filter(isTicked),
    open: mine.filter((a) => !isTicked(a)),
    toApprove: waiting.filter((a) => !a.manage?.approvalsCheckedOff),
  };
}

/** What the nav's dot and the To do tab count: open work and answers waiting. */
export const todoCount = (workspaces: TodoWorkspace[]) =>
  workspaces.reduce((sum, w) => {
    const { open, toApprove } = todoRows(w.items, w.manages);
    return sum + open.length + toApprove.length;
  }, 0);

/** A To do table row: the viewer's own work, or (`approval`) the answers
 * waiting for them on it. */
export interface TodoRow {
  a: Assignment;
  approval: boolean;
  ticked: boolean;
}
export interface TodoTableSection {
  /** Rows not ticked; the Done tab leaves it out. */
  open?: number;
  rows: TodoRow[];
  workspace: TodoWorkspace;
}

export interface TodoView {
  ascending: boolean;
  sort: Exclude<TodoSort, 'done'>;
  types: TodoType[];
}

const dueKey = (a: Assignment) =>
  a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
/** By the sort's column; work with no due date goes last either way. */
const compareRows = (sort: TodoView['sort'], ascending: boolean) => {
  const dir = ascending ? 1 : -1;
  return (x: Assignment, y: Assignment) => {
    if (sort === 'title')
      return dir * x.title.localeCompare(y.title, undefined, { numeric: true });
    const a = dueKey(x);
    const b = dueKey(y);
    if (a === b) return 0;
    if (a === Number.POSITIVE_INFINITY) return 1;
    if (b === Number.POSITIVE_INFINITY) return -1;
    return dir * (a - b);
  };
};
const typeOf = (a: Assignment): TodoType =>
  a.kind === 'marked' ? 'quiz' : 'task';

/** The To do tab's classes (Epo 2026-11-10, board K): answers waiting first,
 * then the open rows, in the sort's order. What's done or ticked off has moved
 * to Done, closed or not (done for them is done). By due, classes with answers
 * waiting come first, then the one due soonest; by To do, classes go by name. */
export function todoSections(
  workspaces: TodoWorkspace[],
  view: TodoView
): TodoTableSection[] {
  const keep = (a: Assignment) =>
    view.types.length === 0 || view.types.includes(typeOf(a));
  const by = compareRows(view.sort, view.ascending);
  const order = (items: Assignment[]) => items.filter(keep).sort(by);
  const rowsOf = (items: Assignment[], approval: boolean, ticked: boolean) =>
    order(items).map((a) => ({ a, approval, ticked }));
  const sections = workspaces
    .map((workspace) => {
      const { open, toApprove } = todoRows(workspace.items, workspace.manages);
      const rows = [
        ...rowsOf(toApprove, true, false),
        ...rowsOf(open, false, false),
      ];
      return {
        first: [...order(toApprove), ...order(open)][0],
        open: rows.length,
        rows,
        waiting: rows.some((row) => row.approval),
        workspace,
      };
    })
    .filter((s) => s.rows.length > 0)
    .sort((x, y) => {
      if (view.sort === 'title') {
        const names = x.workspace.name.localeCompare(y.workspace.name);
        return view.ascending ? names : -names;
      }
      const waiting = Number(y.waiting) - Number(x.waiting);
      if (waiting !== 0) return waiting;
      return x.first && y.first ? by(x.first, y.first) : 0;
    });
  return sections.map(({ open, rows, workspace }) => ({
    open,
    rows,
    workspace,
  }));
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

/** The Done tab's classes: its rows ticked when finished or ticked off by hand. */
export const doneSections = (pages: TodoDonePage[]): TodoTableSection[] =>
  mergeTodoPages(pages).map((workspace) => ({
    rows: workspace.items.map((a) => ({
      a,
      approval: false,
      ticked: isTicked(a),
    })),
    workspace,
  }));
