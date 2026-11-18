import { ThemeProvider } from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { HistoryExtension } from '@blocksuite/affine/store';
import {
  Delete02Icon,
  Redo03Icon,
  Undo03Icon,
} from '@hugeicons/core-free-icons';
import { html, render } from 'lit';
import { m } from '@/i18n';
import { BoardMenu, type MenuZoom } from './boardMenu';

const closing = new WeakMap<GfxController, () => void>();
const watchers = new WeakMap<GfxController, (cardId: string | null) => void>();

/** Tells the page which card's editor is open, null once none is: the canvas
 * keeps it in its URL (Epo 2026-11-13). */
export function watchBoardEditor(
  gfx: GfxController,
  watch: (cardId: string | null) => void
) {
  watchers.set(gfx, watch);
  return () => {
    watchers.delete(gfx);
  };
}

/** Leaves the open plane or chart, as saving or making the image does. */
export function closeBoardEditor(gfx: GfxController) {
  closing.get(gfx)?.();
}

/** The board's side of editing one card, whatever draws the editor: the board's
 * slot keys and menu step aside, and undo reaches only what was done in it, as
 * what's on the canvas is out of sight. `close` runs `onClose`, then gives the
 * board its history back; it runs once, from the editor or the page
 * (`closeBoardEditor`, through `fromPage` when given). */
export function boardEditorSession(
  gfx: GfxController,
  cardId: string,
  onClose: () => void,
  /** How the page's close reaches it, when the editor has to hand over first. */
  fromPage?: () => void
) {
  const board = gfx.std.host.closest('.capy-board');
  // A teacher's board opens nothing for editing.
  if (gfx.doc.readonly || !board || board.hasAttribute('data-editor-open'))
    return null;
  gfx.selection.clear();
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

  let open = true;
  let stepping = false;
  const close = () => {
    if (!open) return;
    open = false;
    onClose();
    gfx.doc.captureSync();
    undo.undoStack = [...earlier.undo, ...undo.undoStack];
    undo.redoStack = changed
      ? undo.redoStack
      : [...earlier.redo, ...undo.redoStack];
    stacksSwapped();
    board.removeAttribute('data-editor-open');
    closing.delete(gfx);
    gfx.selection.set({ editing: false, elements: [cardId] });
    watchers.get(gfx)?.(null);
  };
  closing.set(gfx, fromPage ?? close);
  watchers.get(gfx)?.(cardId);

  return {
    board,
    close,
    /** What the editor's Undo and Redo act on: this session's steps. */
    history: {
      canRedo: () => gfx.doc.canRedo,
      canUndo: () => gfx.doc.canUndo,
      redo: () => gfx.doc.redo(),
      subscribe: (notify: () => void) => {
        const updates = gfx.doc
          .get(HistoryExtension)
          .onUpdated.subscribe(notify);
        return () => updates.unsubscribe();
      },
      undo: () => gfx.doc.undo(),
    },
    /** One undo step: what's written in the same task joins it, and with
     * `join` it joins the step before (a row typed into, however slowly). */
    write: (change: () => void, join = false) => {
      changed = true;
      // Yjs adds a change to the last step while its last change is recent.
      if (join && undo.undoStack.length) undo.lastChange = Date.now();
      else if (!stepping) {
        stepping = true;
        gfx.doc.captureSync();
        queueMicrotask(() => {
          stepping = false;
          gfx.doc.captureSync();
        });
      }
      change();
    },
  };
}

/** A full-board editor for one card, drawn by the board itself (the chart's). */
export function openBoardEditor(
  gfx: GfxController,
  cardId: string,
  hooks: {
    /** The menu's Fit and zoom row, where the card has them. */
    fit?: () => void;
    /** The menu's Clear all: everything in the card goes in one undo step. */
    clear?: { empty: () => boolean; run: () => void };
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

  const session = boardEditorSession(gfx, cardId, () => {
    hooks.onLeave();
    window.removeEventListener('keydown', onKey, true);
    updates?.unsubscribe();
    unwatchTheme();
    history.unsubscribe();
    menu.dispose();
    render(null, controls);
    root.remove();
  });
  if (!session) return null;
  const { close, write } = session;
  session.board.append(root);

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
      // Clear all, the last entry, on every board and card (Epo 2026-11-13).
      ...(hooks.clear
        ? [
            {
              disabled: hooks.clear.empty(),
              icon: Delete02Icon,
              label: m.drawing_board_clear_all(),
              run: hooks.clear.run,
            },
          ]
        : []),
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
    // A field gets its keys (a MathLive one too: its keys arrive from the math-field);
    // root stops them on their way out to the board.
    const field =
      target instanceof HTMLInputElement ||
      (target instanceof Element && target.closest('math-field'));
    if (field && key !== 'escape') return;
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
    write,
  };
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
