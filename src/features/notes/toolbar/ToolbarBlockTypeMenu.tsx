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
        return 'Heading 1';
      case KEYS.h2:
        return 'Heading 2';
      case KEYS.h3:
        return 'Heading 3';
      case KEYS.h4:
        return 'Heading 4';
      case KEYS.h5:
        return 'Heading 5';
      case KEYS.h6:
        return 'Heading 6';
      case KEYS.blockquote:
        return 'Blockquote';
      case KEYS.codeBlock:
        return 'Code block';
      default:
        return 'Paragraph';
    }
  }, []);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton className="w-fit" label="Block Type">
          <span className="translate-y-px">{blockTypeLabel}</span>
          <ChevronDown className="size-3! text-fg-secondary" />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-42 gap-0.5 bg-surface p-1 shadow-pop"
      >
        <MenuRow
          icon={<Pilcrow />}
          label="Paragraph"
          onClick={() => onBlock(KEYS.p)}
        />
        <MenuRow
          icon={<Heading1 />}
          label="Heading 1"
          onClick={() => onBlock(KEYS.h1)}
        />
        <MenuRow
          icon={<Heading2 />}
          label="Heading 2"
          onClick={() => onBlock(KEYS.h2)}
        />
        <MenuRow
          icon={<Heading3 />}
          label="Heading 3"
          onClick={() => onBlock(KEYS.h3)}
        />
        <MenuRow
          icon={<Heading4 />}
          label="Heading 4"
          onClick={() => onBlock(KEYS.h4)}
        />
        <MenuRow
          icon={<Heading5 />}
          label="Heading 5"
          onClick={() => onBlock(KEYS.h5)}
        />
        <MenuRow
          icon={<Heading6 />}
          label="Heading 6"
          onClick={() => onBlock(KEYS.h6)}
        />
        <MenuRow
          icon={<Quote />}
          label="Blockquote"
          onClick={() => onBlock(KEYS.blockquote)}
        />
        <MenuRow
          icon={<Braces />}
          label="Code block"
          onClick={() => onBlock(KEYS.codeBlock)}
        />
      </PopoverContent>
    </Popover>
  );
}
