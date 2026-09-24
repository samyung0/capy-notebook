import { useEditorRef, useEditorSelector } from 'platejs/react';
import { ToolbarButton as SharedToolbarButton } from '@/components/ui/ToolbarButton';

/** Shortcuts that are actually registered on the Plate editor. */
export const EDITOR_SHORTCUTS = {
  ai: 'Ctrl/Cmd+J',
  bold: 'Ctrl/Cmd+B',
  code: 'Ctrl/Cmd+E',
  highlight: 'Ctrl/Cmd+Shift+H',
  italic: 'Ctrl/Cmd+I',
  redo: 'Ctrl/Cmd+Shift+Z',
  strikethrough: 'Ctrl/Cmd+Shift+X',
  underline: 'Ctrl/Cmd+U',
  undo: 'Ctrl/Cmd+Z',
} as const;

export function ToolbarButton(
  props: React.ComponentProps<typeof SharedToolbarButton>
) {
  return (
    <SharedToolbarButton
      data-plate-prevent-deselect
      onMouseDown={(event) => event.preventDefault()}
      {...props}
    />
  );
}

export function MarkToolbarButton({
  markKey,
  ...props
}: Omit<React.ComponentProps<typeof ToolbarButton>, 'active' | 'onClick'> & {
  markKey: string;
}) {
  const editor = useEditorRef();
  const active = useEditorSelector((ed) => !!ed.api.mark(markKey), [markKey]);

  return (
    <ToolbarButton
      active={active}
      onClick={() => {
        editor.tf.focus();
        editor.tf.toggleMark(markKey);
      }}
      {...props}
    />
  );
}
