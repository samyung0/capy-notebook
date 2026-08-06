import { toUnitLess } from '@platejs/basic-styles';
import { FontSizePlugin } from '@platejs/basic-styles/react';
import { Minus, Plus } from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';
import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { cn } from '@/lib/cn';

const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 96;
const FONT_SIZE_PRESETS = [
  8, 9, 10, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72, 96,
] as const;

function clampFontSize(size: number) {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

export function FontSizeControl() {
  const [open, setOpen] = useState(false);
  const { editor, tf } = useEditorPlugin(FontSizePlugin);
  const cursorFontSize = useEditorSelector((currentEditor) => {
    const markedSize = currentEditor.api.marks()?.[KEYS.fontSize];

    if (markedSize != null) {
      const parsedSize = Number.parseFloat(toUnitLess(String(markedSize)));
      if (Number.isFinite(parsedSize)) return clampFontSize(parsedSize);
    }

    const [block] = editor.api.block() ?? [];
    const domNode = block && editor.api.toDOMNode(block);
    if (domNode) {
      const size = Number.parseFloat(window.getComputedStyle(domNode).fontSize);
      if (Number.isFinite(size)) return clampFontSize(size);
    }

    return DEFAULT_FONT_SIZE;
  }, []);

  const setFontSize = (size: number, closePopover = false) => {
    tf.fontSize.addMark(`${clampFontSize(size)}px`);
    if (closePopover) setOpen(false);
    editor.tf.focus();
  };

  return (
    <div
      aria-label="Font size"
      className="mr-1 flex items-center overflow-hidden"
      role="group"
    >
      <ToolbarButton
        className="rounded-r-none bg-surface-hover-bg p-0 text-fg hover:bg-surface-dark"
        disabled={cursorFontSize <= MIN_FONT_SIZE}
        label="Decrease font size"
        onClick={() => setFontSize(cursorFontSize - 1)}
      >
        <Minus />
      </ToolbarButton>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={`Font size: ${cursorFontSize}`}
            className={cn(
              'h-8 w-10 shrink-0 text-center font-semibold text-sm outline-none',
              'bg-surface-hover-bg text-fg hover:bg-surface-dark focus-visible:ring-2 focus-visible:ring-focus'
            )}
            data-plate-prevent-deselect
            onMouseDown={(event) => event.preventDefault()}
            title="Choose font size"
            type="button"
          >
            {cursorFontSize}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          className="max-h-64 w-14 gap-0 overflow-y-auto border border-line bg-surface p-1 shadow-pop"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editor.tf.focus();
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div aria-label="Font sizes" role="listbox">
            {FONT_SIZE_PRESETS.map((size) => (
              <button
                aria-selected={size === cursorFontSize}
                className={cn(
                  'flex h-8 w-full items-center justify-center rounded-button text-sm outline-none',
                  'hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-focus',
                  size === cursorFontSize &&
                    'bg-tint-accent-1 text-tint-accent-1-fg'
                )}
                data-plate-prevent-deselect
                key={size}
                onClick={() => setFontSize(size, true)}
                onMouseDown={(event) => event.preventDefault()}
                role="option"
                type="button"
              >
                {size}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <ToolbarButton
        className="rounded-l-none bg-surface-hover-bg p-0 text-fg hover:bg-surface-dark"
        disabled={cursorFontSize >= MAX_FONT_SIZE}
        label="Increase font size"
        onClick={() => setFontSize(cursorFontSize + 1)}
      >
        <Plus />
      </ToolbarButton>
    </div>
  );
}
