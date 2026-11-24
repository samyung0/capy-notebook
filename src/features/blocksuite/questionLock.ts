import { DefaultTool } from '@blocksuite/affine/blocks/surface';
import type { BlockStdScope } from '@blocksuite/affine/std';
import {
  type GfxController,
  type GfxModel,
  InteractivityIdentifier,
} from '@blocksuite/affine/std/gfx';
import * as Y from 'yjs';
import { BoardLoadError } from './boardLoad';
import { takesLock } from './boardRules';

/* Part of the question (Canvas parts, Epo 2026-11-23): a student answers on a copy
 * of the teacher's board, and everything the teacher put there stays as it was.
 * The mark is BlockSuite's own lock, `lockedBySelf` (on a canvas element, and
 * `prop:lockedBySelf` on a block that stands on the canvas), which its move,
 * resize, eraser, Delete, arrow keys, grouping and text editing already refuse.
 * It lives in the saved board, so a reopened answer or draft keeps it, and the
 * question boards have no lock or unlock control (boardTools.ts), so on them
 * every locked thing is part of the question. What BlockSuite's lock still lets
 * through, a click selecting it and Select all taking it in, is held off here. */

/** Marks every canvas element and canvas block of a board's document as part of
 * the question. */
export function lockQuestion(doc: Y.Doc) {
  doc.transact(() => {
    for (const block of doc.getMap<unknown>('blocks').values()) {
      if (!(block instanceof Y.Map)) continue;
      const flavour = block.get('sys:flavour');
      if (typeof flavour !== 'string') continue;
      if (takesLock(flavour)) block.set('prop:lockedBySelf', true);
      if (flavour !== 'affine:surface') continue;
      const holder = block.get('prop:elements');
      const canvas = holder instanceof Y.Map ? holder.get('value') : null;
      if (canvas instanceof Y.Map)
        for (const element of canvas.values())
          if (element instanceof Y.Map) element.set('lockedBySelf', true);
    }
  });
}

/** A copy of a saved question board whose every canvas element and canvas block
 * is part of the question (`lockQuestion`). Written before the board opens, it is
 * no step to undo; the answer area comes along where the teacher put it. */
export function questionCopy(update: Uint8Array) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch (cause) {
    throw new BoardLoadError('unreadable', { cause });
  }
  lockQuestion(doc);
  const copy = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return copy;
}

/** Whether a board's document holds part of a question. */
export function holdsQuestion(doc: Y.Doc) {
  for (const block of doc.getMap<unknown>('blocks').values()) {
    if (!(block instanceof Y.Map)) continue;
    if (block.get('prop:lockedBySelf') === true) return true;
    if (block.get('sys:flavour') !== 'affine:surface') continue;
    const holder = block.get('prop:elements');
    const canvas = holder instanceof Y.Map ? holder.get('value') : null;
    if (canvas instanceof Y.Map)
      for (const element of canvas.values())
        if (element instanceof Y.Map && element.get('lockedBySelf') === true)
          return true;
  }
  return false;
}

/** Part of the question, on a question board (where nothing else is locked). */
export const isQuestionPart = (model: GfxModel) => model.isLocked();

/** How long a tip a finger's press showed stays. */
const TOUCH_TIP_MS = 1500;

/** On an editable board holding part of a question: that part is never selected,
 * so a press on it selects as on empty board (a box from there takes only the
 * student's own drawing, as BlockSuite's box selection leaves locked things out),
 * and Select all takes the rest. Pressing it under Select or the eraser, or
 * hovering it under Select, shows `tip` by the pointer. */
export function guardQuestion(
  std: BlockStdScope,
  gfx: GfxController,
  board: HTMLElement,
  tip: string | undefined
) {
  const { selection } = gfx;
  const unselect = selection.slots.updated.subscribe(() => {
    const selected = selection.selectedElements;
    if (!selected.some(isQuestionPart)) return;
    selection.set({
      editing: false,
      elements: selected
        .filter((model) => !isQuestionPart(model))
        .map(({ id }) => id),
    });
  });
  const at = (clientX: number, clientY: number) =>
    gfx.viewport.toModelCoordFromClientCoord([clientX, clientY]);
  // A press only on the question's parts finds nothing to select there.
  const interactivity = std.get(InteractivityIdentifier);
  const select = interactivity.handleElementSelection;
  interactivity.handleElementSelection = (event) => {
    const [x, y] = at(event.raw.clientX, event.raw.clientY);
    const under = gfx.getElementByPoint(x, y, { all: true });
    if (under.length && under.every(isQuestionPart)) return false;
    return select.call(interactivity, event);
  };

  const element = document.createElement('div');
  element.className = 'capy-question-tip';
  element.textContent = tip ?? '';
  element.hidden = true;
  if (tip) board.append(element);
  const tool = () => gfx.tool.currentToolName$.peek();
  const onPart = (clientX: number, clientY: number) => {
    const [x, y] = at(clientX, clientY);
    const top = gfx.getElementByPoint(x, y);
    return !!top && isQuestionPart(top);
  };
  // The board's place on the page, read when a pointer comes in or presses.
  let origin: DOMRect | null = null;
  /** Where the board is looked at, and its size on the screen. */
  const view = () => {
    const { centerX, centerY, height, width, zoom } = gfx.viewport;
    return `${zoom} ${centerX} ${centerY} ${width} ${height}`;
  };
  let shownIn = '';
  const show = (clientX: number, clientY: number) => {
    origin ??= board.getBoundingClientRect();
    element.style.transform = `translate(${clientX - origin.left}px,${clientY - origin.top}px) translate(-50%,-100%)`;
    shownIn = view();
    element.hidden = false;
  };
  const hide = () => {
    element.hidden = true;
  };
  let frame = 0;
  let clientX = 0;
  let clientY = 0;
  let hideLater = 0;
  /** A mouse or pen hovering, looked at once a frame. */
  const look = () => {
    frame = 0;
    if (tool() === DefaultTool.toolName && onPart(clientX, clientY))
      show(clientX, clientY);
    else hide();
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    if (event.buttons) {
      hide();
      return;
    }
    clientX = event.clientX;
    clientY = event.clientY;
    frame ||= requestAnimationFrame(look);
  };
  const onDown = (event: PointerEvent) => {
    origin = board.getBoundingClientRect();
    clearTimeout(hideLater);
    const name = tool();
    if (
      (name === DefaultTool.toolName || name === 'eraser') &&
      onPart(event.clientX, event.clientY)
    ) {
      show(event.clientX, event.clientY);
      if (event.pointerType === 'touch')
        hideLater = window.setTimeout(hide, TOUCH_TIP_MS);
    } else hide();
  };
  const onLeave = () => {
    origin = null;
    hide();
  };
  const hover = tip
    ? ([
        ['pointermove', onMove],
        ['pointerdown', onDown],
        ['pointerleave', onLeave],
      ] as const)
    : [];
  for (const [type, listener] of hover)
    board.addEventListener(type, listener, { capture: true, passive: true });
  // A pan, zoom or resize moves the part from under the tip. BlockSuite also
  // says the view updated with nothing moved, when its refresh after a view
  // change settles (one lands a moment after the board opens), and that keeps it.
  const panned = tip
    ? gfx.viewport.viewportUpdated.subscribe(() => {
        if (view() !== shownIn) hide();
      })
    : null;

  return () => {
    unselect.unsubscribe();
    interactivity.handleElementSelection = select;
    for (const [type, listener] of hover)
      board.removeEventListener(type, listener, { capture: true });
    panned?.unsubscribe();
    cancelAnimationFrame(frame);
    clearTimeout(hideLater);
    element.remove();
  };
}
