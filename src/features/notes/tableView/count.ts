import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { TABLE_VIEW_LIMITS, TABLE_VIEW_TYPE } from './model';

/* A note holds at most TABLE_VIEW_MAX_COUNT table views (revision 2.4): the
   slash command, block Duplicate and paste all stop at it. */

type Node = { type?: unknown; children?: unknown };

const isTableView = (node: unknown) =>
  typeof node === 'object' &&
  node !== null &&
  (node as Node).type === TABLE_VIEW_TYPE;

/** The table views a note's top level holds. */
export const tableViewCount = (children: readonly unknown[]) =>
  children.filter(isTableView).length;

/** Tells the user a note is at its table view cap. */
export const toastTableViewCap = () =>
  userToast({
    title: m.table_view_at_count({ count: TABLE_VIEW_LIMITS.count }),
    variant: 'error',
  });

/** `nodes` to insert into a note holding `children`, with the table views
 * past the cap left out (at any depth: a pasted one is lifted to the top
 * level later), and whether any were. */
export function withinTableViewCap<T>(
  children: readonly unknown[],
  nodes: T[]
): { dropped: boolean; nodes: T[] } {
  let room = TABLE_VIEW_LIMITS.count - tableViewCount(children);
  let dropped = false;
  const keep = (list: unknown[]): unknown[] =>
    list.flatMap((node) => {
      if (isTableView(node)) {
        if (room > 0) {
          room--;
          return [node];
        }
        dropped = true;
        return [];
      }
      const kids = (node as Node | null)?.children;
      if (!Array.isArray(kids)) return [node];
      const next = keep(kids);
      if (
        next.length === kids.length &&
        next.every((kid, at) => kid === kids[at])
      )
        return [node];
      // A container left empty keeps an empty line.
      const children = next.length
        ? next
        : [{ children: [{ text: '' }], type: 'p' }];
      return [{ ...(node as object), children }];
    });
  const kept = keep(nodes) as T[];
  return { dropped, nodes: dropped ? kept : nodes };
}
