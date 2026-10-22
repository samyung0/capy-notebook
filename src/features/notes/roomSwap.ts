import type { PlateEditor } from 'platejs/react';

/**
 * A room reload swaps renderers (Epo 2026-10-22): the note on screen stays
 * paused while the next room's editor builds beside it, then the next one
 * takes over at the same block. These are the DOM and selection pieces of
 * that swap; NoteEditor runs it.
 */

/** A painted note renderer: its editor (none for recovery's static copy) and
 * the box that scrolls it. */
export interface NoteView {
  editor: PlateEditor | null;
  scrollArea: HTMLElement;
}

interface BlockPoint {
  /** The top-level block's id, then the path and offset inside it. */
  block: string;
  offset: number;
  path: number[];
}

/** Where the reader was: the first block showing at the top and how far it
 * sat below the box's top edge, and the selection by block id, never by Yjs
 * ids (a compaction gives the room new ones). */
export interface NotePosition {
  block: string | null;
  focused: boolean;
  offset: number;
  scrollTop: number;
  selection: { anchor: BlockPoint; focus: BlockPoint } | null;
}

/** Top-level blocks only: nested ones (list items in columns, table cells)
 * would break the order the search relies on. */
const TOP_BLOCKS = '[data-block-id]:not([data-block-id] *)';

function blockPoint(
  editor: PlateEditor,
  point: { path: number[]; offset: number }
): BlockPoint | null {
  const block = (editor.children[point.path[0]] as { id?: unknown })?.id;
  return typeof block === 'string'
    ? { block, offset: point.offset, path: point.path.slice(1) }
    : null;
}

export function captureNotePosition(view: NoteView): NotePosition {
  const { editor, scrollArea } = view;
  const top = scrollArea.getBoundingClientRect().top;
  // The first block whose bottom is below the top edge; blocks are in
  // document order, so their edges only grow.
  const blocks = scrollArea.querySelectorAll<HTMLElement>(TOP_BLOCKS);
  let low = 0;
  let high = blocks.length - 1;
  let found: HTMLElement | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].getBoundingClientRect().bottom > top) {
      found = blocks[middle];
      high = middle - 1;
    } else low = middle + 1;
  }
  const selection = editor?.selection;
  const anchor = selection && blockPoint(editor, selection.anchor);
  const focus = selection && blockPoint(editor, selection.focus);
  return {
    block: found?.dataset.blockId ?? null,
    // A paused editor is read-only, which may already have dropped the DOM
    // focus; Slate still knows it held it unless the reader went elsewhere.
    focused:
      !!editor?.api.isFocused() &&
      (document.activeElement === document.body ||
        scrollArea.contains(document.activeElement)),
    offset: found ? found.getBoundingClientRect().top - top : 0,
    scrollTop: scrollArea.scrollTop,
    selection: anchor && focus ? { anchor, focus } : null,
  };
}

function pointIn(editor: PlateEditor, point: BlockPoint) {
  const index = editor.children.findIndex(
    (node) => (node as { id?: unknown }).id === point.block
  );
  if (index < 0) return null;
  const path = [index, ...point.path];
  const text = editor.api.node(path)?.[0] as { text?: unknown } | undefined;
  return typeof text?.text === 'string' && point.offset <= text.text.length
    ? { offset: point.offset, path }
    : null;
}

/** Puts the same block at the same height, else the same scroll offset, and
 * the selection back where its blocks still exist. */
export function restoreNotePosition(view: NoteView, position: NotePosition) {
  const { editor, scrollArea } = view;
  const block =
    position.block &&
    scrollArea.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(position.block)}"]`
    );
  if (block)
    scrollArea.scrollTop +=
      block.getBoundingClientRect().top -
      scrollArea.getBoundingClientRect().top -
      position.offset;
  else scrollArea.scrollTop = position.scrollTop;
  if (!(editor && position.selection)) return;
  const anchor = pointIn(editor, position.selection.anchor);
  const focus = pointIn(editor, position.selection.focus);
  if (!(anchor && focus)) return;
  editor.tf.select({ anchor, focus });
  if (position.focused) editor.tf.focus();
}

