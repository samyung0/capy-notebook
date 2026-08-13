import { useEditorRef, useEditorSelector } from 'platejs/react';
import { useState } from 'react';
import { ColorPicker } from '@/components/ui/ColorPicker';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import type { AnyEditor } from '@/features/notes/toolbar/NoteToolbar';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';

export function FontColorControl({
  label,
  markKey,
  icon,
  fallbackColor,
}: {
  label: string;
  markKey: string;
  icon: React.ReactNode;
  fallbackColor: string;
}) {
  const editor = useEditorRef() as AnyEditor;
  const [open, setOpen] = useState(false);
  const currentColor = useEditorSelector(
    (currentEditor) => currentEditor.api.mark(markKey) as string | undefined,
    [markKey]
  );

  const applyColor = (color: string) => {
    editor.tf.addMarks({ [markKey]: color });
    setOpen(false);
  };

  const clearColor = () => {
    editor.tf.removeMarks(markKey);
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <ToolbarButton
            active={Boolean(currentColor)}
            className="relative"
            label={label}
          >
            {icon}
            <span
              aria-hidden
              className="absolute right-1.5 bottom-0.5 left-1.5 h-1 rounded-full border border-line-strong"
              style={{ backgroundColor: currentColor || fallbackColor }}
            />
          </ToolbarButton>
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        className="w-64 border border-line bg-surface p-2.5 shadow-pop"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.tf.focus();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <ColorPicker
          onChange={applyColor}
          onClear={clearColor}
          value={currentColor}
        />
      </PopoverContent>
    </Popover>
  );
}
