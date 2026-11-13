import { EdgelessCRUDIdentifier } from '@blocksuite/affine-block-surface';
import {
  DefaultTheme,
  INLINE_NOTE_FILL,
  isInlineNote,
  type NoteBlockModel,
  type NoteProps,
  NoteShadow,
  StrokeStyle,
} from '@blocksuite/affine-model';
import { Bound } from '@blocksuite/global/gfx';
import type { BlockStdScope } from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

const CARD_PADDING_X = 10;

/** Capy (local change 52): turns notes inline (clear fill, no shadow, no border)
 * or into cards (the default fill, the Box shadow, corner 8), as one undo step. */
export function setNotesInline(
  std: BlockStdScope,
  notes: NoteBlockModel[],
  inline: boolean
) {
  std.store.captureSync();
  const crud = std.get(EdgelessCRUDIdentifier);
  for (const note of notes) {
    const { edgeless, xywh } = note.props;
    // A card keeps the inline text's lines: its width grows by the card's 10 px
    // padding each side (the board's card padding, drawingBoard.css).
    const bound = Bound.deserialize(xywh);
    if (!inline && isInlineNote(note.props))
      bound.w += 2 * CARD_PADDING_X * (edgeless.scale ?? 1);
    crud.updateElement(note.id, {
      xywh: bound.serialize(),
      background: inline ? INLINE_NOTE_FILL : DefaultTheme.noteBackgrounColor,
      edgeless: {
        ...edgeless,
        style: {
          ...edgeless.style,
          borderStyle: StrokeStyle.None,
          ...(inline
            ? { shadowType: NoteShadow.None }
            : { borderRadius: 8, shadowType: NoteShadow.Box }),
        },
      },
    } satisfies Partial<NoteProps>);
  }
  // The selection frame works out its handles when the selection changes (the
  // same selection set again changes nothing): a card has side handles, an
  // inline note only corners (local change 55).
  const { selection } = std.get(GfxControllerIdentifier);
  const elements = [...selection.selectedIds];
  selection.clear();
  selection.set({ elements, editing: false });
}
