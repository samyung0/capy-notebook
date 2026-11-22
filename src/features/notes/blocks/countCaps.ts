import { userToast } from '@/components/ui/userToast';
import {
  HTML_EMBED_MAX_COUNT,
  HTML_EMBED_TYPE,
} from '@/features/materials/document';
import { m } from '@/i18n';
import { TABLE_VIEW_LIMITS, TABLE_VIEW_TYPE } from '../tableView/model';

/* The blocks a note holds a counted number of: table views (revision 2.4)
   and interactive blocks. The slash command, block Duplicate and paste stop
   at each cap, checked on the note as it reads now; two people's inserts at
   once may merge past it, up to twice it (Epo 2026-11-22). */
const COUNTED = {
  [HTML_EMBED_TYPE]: {
    cap: HTML_EMBED_MAX_COUNT,
    title: () => m.html_embed_at_count({ count: HTML_EMBED_MAX_COUNT }),
  },
  [TABLE_VIEW_TYPE]: {
    cap: TABLE_VIEW_LIMITS.count,
    title: () => m.table_view_at_count({ count: TABLE_VIEW_LIMITS.count }),
  },
};
export type CountedBlock = keyof typeof COUNTED;

type Node = { type?: unknown; children?: unknown };

const counted = (node: unknown): CountedBlock | null => {
  const type = (node as Node | null)?.type;
  return typeof type === 'string' && Object.hasOwn(COUNTED, type)
    ? (type as CountedBlock)
    : null;
};

/** The blocks of `type` a note's top level holds. */
export const blockCount = (children: readonly unknown[], type: CountedBlock) =>
  children.filter((node) => counted(node) === type).length;

/** Whether a note holding `children` is at its cap of `type` blocks. */
export const atBlockCap = (children: readonly unknown[], type: CountedBlock) =>
  blockCount(children, type) >= COUNTED[type].cap;

/** Tells the user a note is at its cap of `type` blocks. */
export const toastBlockCap = (type: CountedBlock) =>
  userToast({ title: COUNTED[type].title(), variant: 'error' });

/** `nodes` to insert into a note holding `children`, with the counted blocks
 * past their caps left out (at any depth: a pasted one is lifted to the top
 * level later), and the types any were left out of. */
export function withinBlockCaps<T>(
  children: readonly unknown[],
  nodes: T[]
): { dropped: CountedBlock[]; nodes: T[] } {
  const room = {
    [HTML_EMBED_TYPE]: COUNTED[HTML_EMBED_TYPE].cap,
    [TABLE_VIEW_TYPE]: COUNTED[TABLE_VIEW_TYPE].cap,
  };
  for (const node of children) {
    const type = counted(node);
    if (type) room[type]--;
  }
  const dropped = new Set<CountedBlock>();
  const keep = (list: unknown[]): unknown[] =>
    list.flatMap((node) => {
      const type = counted(node);
      if (type) {
        if (room[type] > 0) {
          room[type]--;
          return [node];
        }
        dropped.add(type);
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
  return { dropped: [...dropped], nodes: dropped.size ? kept : nodes };
}
