import { useState } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { useNoteBlockDialogs } from '@/features/notes/blocks/dialogContext';
import { EditorIcon } from '@/features/notes/EditorIcon';
import type { EditorCommand } from '@/features/notes/editorCommands';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverRow,
} from '@/features/notes/toolbar/ToolbarPopover';
import { m } from '@/i18n';

/** The quiz and flashcard embeds behind one Study button, so notes show they
 * can hold them. */
export function ToolbarStudyMenu({
  commands,
  editor,
}: {
  commands: EditorCommand[];
  editor: AnyEditor;
}) {
  const dialogs = useNoteBlockDialogs();
  const [open, setOpen] = useState(false);
  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton
          className="lg:w-fit lg:gap-1.5 lg:px-1.5"
          label={m.editor_study_tools()}
        >
          <EditorIcon name="knowledge" />
          <span className="hidden translate-y-px lg:inline">
            {m.editor_study()}
          </span>
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="start" className="w-48" open={open}>
        {commands.map((command) => (
          <ToolbarPopoverRow
            icon={<EditorIcon name={command.icon} />}
            key={command.id}
            label={command.label}
            onClick={() => {
              setOpen(false);
              command.run(editor, dialogs);
            }}
          />
        ))}
      </ToolbarPopoverContent>
    </Popover>
  );
}
