import type { BlockStdScope } from '@blocksuite/affine/std';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { Cancel01Icon, Image01Icon } from '@hugeicons/core-free-icons';
import { html, nothing, render } from 'lit';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { hugeIcon } from './boardTools';

type Box = { h: number; w: number; x: number; y: number };

type Upload = { box: Box; percent: number; why?: string };

/** The boards on the page by their BlockSuite scope, for BlockSuite's upload
 * hook (local change 70), which names the scope it adds an image on. */
export const boardUploads = new WeakMap<BlockStdScope, BoardUploads>();

/**
 * An image while its file is stored (Epo 2026-11-06, as a note's placeholder
 * does): a box at the place and size its block will take, "42% uploaded" with
 * a bar, until the block lands. The box is the page's own, in no one's stored
 * board, so a refused upload leaves nothing behind: its box says why until it
 * is closed. Peers see the boxes still uploading through the board's presence
 * (`boxes`, src/features/canvas/boardPresence.ts).
 *
 * Boxes are placed in the board's pixels, again on each pan or zoom while
 * there are any, so their text stays its size at any zoom.
 */
export class BoardUploads {
  readonly element = document.createElement('div');
  private readonly uploads = new Map<Blob, Upload>();
  private readonly listeners = new Set<() => void>();
  private readonly gfx: GfxController;
  private readonly locked: () => boolean;
  private readonly moved: { unsubscribe: () => void };

  /** `locked`: the board takes no edits now, so BlockSuite stores nothing. */
  constructor(gfx: GfxController, locked: () => boolean) {
    this.gfx = gfx;
    this.locked = locked;
    this.element.className = 'capy-uploads';
    this.moved = gfx.viewport.viewportUpdated.subscribe(() => {
      if (this.uploads.size) this.draw();
    });
  }

  /** A file about to be stored, its block to take `xywh`: answers what is
   * called as the block lands (no error) or the file is refused. A board that
   * takes no edits shows none. */
  begin(file: Blob, xywh: string) {
    if (this.locked()) return;
    const [x, y, w, h] = JSON.parse(xywh) as number[];
    this.uploads.set(file, { box: { h, w, x, y }, percent: 0 });
    this.changed();
    return (error?: unknown) => {
      const upload = this.uploads.get(file);
      if (!upload) return;
      if (error === undefined) this.uploads.delete(file);
      else upload.why = errorCopy(error, m.workspace_canvas_image_refused());
      this.changed();
    };
  }

  /** How much of `file` has gone up, 0 to 100. */
  progress(file: Blob, percent: number) {
    const upload = this.uploads.get(file);
    if (!upload || upload.why || upload.percent === percent) return;
    upload.percent = percent;
    this.draw();
  }

  /** The boxes still uploading, in board units: what peers are told. None
   * while the board takes no edits: a read channel sends no uploads. */
  boxes(): Box[] {
    if (this.locked()) return [];
    return [...this.uploads.values()].flatMap(({ box, why }) =>
      why ? [] : [box]
    );
  }

  /** Calls `listener` when a box comes or goes; returns the undo. */
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Draws the boxes again and tells the listeners (also as the board locks
   * or unlocks). */
  changed() {
    this.draw();
    for (const listener of this.listeners) listener();
  }

  private readonly draw = () => {
    const { viewport } = this.gfx;
    const { zoom } = viewport;
    render(
      [...this.uploads].map(([file, { box, percent, why }]) => {
        const [left, top] = viewport.toViewCoord(box.x, box.y);
        const style = `left:${left}px;top:${top}px;width:${box.w * zoom}px;height:${box.h * zoom}px`;
        return why
          ? html`<div class="capy-upload capy-upload-refused" role="alert" style=${style}>
              <button
                aria-label=${m.action_close()}
                class="capy-upload-close"
                title=${m.action_close()}
                type="button"
                @click=${() => {
                  this.uploads.delete(file);
                  this.changed();
                }}
              >
                ${hugeIcon(Cancel01Icon)}
              </button>
              ${hugeIcon(Image01Icon)}
              <span>${m.workspace_canvas_image_refused()}</span>
              ${
                why === m.workspace_canvas_image_refused()
                  ? nothing
                  : html`<span class="capy-upload-why">${why}</span>`
              }
            </div>`
          : html`<div class="capy-upload" role="status" style=${style}>
              ${hugeIcon(Image01Icon)}
              <span>${m.editor_percent_uploaded({ percent: String(percent) })}</span>
              <div aria-hidden="true" class="capy-upload-bar">
                <div style=${`width:${percent}%`}></div>
              </div>
            </div>`;
      }),
      this.element
    );
  };

  dispose() {
    this.moved.unsubscribe();
    this.listeners.clear();
    this.uploads.clear();
    render(nothing, this.element);
    this.element.remove();
  }
}
