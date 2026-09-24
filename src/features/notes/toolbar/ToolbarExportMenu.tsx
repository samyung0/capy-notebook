import { useQueryClient } from '@tanstack/react-query';
import type { SlatePlugin } from 'platejs';
import { useState } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import {
  downloadEditorFile,
  downloadEditorText,
  exportDocxDocument,
  exportMarkdownDocument,
} from '@/features/notes/documentAdapters';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { MaterialKit } from '@/features/notes/plugins';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverRow,
} from '@/features/notes/toolbar/ToolbarPopover';
import { m } from '@/i18n';

export function ExportMenu({ editor }: { editor: AnyEditor }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton label={m.editor_export()}>
          <EditorIcon name="download" />
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="start"
        className="w-52 gap-0.5 p-1"
        open={open}
      >
        <ToolbarPopoverRow
          label={m.editor_export_md()}
          onClick={() =>
            void exportMarkdownDocument(editor, queryClient).then((markdown) =>
              downloadEditorText(markdown, 'document.md', 'text/markdown')
            )
          }
        />
        <ToolbarPopoverRow
          label={m.editor_export_docx()}
          onClick={() =>
            void exportDocxDocument(editor, MaterialKit as SlatePlugin[]).then(
              (blob) => downloadEditorFile(blob, 'document.docx')
            )
          }
        />
        <ToolbarPopoverRow
          label={m.editor_export_json()}
          onClick={() =>
            downloadEditorText(
              JSON.stringify(
                { schemaVersion: 1, value: editor.children },
                null,
                2
              ),
              'document.plate.json',
              'application/json'
            )
          }
        />
      </ToolbarPopoverContent>
    </Popover>
  );
}
