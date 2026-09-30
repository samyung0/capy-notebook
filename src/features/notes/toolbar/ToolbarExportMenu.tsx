import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { userToast } from '@/components/ui/userToast';
import {
  downloadEditorFile,
  downloadEditorText,
  exportNoteDocument,
} from '@/features/notes/documentAdapters';
import { EditorIcon } from '@/features/notes/EditorIcon';
import type { ExportFormat } from '@/features/notes/export/render';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverRow,
} from '@/features/notes/toolbar/ToolbarPopover';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';

export function ExportMenu({ editor }: { editor: AnyEditor }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => () => controller.current?.abort(), []);
  const exportFile = async (format: ExportFormat) => {
    if (controller.current) return;
    const task = new AbortController();
    controller.current = task;
    setBusy(true);
    setOpen(false);
    try {
      const result = await exportNoteDocument(
        editor,
        queryClient,
        format,
        task.signal
      );
      downloadEditorFile(result.blob, `document.${result.extension}`);
    } catch (cause) {
      if (!task.signal.aborted)
        userToast({
          description: errorCopy(cause, m.source_try_again()),
          title: m.editor_export_failed(),
          variant: 'error',
        });
    } finally {
      controller.current = null;
      if (!task.signal.aborted) setBusy(false);
    }
  };
  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton
          disabled={busy}
          label={busy ? m.editor_export_preparing() : m.editor_export()}
        >
          <EditorIcon name="download" />
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="start" className="w-52" open={open}>
        <ToolbarPopoverRow
          label={m.editor_export_md()}
          onClick={() => void exportFile('markdown')}
        />
        <ToolbarPopoverRow
          label={m.editor_export_docx()}
          onClick={() => void exportFile('docx')}
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
