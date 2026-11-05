import type { Assignment, TodoWorkspace } from '@/api/types';

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

const soonestDue = (items: Assignment[]) =>
  Math.min(
    ...items.map((a) =>
      a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY
    )
  );

/** The To do page's sections: a class with something to show, those with answers
 * waiting first, then by the soonest due, the rest in the order they came. */
export function todoSections(workspaces: TodoWorkspace[], showDone: boolean) {
  return workspaces
    .map((workspace) => {
      const { done, open, toApprove } = todoRows(
        workspace.items,
        workspace.manages
      );
      return {
        due: soonestDue(open),
        shown: showDone ? [...open, ...done] : open,
        toApprove,
        workspace,
      };
    })
    .filter((s) => s.toApprove.length > 0 || s.shown.length > 0)
    .sort((a, b) => {
      const waiting =
        Number(b.toApprove.length > 0) - Number(a.toApprove.length > 0);
      if (waiting !== 0) return waiting;
      return a.due === b.due ? 0 : a.due < b.due ? -1 : 1;
    });
}