/**
 * A phone keeps one renderer (Epo 2026-10-22): the paused note stays on
 * screen as a plain copy of its DOM, read-only, scrollable and selectable,
 * while the next editor remounts in place under it. The copy is no editor:
 * nothing in it is editable, its toolbar takes no input, frames (which would
 * reload empty) are left out, and Slate's and block-id markers go so nothing
 * looks it up as live.
 */
export function copyPausedView(root: HTMLElement, scrollTop: number) {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const node of copy.querySelectorAll('[contenteditable]'))
    node.setAttribute('contenteditable', 'false');
  for (const node of copy.querySelectorAll('[data-slate-editor]'))
    node.removeAttribute('data-slate-editor');
  for (const node of copy.querySelectorAll('[data-block-id]'))
    node.removeAttribute('data-block-id');
  for (const frame of copy.querySelectorAll('iframe')) frame.remove();
  copy.querySelector('[data-note-toolbar]')?.setAttribute('inert', '');
  copy.removeAttribute('inert');
  delete copy.dataset.noteMount;
  copy.dataset.pausedCopy = '';
  return {
    copy,
    /** Scroll positions are not cloned: set once the copy is in the page. */
    place: () => {
      const area = copy.querySelector<HTMLElement>('[data-note-scroll]');
      if (area) area.scrollTop = scrollTop;
    },
  };
}

/** What may take an edit inside a note's content: buttons and menus of
 * blocks and embeds, form fields, formulas, drag handles. */
const CONTROLS =
  'button,[role="button"],[role="checkbox"],[role="menuitem"],input,select,textarea,math-field,[draggable="true"]';
/** Keys that only read: moving, selecting, leaving. */
const READING_KEYS = new Set([
  'Alt',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Control',
  'End',
  'Escape',
  'Home',
  'Meta',
  'PageDown',
  'PageUp',
  'Shift',
  'Tab',
]);

/**
 * A paused editor stays readable, scrollable and selectable but takes no
 * edit. Slate's readOnly would re-render every block (seconds on a
 * near-limit note) and drop the reader to the top, so the paused content
 * just stops being editable and its controls take no input: typing, paste,
 * drops, drags and clicks on controls are stopped before Slate or React see
 * them; selecting, copying and links still work. Returns the undo.
 */
export function pauseEdits(content: HTMLElement) {
  const editable = content.querySelector('[data-slate-editor]');
  editable?.setAttribute('contenteditable', 'false');
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onControl = (event: Event) => {
    if ((event.target as Element | null)?.closest?.(CONTROLS)) stop(event);
  };
  const onKey = (event: Event) => {
    const { ctrlKey, key, metaKey } = event as KeyboardEvent;
    const copying =
      (ctrlKey || metaKey) && ['a', 'c'].includes(key.toLowerCase());
    if (!(copying || READING_KEYS.has(key))) stop(event);
  };
  const listeners: [string, (event: Event) => void][] = [
    ['beforeinput', stop],
    ['click', onControl],
    ['cut', stop],
    ['dragstart', stop],
    ['drop', stop],
    ['keydown', onKey],
    ['paste', stop],
    ['pointerdown', onControl],
  ];
  for (const [type, listener] of listeners)
    content.addEventListener(type, listener, true);
  return () => {
    for (const [type, listener] of listeners)
      content.removeEventListener(type, listener, true);
    editable?.setAttribute('contenteditable', 'true');
  };
}

/** Runs once the next frame has been painted; returns the cancel. */
export function afterPaint(run: () => void) {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => cancelAnimationFrame(frame);
}

/** A hidden tab swaps at once, with no paused phase (Epo 2026-10-22). */
export const tabHidden = () => document.visibilityState === 'hidden';

/** Phones (below sm, as the phone-width layout) hold one renderer. */
export const onPhone = () => !window.matchMedia('(min-width: 640px)').matches;
