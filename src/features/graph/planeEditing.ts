import type { UndoTarget } from '@/features/collaboration/undo';
import type { FigureBinding } from '@/features/questions/figureBinding';
import type { Vec } from './model';

/**
 * A canvas plane card opened in the graph editor (Epo 2026-11-17: one editor
 * for the canvas, notes and quizzes). The board hands the page this; the page
 * renders `GraphEditor` into `root`, over the board, where the plane's editor
 * always opened.
 */
export type PlaneEditing = {
  /** The card's elements and paper, written a step at a time. */
  binding: FigureBinding;
  /** The camera the card shows: the plane point at its middle and its scale,
   * the menu's 100%. */
  camera: { centre: Vec; ppu: number };
  /** Ends editing: the camera as left is written, and the board takes its
   * history back. */
  close: (camera: { centre: Vec; ppu: number }) => void;
  /** Undo and Redo while it is open: only the steps taken in it. */
  history: UndoTarget;
  /** The objects list: workspace canvases only (Epo 2026-11-13, L2). */
  list: boolean;
  /** Over the board, filling it; Escape no one took closes the editor. */
  root: HTMLElement;
};

/** Shows `editing` on the page; returns what takes it away again when the
 * board closes it (leaving the page, saving the board). */
export type PlaneOpener = (editing: PlaneEditing) => () => void;
