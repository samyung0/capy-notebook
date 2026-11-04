import type { NotePosition } from '@/features/notes/roomSwap';
import type { MaterialValue } from './document';

type TextPoint = { block: string; offset: number; path: number[] };

/** The leaf holding `offset` characters into `node`, by path below it. */
function pointIn(
  node: { children?: unknown[]; text?: unknown },
  offset: number
): { offset: number; path: number[] } | number {
  if (typeof node.text === 'string')
    return offset <= node.text.length
      ? { offset, path: [] }
      : offset - node.text.length;
  let left = offset;
  for (const [index, child] of (node.children ?? []).entries()) {
    const found = pointIn(child as typeof node, left);
    if (typeof found !== 'number')
      return { offset: found.offset, path: [index, ...found.path] };
    left = found;
  }
  return left;
}

/** A DOM selection's end in the painted note as a point in its value. */
function textPoint(
  root: Element,
  value: MaterialValue,
  node: Node,
  offset: number
): TextPoint | null {
  let block: Node | null = node;
  while (block && block.parentNode !== root) block = block.parentNode;
  if (!block) return null;
  const element = value[[...root.children].indexOf(block as Element)];
  if (typeof element?.id !== 'string') return null;
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(node, offset);
  const found = pointIn(element, range.toString().length);
  return typeof found === 'number'
    ? null
    : { block: element.id, offset: found.offset, path: found.path };
}

/** Where the reader is in a painted note, for the editor that replaces it (Epo
 * 2026-11-04): the first block under the box's top edge and how far it sits
 * below it, by the value's ids (the static note's elements carry none), and a
 * caret placed in the note so far, which the editor takes as its own. */
export function paintedPosition(
  box: HTMLElement,
  value: MaterialValue
): NotePosition | null {
  const root = box.querySelector('[data-slate-editor]');
  if (!root) return null;
  const top = box.getBoundingClientRect().top;
  const blocks = [...root.children];
  let low = 0;
  let high = blocks.length - 1;
  let at = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].getBoundingClientRect().bottom > top) {
      at = middle;
      high = middle - 1;
    } else low = middle + 1;
  }
  const selected = document.getSelection();
  const inNote =
    selected?.anchorNode &&
    selected.focusNode &&
    root.contains(selected.anchorNode) &&
    root.contains(selected.focusNode);
  const anchor = inNote
    ? textPoint(root, value, selected.anchorNode as Node, selected.anchorOffset)
    : null;
  const focus = inNote
    ? textPoint(root, value, selected.focusNode as Node, selected.focusOffset)
    : null;
  const block = at >= 0 ? value[at]?.id : null;
  return {
    block: typeof block === 'string' ? block : null,
    focused: !!(anchor && focus),
    offset: at >= 0 ? blocks[at].getBoundingClientRect().top - top : 0,
    scrollTop: box.scrollTop,
    selection: anchor && focus ? { anchor, focus } : null,
  };
}
