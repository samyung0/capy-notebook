import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';

export function AlignMenu({ editor }: { editor: AnyEditor }) {
  const [open, setOpen] = useState(false);
  const align = (value: string) => editor.tf.setNodes({ align: value });
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <ToolbarButton
            label={m.editor_text_alignment()}
            onClick={() => setOpen(true)}
          >
            <AlignLeft />
          </ToolbarButton>
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-auto gap-1 border border-line bg-surface p-1 shadow-pop"
      >
        <ToolbarButton
          label={m.editor_align_left()}
          onClick={() => align('left')}
        >
          <AlignLeft />
        </ToolbarButton>
        <ToolbarButton
          label={m.editor_align_center()}
          onClick={() => align('center')}
        >
          <AlignCenter />
        </ToolbarButton>
        <ToolbarButton
          label={m.editor_align_right()}
          onClick={() => align('right')}
        >
          <AlignRight />
        </ToolbarButton>
        {/* <ToolbarButton label="Justify" onClick={() => align('justify')}>
          <AlignJustify />
        </ToolbarButton> */}
      </PopoverContent>
    </Popover>
  );
}
