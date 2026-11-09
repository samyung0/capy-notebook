import { ThemeProvider } from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { HistoryExtension } from '@blocksuite/affine/store';
import { Redo03Icon, Undo03Icon } from '@hugeicons/core-free-icons';
import { html, render } from 'lit';
import { m } from '@/i18n';
import { BoardMenu, type MenuZoom } from './boardMenu';

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
    /** The menu's Fit and zoom row, where the card has them. */
    fit?: () => void;
    zoom?: MenuZoom;
    /** Before it goes: whatever it has to write. */
    onLeave: () => void;
    /** Escape's own use, if it has one right now. */
    onEscape: () => boolean;
    /** Delete or Backspace: removes what's selected, true when something was. */
    onDelete?: () => boolean;
    /** A tool's letter key (`P`), true when it was one. */
    onShortcut?: (key: string) => boolean;
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
  // Top right: a menu (Fit, Undo, Redo) and Done (Epo 2026-11-08).
  const top = document.createElement('div');
  top.className = 'capy-editor-top';
  root.append(canvas, controls, top);
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

  const menu = new BoardMenu(() => ({
    entries: [
      ...(hooks.fit
        ? [{ label: m.drawing_board_fit_to_screen(), run: hooks.fit }]
        : []),
      {
        disabled: !gfx.doc.canUndo,
        icon: Undo03Icon,
        keepsOpen: true,
        label: m.drawing_board_undo(),
        run: () => gfx.doc.undo(),
      },
      {
        disabled: !gfx.doc.canRedo,
        icon: Redo03Icon,
        keepsOpen: true,
        label: m.drawing_board_redo(),
        run: () => gfx.doc.redo(),
      },
    ],
    zoom: hooks.zoom,
  }));
  const done = document.createElement('button');
  done.className = 'capy-editor-done';
  done.type = 'button';
  done.textContent = m.drawing_board_done();
  done.addEventListener('click', () => close());
  top.append(menu.element, done);
  const history = gfx.doc
    .get(HistoryExtension)
    .onUpdated.subscribe(() => menu.open && menu.draw());

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
    unwatchTheme();
    history.unsubscribe();
    menu.dispose();
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
      if (menu.open) menu.set(false);
      else if (!hooks.onEscape()) close();
    } else if (command && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      gfx.doc.redo();
    } else if (command && key === 'z') {
      event.preventDefault();
      gfx.doc.undo();
    } else if ((key === 'delete' || key === 'backspace') && hooks.onDelete?.())
      event.preventDefault();
    else if (
      !(command || event.altKey || event.shiftKey) &&
      event.code.startsWith('Key') &&
      hooks.onShortcut?.(event.code.slice(3))
    )
      event.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);
  root.addEventListener('keydown', (event) => event.stopPropagation());

  const updates = gfx.surface?.elementUpdated.subscribe(hooks.onUpdate);
  // The card draws in the board's light or dark, so a switch redraws it. The signal
  // calls at once on subscribing, before the card's editor is set up: that one's skipped.
  let themeSeen = false;
  const unwatchTheme = gfx.std.get(ThemeProvider).theme$.subscribe(() => {
    if (themeSeen) hooks.onUpdate();
    themeSeen = true;
  });

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

/** AFFiNE's tooltip with its shortcut, as the board's toolbar shows them, for a button
 * in an open card. It goes inside the button. */
export const toolTip = (tip: string, key: string) =>
  html`<affine-tooltip tip-position="top" .offsetY=${10}>
    <affine-tooltip-content-with-shortcut
      data-tip=${tip}
      data-shortcut=${key}
    ></affine-tooltip-content-with-shortcut>
  </affine-tooltip>`;
