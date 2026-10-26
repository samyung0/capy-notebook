import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { ToolbarPopoverContent as PopoverContent } from '@/components/ui/ToolbarPopover';
import { EditorIcon } from '@/features/notes/EditorIcon';
import type { NoteEditorInstance } from '@/features/notes/insertEditorNode';
import {
  insertInlineEquation,
  insertMathTemplate,
  MATH_TEMPLATES,
} from '@/features/notes/mathInsert';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';

/** The toolbar's Σ: an inline formula and the common templates, which go
 * into the formula being edited. The note toolbar and the question text
 * editor share it. */
export function ToolbarMathMenu({
  editor,
  label,
}: {
  editor: NoteEditorInstance;
  label: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ToolbarButton label={label}>
          <EditorIcon name="sigma" />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        className="ignore-click-outside/toolbar w-auto p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <BlockToolbar className="border-0 shadow-none">
          <ToolbarButton
            label={label}
            onClick={() => insertInlineEquation(editor)}
          >
            <EditorIcon name="sigma" />
          </ToolbarButton>
          {MATH_TEMPLATES.map(([glyph, tex, title]) => (
            <ToolbarButton
              className="w-auto min-w-8 px-1"
              key={tex}
              label={title()}
              onClick={() => insertMathTemplate(editor, tex)}
            >
              {glyph}
            </ToolbarButton>
          ))}
        </BlockToolbar>
      </PopoverContent>
    </Popover>
  );
}
