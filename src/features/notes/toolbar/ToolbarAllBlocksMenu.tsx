import { KEYS } from 'platejs';
import { useState } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { ToolbarPopoverGroup } from '@/components/ui/ToolbarPopover';
import { useNoteBlockDialogs } from '@/features/notes/blocks/dialogContext';
import type { CollaborationActions } from '@/features/notes/Collaboration';
import { EditorIcon } from '@/features/notes/EditorIcon';
import type {
  EDITOR_COMMANDS,
  EditorCommand,
} from '@/features/notes/editorCommands';
import { clearEditorFormatting } from '@/features/notes/editorTransforms';
import { WIDGET_GROUPS } from '@/features/notes/noteEditorPrefs';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverRow,
} from '@/features/notes/toolbar/ToolbarPopover';
import { m } from '@/i18n';

export function ToolbarAllBlocksMenu({
  allBlockCommands,
  collaboration,
  canEdit,
  editor,
}: {
  allBlockCommands: EditorCommand[];
  collaboration: CollaborationActions | null;
  canEdit: boolean;
  editor: AnyEditor;
}) {
  const dialogs = useNoteBlockDialogs();
  const [moreOpen, setMoreOpen] = useState(false);
  const runAllBlockCommand = (command: (typeof EDITOR_COMMANDS)[number]) => {
    setMoreOpen(false);
    command.run(editor, dialogs);
  };
  const mark = (key: string) => {
    editor.tf.focus();
    editor.tf.toggleMark(key);
  };
  const clearFormatting = () => {
    editor.tf.focus();
    clearEditorFormatting(editor);
  };
  return (
    <Popover modal={false} onOpenChange={setMoreOpen} open={moreOpen}>
      <PopoverTrigger asChild>
        <ToolbarButton label={m.editor_all_blocks()}>
          <EditorIcon name="plus" />
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="start"
        className="max-h-[min(80vh,38rem)] w-72 overflow-y-auto pt-2"
        data-all-blocks-menu
        open={moreOpen}
      >
        {WIDGET_GROUPS.map((group) => {
          const commands = allBlockCommands.filter(
            (command) => command.group === group.id
          );
          const hasComment = group.id === 'general' && canEdit && collaboration;
          const hasInlineMarks = group.id === 'inlineElements';
          if (!commands.length && !hasComment && !hasInlineMarks) {
            return null;
          }

          return (
            <ToolbarPopoverGroup key={group.id} label={group.label}>
              {commands.map((command) => (
                <ToolbarPopoverRow
                  icon={<EditorIcon name={command.icon} />}
                  key={command.id}
                  label={command.label}
                  onClick={() => runAllBlockCommand(command)}
                  shortcut={command.shortcut}
                />
              ))}
              {hasComment && (
                <ToolbarPopoverRow
                  icon={<EditorIcon name="commentAdd" />}
                  label={m.editor_comment()}
                  onClick={() => {
                    setMoreOpen(false);
                    collaboration.openComment();
                  }}
                  shortcut="Ctrl/Cmd+Shift+M"
                />
              )}
              {hasInlineMarks && (
                <>
                  <ToolbarPopoverRow
                    icon={<EditorIcon name="subscript" />}
                    label={m.editor_subscript()}
                    onClick={() => mark(KEYS.sub)}
                  />
                  <ToolbarPopoverRow
                    icon={<EditorIcon name="superscript" />}
                    label={m.editor_superscript()}
                    onClick={() => mark(KEYS.sup)}
                  />
                </>
              )}
            </ToolbarPopoverGroup>
          );
        })}
        <div className="mt-1 border-divider border-t pt-1">
          <ToolbarPopoverRow
            label={m.editor_clear_formatting()}
            onClick={clearFormatting}
          />
        </div>
      </ToolbarPopoverContent>
    </Popover>
  );
}
