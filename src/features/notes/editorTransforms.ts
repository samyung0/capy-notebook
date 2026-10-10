import { toggleCodeBlock } from '@platejs/code-block';
import { KEYS, type SlateEditor } from 'platejs';

/**
 * Code blocks require a nested code_line element. A generic toggleBlock call
 * only changes the current element's type and leaves its text children direct,
 * which breaks code-block keyboard, paste, and decoration behavior.
 */
export function toggleEditorBlock(editor: SlateEditor, type: string) {
  if (type === editor.getType(KEYS.codeBlock)) {
    toggleCodeBlock(editor);
    return;
  }

  editor.tf.toggleBlock(type);
}

/**
 * The range the user sees selected. Slate copies the native selection on a
 * 100ms throttle, so a click or shortcut can arrive before its stored
 * selection catches up; when the native selection is outside this editor the
 * stored one stands.
 */
export function liveSelection(editor: SlateEditor) {
  const native = editor.api.getWindow()?.getSelection();
  return native &&
    editor.api.hasSelectableTarget(native.anchorNode) &&
    editor.api.hasTarget(native.focusNode)
    ? editor.api.toSlateRange(native, {
        exactMatch: false,
        suppressThrow: true,
      })
    : editor.selection;
}

/** Every leaf mark the editor can produce; "Clear formatting" strips them all. */
export const CLEARABLE_MARK_KEYS = [
  KEYS.bold,
  KEYS.italic,
  KEYS.underline,
  KEYS.strikethrough,
  KEYS.code,
  KEYS.sub,
  KEYS.sup,
  KEYS.highlight,
  KEYS.kbd,
  KEYS.color,
  KEYS.backgroundColor,
  KEYS.fontSize,
  KEYS.fontFamily,
];

/**
 * removeMarks without explicit keys only clears the pending caret marks (what
 * the next typed character would get); stripping marks from an expanded
 * selection requires the explicit key list.
 */
export function clearEditorFormatting(editor: SlateEditor) {
  editor.tf.removeMarks(CLEARABLE_MARK_KEYS);
}
