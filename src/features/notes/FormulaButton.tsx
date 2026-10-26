import type { TElement } from 'platejs';
import { useEditorRef, useFocused, useSelected } from 'platejs/react';
import { cn } from '@/lib/cn';

/** A formula in an editor while it is not being edited. A click selects it
 * as the editor's selection, so Delete or Backspace removes it like any void
 * node, and clicking elsewhere deselects it; a double click, or Enter or
 * Space on the focused button, edits it. Shared by the note and question
 * editors. */
export function FormulaButton({
  element,
  display,
  label,
  onEdit,
  children,
}: {
  element: TElement;
  display: boolean;
  label: string;
  /** Opens the formula's editor; a display formula passes its drawn height
   * so the editor keeps it. */
  onEdit: (height: number) => void;
  children: React.ReactNode;
}) {
  const editor = useEditorRef();
  const selected = useSelected();
  const focused = useFocused();
  return (
    <button
      aria-label={label}
      className={cn(
        'max-w-full cursor-default touch-manipulation rounded-sm text-inherit outline-offset-2',
        display && 'block min-h-14 w-full px-6 py-4',
        // The question dialog's selected block outline.
        selected && focused && 'outline-2 outline-action-accent'
      )}
      onClick={(event) => {
        // Keyboard clicks (detail 0) and double clicks edit.
        if (event.detail !== 1)
          onEdit(event.currentTarget.getBoundingClientRect().height);
      }}
      // The editor keeps focus: the press selects the node instead.
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Focus first: a note restores its last selection on focus.
        editor.tf.focus();
        const at = editor.api.findPath(element);
        if (at) editor.tf.select(at);
      }}
      type="button"
    >
      {children}
    </button>
  );
}
