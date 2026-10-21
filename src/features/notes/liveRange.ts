import {
  type RelativeRange,
  relativeRangeToSlateRange,
  type YjsEditor,
} from '@slate-yjs/core';
import * as Y from 'yjs';

/** The type, or a type holding it, was deleted: its block left the document. */
function removed(type: Y.AbstractType<unknown>) {
  for (let item = type._item; item; ) {
    if (item.deleted) return true;
    item = (item.parent as Y.AbstractType<unknown>)._item;
  }
  return false;
}

/**
 * `range` in the document as it is now, or null when either end lies in a
 * block that left it (slate-yjs would place such an end at the start of the
 * last block). Text removed inside a live block resolves to where it was, and
 * a block brought back by Undo resolves again.
 */
export function liveSlateRange(editor: YjsEditor, range: RelativeRange) {
  const doc = editor.sharedRoot?.doc;
  if (!doc) return null;
  for (const position of [range.anchor, range.focus]) {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      position,
      doc
    );
    if (!absolute || removed(absolute.type)) return null;
  }
  try {
    return relativeRangeToSlateRange(editor.sharedRoot, editor, range);
  } catch {
    // An anchor this document's shape no longer matches.
    return null;
  }
}
