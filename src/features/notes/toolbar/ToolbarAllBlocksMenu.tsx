import { ChevronDown, MessageSquarePlus, Plus } from 'lucide-react';
import { KEYS } from 'platejs';
import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { useNoteBlockDialogs } from '@/features/notes/blocks/dialogContext';
import type { CollaborationActions } from '@/features/notes/Collaboration';
import type {
  EDITOR_COMMANDS,
  EditorCommand,
} from '@/features/notes/editorCommands';
import { clearEditorFormatting } from '@/features/notes/editorTransforms';
import { WIDGET_GROUPS } from '@/features/notes/noteEditorPrefs';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { MenuRow } from '@/features/notes/toolbar/ToolbarMenuRow';

const ALL_BLOCK_GROUPS = WIDGET_GROUPS.map(({ id, label }) => ({ id, label }));

export function ToolbarAllBlocksMenu({
  allBlockCommands,
  collaboration,
  canComment,
  editor,
}: {
  allBlockCommands: EditorCommand[];
  collaboration: CollaborationActions | null;
  canComment: boolean;
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
    <Popover onOpenChange={setMoreOpen} open={moreOpen}>
      <PopoverTrigger asChild>
        <span>
          <ToolbarButton
            className="w-fit"
            label="All blocks"
            onClick={() => setMoreOpen(true)}
          >
            <Plus />
            <ChevronDown className="size-3! text-fg-secondary" />
          </ToolbarButton>
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[min(80vh,38rem)] w-72 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-pop"
        data-all-blocks-menu
      >
        {ALL_BLOCK_GROUPS.map((group) => {
          const commands = allBlockCommands.filter(
            (command) => command.group === group.id
          );
          const hasComment =
            group.id === 'general' && canComment && collaboration;
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
              {commands.map((command) => {
                const Icon = command.icon;
                return (
                  <MenuRow
                    icon={<Icon />}
                    key={command.id}
                    label={command.label}
                    onClick={() => runAllBlockCommand(command)}
                    shortcut={command.shortcut}
                  />
                );
              })}
              {hasComment && (
                <MenuRow
                  className="mt-1 border-divider border-t pt-2"
                  icon={<MessageSquarePlus />}
                  label="Comment"
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
          <MenuRow label="Subscript" onClick={() => mark(KEYS.sub)} />
          <MenuRow label="Superscript" onClick={() => mark(KEYS.sup)} />
          <MenuRow label="Clear formatting" onClick={clearFormatting} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
