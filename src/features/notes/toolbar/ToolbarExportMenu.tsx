import type { SlatePlugin } from 'platejs';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
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
  MenuRow,
  ToolbarMenuContent,
} from '@/features/notes/toolbar/ToolbarMenuRow';
import { m } from '@/i18n';

export function ExportMenu({ editor }: { editor: AnyEditor }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton className="w-fit" label={m.editor_export()}>
          <EditorIcon name="download" />
          <EditorIcon
            className="size-3! text-fg-secondary"
            name="chevronDown"
          />
        </ToolbarButton>
      </DropdownMenuTrigger>
      <ToolbarMenuContent
        align="start"
        className="w-52 gap-0.5 border border-line bg-surface p-1 shadow-pop"
      >
        <MenuRow
          label={m.editor_export_md()}
          onSelect={() =>
            downloadEditorText(
              exportMarkdownDocument(editor),
              'document.md',
              'text/markdown'
            )
          }
        />
        <MenuRow
          label={m.editor_export_docx()}
          onSelect={() =>
            void exportDocxDocument(editor, MaterialKit as SlatePlugin[]).then(
              (blob) => downloadEditorFile(blob, 'document.docx')
            )
          }
        />
        <MenuRow
          label={m.editor_export_json()}
          onSelect={() =>
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
      </ToolbarMenuContent>
    </DropdownMenu>
  );
}
