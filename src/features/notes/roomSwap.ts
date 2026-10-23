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
 * ids (the next room's document need not hold them). */
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

/** Whether each paused editor held the focus as it paused: the pause makes
 * its root non-editable, which blurs it before the swap reads it (review r2
 * M1). */
const focusedAtPause = new WeakMap<PlateEditor, boolean>();

/** Records the focus before `pauseEdits` drops it. */
export function noteFocusAtPause(editor: PlateEditor) {
  focusedAtPause.set(editor, editor.api.isFocused());
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
    // The focus it held as it paused, unless the reader went elsewhere since.
    focused:
      !!editor &&
      !!focusedAtPause.get(editor) &&
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

/** Puts the selection (and the focus) back where its blocks still exist,
 * then the same block at the same height, else the same scroll offset: the
 * reading place wins over the caret (review M2), as in a DOCX. */
export function restoreNotePosition(view: NoteView, position: NotePosition) {
  const { editor, scrollArea } = view;
  const anchor =
    editor && position.selection && pointIn(editor, position.selection.anchor);
  const focus =
    editor && position.selection && pointIn(editor, position.selection.focus);
  if (editor && anchor && focus) {
    editor.tf.select({ anchor, focus });
    if (position.focused) editor.tf.focus();
  }
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
  // Canvases (charts, plots) and math fields' shadow content do not clone:
  // they show blank in the copy until the swap (openwiki plate-editor).
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
    // Block menus open on a right click and act from a portal.
    ['contextmenu', stop],
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

/**
 * Drops every operation but a selection change while a note is paused: it
 * still selects and copies, and no edit reaches its model by any path the
 * DOM listeners miss (a portalled block menu, a column or figure resize, an
 * IME composition the pause ends). Returns the undo.
 */
export function holdModel(editor: PlateEditor) {
  type Apply = PlateEditor['tf']['apply'];
  // Slate's transforms go through `editor.apply`, Plate's through `tf.apply`.
  const slate = editor as unknown as { apply: Apply };
  const { apply } = slate;
  const { apply: tfApply } = editor.tf;
  const selectOnly =
    (run: Apply): Apply =>
    (operation) => {
      if (operation.type === 'set_selection') run(operation);
    };
  slate.apply = selectOnly(apply);
  editor.tf.apply = selectOnly(tfApply);
  return () => {
    slate.apply = apply;
    editor.tf.apply = tfApply;
  };
}

/**
 * An IME composition the pause ended leaves its text in the page only (the
 * held model took none of it): the caret's text shows the model's again.
 * One leaf only; a decorated text split in several keeps its page text
 * until the swap.
 */
export function dropComposedText(editor: PlateEditor) {
  const path = editor.selection?.anchor.path;
  const node = path && editor.api.node(path)?.[0];
  if (!(node && 'text' in node && typeof node.text === 'string')) return;
  const leaves = editor.api
    .toDOMNode(node)
    ?.querySelectorAll('[data-slate-string]');
  if (leaves?.length === 1 && leaves[0].textContent !== node.text)
    leaves[0].textContent = node.text;
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
