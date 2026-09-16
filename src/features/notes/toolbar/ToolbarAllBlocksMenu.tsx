import { KEYS } from 'platejs';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
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
  MenuRow,
  ToolbarMenuContent,
} from '@/features/notes/toolbar/ToolbarMenuRow';
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
    <DropdownMenu modal={false} onOpenChange={setMoreOpen} open={moreOpen}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton className="w-fit" label={m.editor_all_blocks()}>
          <EditorIcon name="plus" />
          <EditorIcon
            className="size-3! text-fg-secondary"
            name="chevronDown"
          />
        </ToolbarButton>
      </DropdownMenuTrigger>
      <ToolbarMenuContent
        align="start"
        className="max-h-[min(80vh,38rem)] w-72 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-pop"
        data-all-blocks-menu
      >
        {WIDGET_GROUPS.map((group) => {
          const commands = allBlockCommands.filter(
            (command) => command.group === group.id
          );
          const hasComment = group.id === 'general' && canEdit && collaboration;
          if (!commands.length && !hasComment) {
            return null;
          }

          return (
            <section aria-labelledby={`all-blocks-${group.id}`} key={group.id}>
              <h3
                className="px-2 pt-2 pb-1 font-semibold text-fg-muted text-xs tracking-wide first:pt-1"
                id={`all-blocks-${group.id}`}
              >
                {group.label}
              </h3>
              {commands.map((command) => (
                <MenuRow
                  icon={<EditorIcon name={command.icon} />}
                  key={command.id}
                  label={command.label}
                  onClick={() => runAllBlockCommand(command)}
                  shortcut={command.shortcut}
                />
              ))}
              {hasComment && (
                <MenuRow
                  className="mt-1 border-divider border-t pt-2"
                  icon={<EditorIcon name="commentAdd" />}
                  label={m.editor_comment()}
                  onClick={() => {
                    setMoreOpen(false);
                    collaboration.openComment();
                  }}
                  shortcut="Ctrl/Cmd+Shift+M"
                />
              )}
            </section>
          );
        })}
        <div className="mt-1 border-divider border-t pt-1">
          <MenuRow
            label={m.editor_subscript()}
            onSelect={() => mark(KEYS.sub)}
          />
          <MenuRow
            label={m.editor_superscript()}
            onSelect={() => mark(KEYS.sup)}
          />
          <MenuRow
            label={m.editor_clear_formatting()}
            onSelect={clearFormatting}
          />
        </div>
      </ToolbarMenuContent>
    </DropdownMenu>
  );
}
