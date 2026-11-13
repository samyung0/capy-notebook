import {
  getSurfaceComponent,
  ToolOverlay,
} from '@blocksuite/affine-block-surface';
import {
  type Color,
  DEFAULT_NOTE_WIDTH,
  DefaultTheme,
} from '@blocksuite/affine-model';
import { ThemeProvider } from '@blocksuite/affine-shared/services';
import type { XYWH } from '@blocksuite/global/gfx';
import type { GfxController } from '@blocksuite/std/gfx';
import { effect } from '@preact/signals-core';
import { Subject } from 'rxjs';

import type { NoteTool } from '../note-tool';
import {
  NOTE_OVERLAY_CORNER_RADIUS,
  NOTE_OVERLAY_STOKE_COLOR,
  NOTE_OVERLAY_TEXT_COLOR,
  notePreviewOf,
} from './consts.js';

export class NoteOverlay extends ToolOverlay {
  backgroundColor = 'transparent';

  text = '';

  /** The kind of block the note starts with, which sets the preview's layout. */
  childType: string | null = null;

  constructor(gfx: GfxController, background: Color) {
    super(gfx);
    this.backgroundColor = gfx.std
      .get(ThemeProvider)
      .getColorValue(background, DefaultTheme.noteBackgrounColor, true);
    this.disposables.add(
      effect(() => {
        // when change note child type, update overlay text
        if (this.gfx.tool.currentToolName$.value !== 'affine:note') return;
        const tool = this.gfx.tool.currentTool$.peek() as NoteTool;
        this.text = this._getOverlayText(tool.activatedOption.tip);
        this.childType = tool.activatedOption.childType;
        const surface = getSurfaceComponent(this.gfx.std);
        surface?.refresh();
      })
    );
  }

  private _getOverlayText(text: string): string {
    return text[0].toUpperCase() + text.slice(1);
  }

  // Capy (local change 48): the preview is the empty note a click places,
  // centred on the pointer (NoteTool.click), drawn as the board draws it: its
  // hairline and corner, and the placeholder in the block's font and place.
  // AFFiNE drew a 100x50 box below-right of it.
  override render(ctx: CanvasRenderingContext2D): void {
    ctx.globalAlpha = this.globalAlpha;
    const { height, left, line, size, top, weight } = notePreviewOf(
      this.childType
    );
    const width = DEFAULT_NOTE_WIDTH;
    const overlayX = this.x - width / 2;
    const overlayY = this.y - height / 2;
    const host = getComputedStyle(this.gfx.std.host);
    ctx.fillStyle = this.backgroundColor;
    ctx.strokeStyle = host.getPropertyValue(NOTE_OVERLAY_STOKE_COLOR);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(
      overlayX,
      overlayY,
      width,
      height,
      NOTE_OVERLAY_CORNER_RADIUS
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = host.getPropertyValue(NOTE_OVERLAY_TEXT_COLOR);
    ctx.font = `${weight} ${size}px ${host.fontFamily}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.text, overlayX + left, overlayY + top + line / 2);
  }
}

export class DraggingNoteOverlay extends NoteOverlay {
  height: number;

  slots: {
    draggingNoteUpdated: Subject<{ xywh: XYWH }>;
  };

  width: number;

  constructor(gfx: GfxController, background: Color) {
    super(gfx, background);
    this.slots = {
      draggingNoteUpdated: new Subject<{
        xywh: XYWH;
      }>(),
    };
    this.width = 0;
    this.height = 0;
    this.disposables.add(
      this.slots.draggingNoteUpdated.subscribe(({ xywh }) => {
        [this.x, this.y, this.width, this.height] = xywh;
        const surface = getSurfaceComponent(this.gfx.std);
        surface?.refresh();
      })
    );
  }

  override render(ctx: CanvasRenderingContext2D): void {
    // draw a rounded rectangle with provided background color and xywh
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = this.backgroundColor;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(this.x, this.y, this.width, this.height, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
