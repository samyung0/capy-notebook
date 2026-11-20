import { EdgelessClipboardController } from '@blocksuite/affine/blocks/root';
import { DefaultTool } from '@blocksuite/affine/blocks/surface';
import type { PointerEventState } from '@blocksuite/affine/std';
import {
  BaseTool,
  type GfxController,
  InteractivityIdentifier,
} from '@blocksuite/affine/std/gfx';
import { Copy01Icon } from '@hugeicons/core-free-icons';
import { html, nothing, render } from 'lit';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { hugeIcon } from './boardTools';

/** A finger on a board that takes no edits: one finger pans, as it did, and a
 * tap selects what it is on, as a click does (DefaultTool, local change 71). */
export class TapPanTool extends BaseTool {
  static override toolName = 'capy-tap-pan';

  private last: [number, number] | null = null;

  override click(event: PointerEventState) {
    const interactivity = this.std.getOptional(InteractivityIdentifier);
    if (!interactivity?.handleElementSelection(event))
      this.gfx.selection.clear();
  }

  override dragStart(event: PointerEventState) {
    this.last = [event.x, event.y];
  }

  override dragMove(event: PointerEventState) {
    if (!this.last) return;
    const [x, y] = this.last;
    this.last = [event.x, event.y];
    const { zoom } = this.gfx.viewport;
    this.gfx.viewport.applyDeltaCenter(
      (x - event.x) / zoom,
      (y - event.y) / zoom
    );
  }

  override dragEnd() {
    this.last = null;
  }
}

/** The bar's gap above the selection's frame, in pixels. */
const ABOVE = 12;
/** Room the board's chrome takes along its top, in pixels. */
const CHROME = 56;

/**
 * A board that takes no edits still selects and copies (as a note and an
 * Office file do when read-only): a mouse or pen click selects, a drag on
 * empty board selects by its box (DefaultTool, which moves nothing on a store
 * that takes no edits, local change 65), ⌘C copies; a finger pans and a tap
 * selects (TapPanTool). The tool is picked by each press's pointer. A bar
 * with one Copy sits above what is selected, in place of the toolbar, and
 * puts on the clipboard what an editor's copy puts there (local change 71).
 */
export function readOnlyCopy(
  gfx: GfxController,
  board: HTMLElement,
  locked: () => boolean
) {
  const bar = document.createElement('div');
  bar.className = 'capy-copy-bar';
  const draw = () => {
    const { selection, viewport } = gfx;
    const bound = selection.selectedBound;
    const shown =
      locked() &&
      !selection.editing &&
      selection.selectedElements.length > 0 &&
      bound.w + bound.h > 0;
    if (!shown) {
      render(nothing, bar);
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const [left, top] = viewport.toViewCoord(bound.x, bound.y);
    const width = bound.w * viewport.zoom;
    const height = bound.h * viewport.zoom;
    // Above the frame, or under it when the board's top has no room.
    const above = top - ABOVE > CHROME;
    bar.style.left = `${left + width / 2}px`;
    bar.style.top = above ? `${top - ABOVE}px` : `${top + height + ABOVE}px`;
    bar.dataset.side = above ? 'above' : 'below';
    render(
      html`<button type="button" @click=${copy}>
        ${hugeIcon(Copy01Icon)} ${m.action_copy()}
      </button>`,
      bar
    );
  };
  const copy = () => {
    const clipboard = gfx.std.getOptional(EdgelessClipboardController);
    if (!clipboard) return;
    clipboard.copySelection().then(
      () => userToast({ title: m.chrome_toast_copied(), variant: 'success' }),
      (error: unknown) => {
        console.error(error);
        userToast({ title: m.drawing_board_copy_failed(), variant: 'error' });
      }
    );
  };
  // The tool by the press's pointer, before BlockSuite hears the press. A
  // change of tool clears the selection, so it changes only with the pointer.
  const pick = (event: PointerEvent) => {
    if (!locked() || event.button !== 0) return;
    const touch = event.pointerType === 'touch';
    const name = touch ? TapPanTool.toolName : DefaultTool.toolName;
    if (gfx.tool.currentToolName$.peek() === name) return;
    if (touch) gfx.tool.setTool(TapPanTool);
    else gfx.tool.setTool(DefaultTool);
  };
  board.addEventListener('pointerdown', pick, true);
  const selected = gfx.selection.slots.updated.subscribe(draw);
  const moved = gfx.viewport.viewportUpdated.subscribe(draw);
  draw();
  return {
    bar,
    dispose: () => {
      board.removeEventListener('pointerdown', pick, true);
      selected.unsubscribe();
      moved.unsubscribe();
      render(nothing, bar);
      bar.remove();
    },
    /** Again from the selection and the lock. */
    draw,
  };
}
