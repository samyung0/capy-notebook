import { ArrowDownToLine, ChevronDown } from 'lucide-react';
import type { SlatePlugin } from 'platejs';
import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import {
  downloadEditorFile,
  downloadEditorText,
  exportDocxDocument,
  exportMarkdownDocument,
} from '@/features/notes/documentAdapters';
import { MaterialKit } from '@/features/notes/plugins';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { MenuRow } from '@/features/notes/toolbar/ToolbarMenuRow';

export function ExportMenu({ editor }: { editor: AnyEditor }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton className="w-fit" label="Export document">
          <ArrowDownToLine />
          <ChevronDown className="size-3! text-fg-secondary" />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-52 gap-0.5 border border-line bg-surface p-1 shadow-pop"
      >
        <MenuRow
          label="Export Markdown (.md)"
          onClick={() =>
            downloadEditorText(
              exportMarkdownDocument(editor),
              'document.md',
              'text/markdown'
            )
          }
        />
        <MenuRow
          label="Export Word (.docx)"
          onClick={() =>
            void exportDocxDocument(editor, MaterialKit as SlatePlugin[]).then(
              (blob) => downloadEditorFile(blob, 'document.docx')
            )
          }
        />
        <MenuRow
          label="Export JSON"
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
      </PopoverContent>
    </Popover>
  );
}
