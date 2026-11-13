import {
  DefaultTool,
  EdgelessCRUDIdentifier,
} from '@blocksuite/affine-block-surface';
import {
  DEFAULT_NOTE_HEIGHT,
  DEFAULT_NOTE_WIDTH,
  INLINE_NOTE_FILL,
  NoteDisplayMode,
  NoteShadow,
  StrokeStyle,
} from '@blocksuite/affine-model';
import { focusTextModel } from '@blocksuite/affine-rich-text';
import { TelemetryProvider } from '@blocksuite/affine-shared/services';
import type { NoteChildrenFlavour } from '@blocksuite/affine-shared/types';
import { handleNativeRangeAtPoint } from '@blocksuite/affine-shared/utils';
import { type IPoint, Point, serializeXYWH } from '@blocksuite/global/gfx';
import type { BlockStdScope, PointerEventState } from '@blocksuite/std';
import {
  BaseTool,
  type GfxBlockElementModel,
  GfxControllerIdentifier,
} from '@blocksuite/std/gfx';

export type NoteToolOption = {
  childFlavour: NoteChildrenFlavour;
  childType: string | null;
  tip: string;
};

/** Capy (local change 53): the first line's height of a note starting with each
 * kind, in model units on the board (a code block has none, and lays out as text). */
const FIRST_LINE: Record<string, number> = {
  h1: 36,
  h2: 36,
  h3: 32,
  h4: 30,
  h5: 28,
  h6: 26,
  quote: 26,
};
const firstLineOf = (childType: string | null) =>
  (childType && FIRST_LINE[childType]) || 22.8;

// Capy (local change 53; Epo 2026-11-13): the tool shows the plus cursor alone,
// like a text tool: no note follows the pointer and no box is dragged out. A click
// (or a drag, at its start) places an inline note with its first line starting at
// the pointer. AFFiNE drew a preview box and let a drag size the note.
export class NoteTool extends BaseTool<NoteToolOption> {
  static override toolName = 'affine:note';

  override click(e: PointerEventState): void {
    this._place(e.point.x, e.point.y);
  }

  override dragEnd() {
    const { startX, startY } = this.controller.draggingArea$.peek();
    this._place(...this.gfx.viewport.toViewCoord(startX, startY));
  }

  private _place(viewX: number, viewY: number) {
    const { childFlavour, childType } = this.activatedOption;
    addNote(this.std, new Point(viewX, viewY), {
      childFlavour,
      childType,
      line: firstLineOf(childType),
    });
  }
}

type NoteOptions = {
  childFlavour: NoteChildrenFlavour;
  childType: string | null;
  /** The first line's height: the note is placed with it centred on the point. */
  line: number;
};

function addNote(std: BlockStdScope, point: Point, options: NoteOptions) {
  const noteId = addNoteAtPoint(std, point, {
    height: options.line,
    offsetY: options.line / 2,
  });

  const gfx = std.get(GfxControllerIdentifier);
  const doc = std.store;

  const blockId = doc.addBlock(
    options.childFlavour,
    { type: options.childType },
    noteId
  );
  gfx.tool.setTool(DefaultTool);

  // Wait for edgelessTool updated
  requestAnimationFrame(() => {
    const blocks =
      (doc.root?.children.filter(
        child => child.flavour === 'affine:note'
      ) as GfxBlockElementModel[]) ?? [];
    const element = blocks.find(b => b.id === noteId);
    if (element) {
      gfx.selection.set({
        elements: [element.id],
        editing: true,
      });

      // Waiting dom updated, `note mask` is removed
      if (blockId) {
        focusTextModel(gfx.std, blockId);
      } else {
        // Cannot reuse `handleNativeRangeClick` directly here,
        // since `retargetClick` will re-target to pervious editor
        handleNativeRangeAtPoint(point.x, point.y);
      }
    }
  });
}

function addNoteAtPoint(
  std: BlockStdScope,
  /**
   * The point is in browser coordinate
   */
  point: IPoint,
  options: {
    width?: number;
    height?: number;
    parentId?: string;
    noteIndex?: number;
    offsetX?: number;
    offsetY?: number;
    scale?: number;
  } = {}
) {
  const gfx = std.get(GfxControllerIdentifier);
  const crud = std.get(EdgelessCRUDIdentifier);
  const {
    width = DEFAULT_NOTE_WIDTH,
    height = DEFAULT_NOTE_HEIGHT,
    offsetX = 0,
    offsetY = 0,
    parentId = gfx.doc.root?.id,
    noteIndex,
    scale = 1,
  } = options;
  const [x, y] = gfx.viewport.toModelCoord(point.x, point.y);
  const blockId = crud.addBlock(
    'affine:note',
    {
      xywh: serializeXYWH(
        x - offsetX * scale,
        y - offsetY * scale,
        width,
        height
      ),
      displayMode: NoteDisplayMode.EdgelessOnly,
      // Capy (local change 52): a new note is inline, whatever note was styled
      // last; the rest of its style (corner, border size) is the last one's.
      background: INLINE_NOTE_FILL,
      edgeless: {
        style: { borderStyle: StrokeStyle.None, shadowType: NoteShadow.None },
      },
    },
    parentId,
    noteIndex
  );

  std.getOptional(TelemetryProvider)?.track('CanvasElementAdded', {
    control: 'canvas:draw',
    page: 'whiteboard editor',
    module: 'toolbar',
    segment: 'toolbar',
    type: 'note',
  });

  return blockId;
}
