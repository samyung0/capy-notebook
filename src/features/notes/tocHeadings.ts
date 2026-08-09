import { type Heading, isHeading } from '@platejs/toc';
import { ElementApi, NodeApi, type SlateEditor, type TNode } from 'platejs';

/**
 * Incremental replacement for the table-of-contents heading scan.
 *
 * `@platejs/toc` reads the heading list through `useEditorSelector`, whose
 * default equality is reference equality, and its built-in query walks every
 * node and allocates a fresh array. On a near-limit document that is a full
 * ~7.4k-node traversal per keystroke that then always reports a change, so the
 * TOC re-renders every one of its entries on every character typed.
 *
 * This version exploits the same structural sharing that `MemoizedElement`
 * relies on: Slate applies operations through immer, so a keystroke replaces
 * only the edited block's object and leaves every sibling's identity intact.
 * Headings are therefore cached per top-level block and only rescanned when
 * that block's object changes. The result is compared to the previous list and
 * the previous array is returned unchanged when nothing moved, which is what
 * keeps the selector quiet.
 */

/** Matches `@platejs/toc`'s own mapping rather than deriving from key order. */
const HEADING_DEPTH: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** A heading's position within its top-level block. Absolute paths cannot be
 * cached: inserting a block shifts every later block's path without changing
 * any of their node identities. */
interface BlockHeading {
  depth: number;
  id: string;
  relativePath: number[];
  title: string;
  type: string;
}

interface EditorCache {
  blocks: WeakMap<object, BlockHeading[]>;
  last: Heading[];
}

const caches = new WeakMap<SlateEditor, EditorCache>();

function scanBlock(
  node: TNode,
  relativePath: number[],
  found: BlockHeading[]
): void {
  if (!ElementApi.isElement(node)) return;
  if (isHeading(node)) {
    const title = NodeApi.string(node);
    // The upstream query skips untitled headings, and the TOC renders titles.
    if (title) {
      found.push({
        depth: HEADING_DEPTH[node.type],
        id: node.id as string,
        relativePath,
        title,
        type: node.type,
      });
    }
    return;
  }
  for (const [index, child] of node.children.entries()) {
    scanBlock(child, [...relativePath, index], found);
  }
}

function sameHeadings(previous: Heading[], next: Heading[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((entry, index) => {
    const candidate = next[index];
    return (
      entry.id === candidate.id &&
      entry.depth === candidate.depth &&
      entry.title === candidate.title &&
      entry.type === candidate.type &&
      entry.path.length === candidate.path.length &&
      entry.path.every((step, i) => step === candidate.path[i])
    );
  });
}

export function queryHeadings(editor: SlateEditor): Heading[] {
  let cache = caches.get(editor);
  if (!cache) {
    cache = { blocks: new WeakMap(), last: [] };
    caches.set(editor, cache);
  }

  const next: Heading[] = [];
  for (const [index, block] of editor.children.entries()) {
    let blockHeadings = cache.blocks.get(block);
    if (!blockHeadings) {
      blockHeadings = [];
      scanBlock(block, [], blockHeadings);
      cache.blocks.set(block, blockHeadings);
    }
    for (const heading of blockHeadings) {
      next.push({
        depth: heading.depth,
        id: heading.id,
        path: [index, ...heading.relativePath],
        title: heading.title,
        type: heading.type,
      });
    }
  }

  if (sameHeadings(cache.last, next)) return cache.last;
  cache.last = next;
  return next;
}
