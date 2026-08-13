import {
  Braces,
  ChevronDown,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Pilcrow,
  Quote,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorSelector } from 'platejs/react';
import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { MenuRow } from '@/features/notes/toolbar/ToolbarMenuRow';
import { m } from '@/i18n';

export function BlockTypeMenu({
  onBlock,
}: {
  onBlock: (type: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const blockTypeLabel = useEditorSelector((editor) => {
    const [block] = editor.api.block() ?? [];

    switch (block?.type) {
      case KEYS.h1:
        return m.editor_heading_1();
      case KEYS.h2:
        return m.editor_heading_2();
      case KEYS.h3:
        return m.editor_heading_3();
      case KEYS.h4:
        return m.editor_heading_4();
      case KEYS.h5:
        return m.editor_heading_5();
      case KEYS.h6:
        return m.editor_heading_6();
      case KEYS.blockquote:
        return m.editor_blockquote();
      case KEYS.codeBlock:
        return m.editor_code_block();
      default:
        return m.editor_block_paragraph();
    }
  }, []);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <ToolbarButton className="w-23" label={m.editor_block_type()}>
            <span className="translate-y-px">{blockTypeLabel}</span>
            <ChevronDown className="size-3! text-fg-secondary" />
          </ToolbarButton>
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-42 gap-0.5 bg-surface p-1 shadow-pop"
      >
        <MenuRow
          icon={<Pilcrow />}
          label={m.editor_block_paragraph()}
          onClick={() => onBlock(KEYS.p)}
        />
        <MenuRow
          icon={<Heading1 />}
          label={m.editor_heading_1()}
          onClick={() => onBlock(KEYS.h1)}
        />
        <MenuRow
          icon={<Heading2 />}
          label={m.editor_heading_2()}
          onClick={() => onBlock(KEYS.h2)}
        />
        <MenuRow
          icon={<Heading3 />}
          label={m.editor_heading_3()}
          onClick={() => onBlock(KEYS.h3)}
        />
        <MenuRow
          icon={<Heading4 />}
          label={m.editor_heading_4()}
          onClick={() => onBlock(KEYS.h4)}
        />
        <MenuRow
          icon={<Heading5 />}
          label={m.editor_heading_5()}
          onClick={() => onBlock(KEYS.h5)}
        />
        <MenuRow
          icon={<Heading6 />}
          label={m.editor_heading_6()}
          onClick={() => onBlock(KEYS.h6)}
        />
        <MenuRow
          icon={<Quote />}
          label={m.editor_blockquote()}
          onClick={() => onBlock(KEYS.blockquote)}
        />
        <MenuRow
          icon={<Braces />}
          label={m.editor_code_block()}
          onClick={() => onBlock(KEYS.codeBlock)}
        />
      </PopoverContent>
    </Popover>
  );
}
