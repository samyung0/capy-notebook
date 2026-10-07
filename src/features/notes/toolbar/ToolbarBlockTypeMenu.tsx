import { KEYS } from 'platejs';
import { useEditorSelector } from 'platejs/react';
import { useState } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';
import { ToolbarPopoverContent, ToolbarPopoverRow } from './ToolbarPopover';

export function BlockTypeMenu({
  onBlock,
}: {
  onBlock: (type: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const blockType = useEditorSelector(
    (editor) => editor.api.block()?.[0]?.type,
    []
  );
  const options = [
    { icon: 'paragraph', label: m.editor_block_paragraph(), type: KEYS.p },
    { icon: 'heading1', label: m.editor_heading_1(), type: KEYS.h1 },
    { icon: 'heading2', label: m.editor_heading_2(), type: KEYS.h2 },
    { icon: 'heading3', label: m.editor_heading_3(), type: KEYS.h3 },
    { icon: 'heading4', label: m.editor_heading_4(), type: KEYS.h4 },
    { icon: 'heading5', label: m.editor_heading_5(), type: KEYS.h5 },
    { icon: 'heading6', label: m.editor_heading_6(), type: KEYS.h6 },
    { icon: 'quote', label: m.editor_blockquote(), type: KEYS.blockquote },
    { icon: 'braces', label: m.editor_code_block(), type: KEYS.codeBlock },
  ] as const;
  const selectedType = options.find((option) => option.type === blockType);

  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton
          className="w-23"
          data-block-type={selectedType?.type ?? KEYS.p}
          label={m.editor_block_type()}
        >
          <span className="translate-y-px">
            {selectedType?.label ?? m.editor_block_paragraph()}
          </span>
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="start" className="w-46" open={open}>
        {options.map((option) => (
          <ToolbarPopoverRow
            icon={<EditorIcon name={option.icon} />}
            key={option.type}
            label={option.label}
            onClick={() => onBlock(option.type)}
            selected={option.type === blockType}
          />
        ))}
      </ToolbarPopoverContent>
    </Popover>
  );
}
