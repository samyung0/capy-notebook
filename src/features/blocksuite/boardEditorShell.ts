import type { GfxController } from '@blocksuite/affine/std/gfx';
import { HistoryExtension } from '@blocksuite/affine/store';
import { render } from 'lit';
import { m } from '@/i18n';

const closing = new WeakMap<GfxController, () => void>();

/** Leaves the open plane or chart, as saving or making the image does. */
export function closeBoardEditor(gfx: GfxController) {
  closing.get(gfx)?.();
}

/** A full-board editor for one card. While it's open undo reaches only what was done in
 * it, as what's on the canvas is out of sight. */
export function openBoardEditor(
  gfx: GfxController,
  cardId: string,
  hooks: {
    /** Before it goes: whatever it has to write. */
    onLeave: () => void;
    /** Escape's own use, if it has one right now. */
    onEscape: () => boolean;
    onUpdate: () => void;
  }
) {
  const board = gfx.std.host.closest('.capy-board');
  // A teacher's board opens nothing for editing.
  if (gfx.doc.readonly || !board || board.querySelector('.capy-plane-editor'))
    return null;
  gfx.selection.clear();

  const root = document.createElement('div');
  root.className = 'capy-plane-editor';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', m.drawing_board_maths());
  const controls = document.createElement('div');
  root.append(canvas, controls);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  board.append(root);
  board.setAttribute('data-editor-open', '');

  const undo = gfx.doc.get(HistoryExtension).undoManager;
  gfx.doc.captureSync();
  const earlier = { redo: undo.redoStack, undo: undo.undoStack };
  let changed = false;
  /** The undo buttons read the stacks only when told. */
  const stacksSwapped = () =>
    undo.emit('stack-cleared', [
      { redoStackCleared: true, undoStackCleared: true },
    ]);
  undo.undoStack = [];
  undo.redoStack = [];
  stacksSwapped();

  const box = () => root.getBoundingClientRect();

  const close = () => {
    hooks.onLeave();
    gfx.doc.captureSync();
    undo.undoStack = [...earlier.undo, ...undo.undoStack];
    undo.redoStack = changed
      ? undo.redoStack
      : [...earlier.redo, ...undo.redoStack];
    stacksSwapped();
    window.removeEventListener('keydown', onKey, true);
    updates?.unsubscribe();
    render(null, controls);
    root.remove();
    board.removeAttribute('data-editor-open');
    closing.delete(gfx);
    gfx.selection.set({ editing: false, elements: [cardId] });
  };
  closing.set(gfx, close);

  // The board listens on the document, so its shortcuts stop here. Typing elsewhere on
  // the page isn't this editor's, and a field in it keeps its own undo.
  const onKey = (event: KeyboardEvent) => {
    const { target } = event;
    if (
      target instanceof Element &&
      target !== document.body &&
      !root.contains(target)
    )
      return;
    const key = event.key.toLowerCase();
    // A field gets its keys; root stops them on their way out to the board.
    if (target instanceof HTMLInputElement && key !== 'escape') return;
    event.stopPropagation();
    const command = event.metaKey || event.ctrlKey;
    if (key === 'escape') {
      event.preventDefault();
      if (!hooks.onEscape()) close();
    } else if (command && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      gfx.doc.redo();
    } else if (command && key === 'z') {
      event.preventDefault();
      gfx.doc.undo();
    }
  };
  window.addEventListener('keydown', onKey, true);
  root.addEventListener('keydown', (event) => event.stopPropagation());

  const updates = gfx.surface?.elementUpdated.subscribe(hooks.onUpdate);

  return {
    box,
    canvas,
    close,
    controls,
    ctx,
    root,
    /** Matches the canvas to the screen and returns the size to draw at. */
    sizeCanvas: () => {
      const { height, width } = box();
      const scale = window.devicePixelRatio || 1;
      if (
        canvas.width !== Math.round(width * scale) ||
        canvas.height !== Math.round(height * scale)
      ) {
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, width, height);
      return { height, width };
    },
    /** One undo step. */
    write: (change: () => void) => {
      changed = true;
      gfx.doc.captureSync();
      change();
      gfx.doc.captureSync();
    },
  };
}

/** The dark value chip beside the pointer. */
export function drawChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number
) {
  ctx.font = '13px Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const textWidth = ctx.measureText(text).width + 14;
  const chipX = Math.min(width - textWidth - 4, x + 10);
  const chipY = Math.max(4, y - 30);
  ctx.fillStyle = '#111';
  ctx.fillRect(chipX, chipY, textWidth, 22);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, chipX + 7, chipY + 11);
}
