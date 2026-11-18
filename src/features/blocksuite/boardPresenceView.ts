import { getCommonBound } from '@blocksuite/affine/global/gfx';
import { type BlockStdScope, TextSelection } from '@blocksuite/affine/std';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import type * as Y from 'yjs';
import type { BoardUploads } from './boardUploads';

type Box = { h: number; w: number; x: number; y: number };
const noop = () => {};
type TextPoint = { index: number; text: Y.Text };

/**
 * What a canvas's presence reads of its board (Epo 2026-11-18;
 * src/features/canvas/boardPresence.ts sends, BoardPresenceMarks.tsx draws):
 * the viewport, the selection, the text caret, and where an element or a
 * stretch of text sits. Everything is in board units, so a mark placed once
 * follows the viewport by the layer's transform alone. Only `textBoxes` reads
 * the page's layout.
 */
export function boardPresenceView(
  std: BlockStdScope,
  gfx: GfxController,
  host: HTMLElement,
  uploads: BoardUploads | null
) {
  const { store } = std;
  const { viewport } = gfx;
  const textOf = (blockId: string) => store.getModelById(blockId)?.text?.yText;
  const point = (blockId: string, index: number): TextPoint | null => {
    const text = textOf(blockId);
    return text ? { index, text } : null;
  };
  /** Where `at` is in the page, when its text is a block's own and drawn as
   * text (a note's paragraph or list item): a shape's or a connector's is
   * painted on the canvas and has none. */
  const rangeAt = ({ index, text }: TextPoint) => {
    // A block's map sits in the document's `blocks` under its id.
    const id = text.parent?._item?.parentSub;
    if (!id || textOf(id) !== text) return null;
    return (
      std.range
        .queryInlineEditorByPath(id)
        ?.toDomRange({ index: Math.min(index, text.length), length: 0 }) ?? null
    );
  };
  // Read off the list itself: `selection.find` makes a signal at each call,
  // and BlockSuite's selection changes with every pointer move.
  const textSelection = () =>
    std.selection.value.find((selection) => selection.is(TextSelection));
  const toBox = (rect: DOMRect): Box => {
    const [x, y] = viewport.toModelCoordFromClientCoord([rect.left, rect.top]);
    const scale = viewport.zoom * viewport.viewScale;
    return { h: rect.height / scale, w: rect.width / scale, x, y };
  };
  return {
    /** The element or block with `ids`' box, turned ones by the box they turn
     * into; null when the board holds none of them. */
    boxOf: (ids: readonly string[]): Box | null => {
      const bounds = ids.flatMap((id) => {
        const element = gfx.getElementById(id);
        return element && 'elementBound' in element
          ? [element.elementBound]
          : [];
      });
      const all = getCommonBound(bounds);
      return all && { h: all.h, w: all.w, x: all.x, y: all.y };
    },
    /** The text selection: where it began and where its caret is, the same
     * point twice when nothing is selected; null without one. */
    caret: (): { anchor: TextPoint; focus: TextPoint } | null => {
      const selection = textSelection();
      if (!selection) return null;
      const { from, reverse, to } = selection;
      const last = to ?? from;
      const start = point(from.blockId, from.index);
      const end = point(last.blockId, last.index + last.length);
      if (!(start && end)) return null;
      return reverse
        ? { anchor: end, focus: start }
        : { anchor: start, focus: end };
    },
    /** The board's element: pointers are heard on it and the marks sit in it. */
    host,
    /** Calls `listener` when the selected elements or the text selection
     * change; returns the undo. BlockSuite's own selection also changes with
     * every pointer move (its cursor), which is not passed on. */
    onSelection: (listener: () => void) => {
      let text = textSelection();
      const elements = gfx.selection.slots.updated.subscribe(listener);
      const selections = std.selection.slots.changed.subscribe(() => {
        const next = textSelection();
        if (next === text) return;
        text = next;
        listener();
      });
      return () => {
        elements.unsubscribe();
        selections.unsubscribe();
      };
    },
    /** Calls `listener` when an image starts or stops going up (`uploads`);
     * returns the undo. */
    onUploads: (listener: () => void) => uploads?.onChange(listener) ?? noop,
    /** Calls `listener` when the board pans, zooms or is resized; returns the
     * undo. */
    onView: (listener: () => void) => {
      const moved = viewport.viewportUpdated.subscribe(listener);
      const sized = viewport.sizeUpdated.subscribe(listener);
      return () => {
        moved.unsubscribe();
        sized.unsubscribe();
      };
    },
    /** The selected elements' and blocks' ids. */
    selected: () => gfx.selection.selectedIds,
    /** Where a caret at `focus` is drawn, and the lines selected from
     * `anchor` to it; null when `focus` is in no text drawn on the page (a
     * shape's, or a note out of view). Reads the page's layout. */
    textBoxes: (
      focus: TextPoint,
      anchor: TextPoint | null
    ): { caret: Box; range: Box[] } | null => {
      const at = rangeAt(focus);
      if (!at) return null;
      const lines = [...at.getClientRects()];
      // A caret between two lines has a place on each: the later one, where
      // typing goes. One with no place of its own (an empty line) stands at
      // its line's start.
      const line =
        lines.at(-1) ??
        at.startContainer.parentElement?.getBoundingClientRect();
      if (!line?.height) return null;
      const caret = { ...toBox(line), w: 0 };
      const from = anchor && rangeAt(anchor);
      if (!from) return { caret, range: [] };
      const forward = from.compareBoundaryPoints(Range.START_TO_START, at) <= 0;
      const [first, last] = forward ? [from, at] : [at, from];
      const range = host.ownerDocument.createRange();
      range.setStart(first.startContainer, first.startOffset);
      range.setEnd(last.startContainer, last.startOffset);
      return {
        caret,
        range: [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map(toBox),
      };
    },
    /** A point of the page (client coordinates) in board units. Reads no
     * layout: the viewport keeps its own place. */
    toBoard: (clientX: number, clientY: number): [number, number] => {
      const [x, y] = viewport.toModelCoordFromClientCoord([clientX, clientY]);
      return [x, y];
    },
    /** Where the images this tab is storing will land, in board units: none
     * while the board takes no edits. */
    uploads: (): Box[] => uploads?.boxes() ?? [],
    /** The viewport: the zoom, where the board's origin sits in the board's
     * element, and that element's width, in its own pixels. */
    view: () => {
      const { viewScale, zoom } = viewport;
      return {
        left: viewport.translateX,
        top: viewport.translateY,
        width: viewport.width / viewScale,
        zoom,
      };
    },
  };
}
