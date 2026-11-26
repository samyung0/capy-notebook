import { useState } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Popover, PopoverClose, PopoverTrigger } from '@/components/ui/Popover';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  ToolbarPopoverContent as PopoverContent,
  ToolbarPopoverItem,
} from '@/components/ui/ToolbarPopover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  MARK_COLORS,
  strokeWidth,
  TEXT_SIZES,
  WEIGHTS,
  type Weight,
} from './pdfMarks';

export type ShapeTool = 'rectangle' | 'ellipse' | 'arrow';
export type PdfTool =
  | 'select'
  | 'highlight'
  | 'pen'
  | 'text'
  | 'note'
  | ShapeTool
  | 'eraser';

/** Letter keys while the page has focus (D10). */
export const TOOL_KEYS: Record<string, PdfTool | 'shape'> = {
  e: 'eraser',
  h: 'highlight',
  n: 'note',
  p: 'pen',
  s: 'shape',
  t: 'text',
  v: 'select',
};

const COLOR_NAMES: Record<string, () => string> = {
  '#2d9161': m.pdf_color_green,
  '#7c5cc4': m.pdf_color_purple,
  '#287bb8': m.pdf_color_blue,
  '#333333': m.pdf_color_black,
  '#d94848': m.pdf_color_red,
  '#dfa626': m.pdf_color_yellow,
};
export const colorName = (color: string) => COLOR_NAMES[color]?.() ?? color;

export const SHAPES: {
  tool: ShapeTool;
  icon: IconName;
  label: () => string;
}[] = [
  { icon: 'rectangle', label: m.pdf_rectangle, tool: 'rectangle' },
  { icon: 'ellipse', label: m.pdf_ellipse, tool: 'ellipse' },
  { icon: 'arrowRight', label: m.pdf_arrow, tool: 'arrow' },
];
const widthLabel = (weight: Weight) =>
  ({ l: m.pdf_width_thick, m: m.pdf_width_medium, s: m.pdf_width_thin })[
    weight
  ]();
const sizeLabel = (weight: Weight) =>
  ({ l: m.pdf_text_large, m: m.pdf_text_medium, s: m.pdf_text_small })[
    weight
  ]();

/** A weight drawn as what it makes: a line that thick, or a letter that size. */
export function WeightIcon({
  weight,
  text,
}: {
  weight: Weight;
  /** Text sizes instead of widths. */
  text?: boolean;
}) {
  return text ? (
    <span
      className="w-4.5 text-center font-semibold leading-none"
      style={{ fontSize: TEXT_SIZES[weight] * 0.8 }}
    >
      A
    </span>
  ) : (
    <span
      className="block w-4.5 rounded-full bg-current"
      style={{ height: strokeWidth('pen', weight) * 0.7 }}
    />
  );
}

export const weightLabel = (weight: Weight, text?: boolean) =>
  text ? `${m.pdf_text_size()}: ${sizeLabel(weight)}` : widthLabel(weight);

export function PdfAnnotationToolbar({
  tool,
  shape,
  onTool,
  color,
  onColor,
  weight,
  onWeight,
  disabled,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  tool: PdfTool;
  /** The shape the Shapes button and S draw. */
  shape: ShapeTool;
  onTool: (tool: PdfTool) => void;
  color: string;
  onColor: (value: string) => void;
  weight: Weight;
  onWeight: (value: Weight) => void;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const [open, setOpen] = useState<'shape' | 'color' | 'width' | null>(null);
  // The keys show in each tool's tooltip, not on the bar (Epo 2026-11-24).
  const toolButton = (
    value: PdfTool,
    icon: IconName,
    label: string,
    key: string
  ) => (
    <ToolbarButton
      active={tool === value}
      disabled={disabled}
      label={label}
      onClick={() => onTool(value)}
      shortcut={key.toUpperCase()}
    >
      <Icon name={icon} />
    </ToolbarButton>
  );
  const popover = (name: NonNullable<typeof open>) => ({
    onOpenChange: (next: boolean) => setOpen(next ? name : null),
    open: open === name,
  });
  const current = SHAPES.find((item) => item.tool === shape) ?? SHAPES[0];
  return (
    <div className="flex h-full w-max shrink-0 items-center">
      <ToolbarGroup>
        {toolButton('select', 'cursor', m.pdf_select(), 'v')}
        {toolButton('highlight', 'highlighter', m.pdf_highlight(), 'h')}
        {toolButton('pen', 'pencil', m.pdf_pen(), 'p')}
        {toolButton('text', 'text', m.pdf_text(), 't')}
        {toolButton('note', 'comment', m.pdf_note(), 'n')}
        <Popover {...popover('shape')}>
          <PopoverTrigger asChild>
            <ToolbarButton
              active={SHAPES.some((item) => item.tool === tool)}
              disabled={disabled}
              label={m.pdf_shape()}
              shortcut="S"
            >
              <Icon name={current.icon} />
            </ToolbarButton>
          </PopoverTrigger>
          <PopoverContent align="center" className="w-40">
            {SHAPES.map((item) => (
              <PopoverClose asChild key={item.tool}>
                <ToolbarPopoverItem
                  icon={<Icon name={item.icon} />}
                  label={item.label()}
                  onClick={() => onTool(item.tool)}
                  selected={tool === item.tool}
                />
              </PopoverClose>
            ))}
          </PopoverContent>
        </Popover>
        {toolButton('eraser', 'eraser', m.pdf_eraser(), 'e')}
      </ToolbarGroup>
      <ToolbarGroup>
        <Popover {...popover('color')}>
          <PopoverTrigger asChild>
            <ToolbarButton
              disabled={disabled}
              label={m.common_color()}
              shortcut="1–6"
            >
              <span
                className="block size-5 rounded-full border border-line"
                style={{ backgroundColor: color }}
              />
            </ToolbarButton>
          </PopoverTrigger>
          <PopoverContent className="grid w-auto grid-cols-3 gap-2 px-2.5">
            {MARK_COLORS.map((value, index) => (
              <PopoverClose asChild key={value}>
                <button
                  aria-label={`${colorName(value)} (${index + 1})`}
                  aria-pressed={value === color}
                  className={cn(
                    'size-7 rounded-full border-2',
                    color === value ? 'border-fg' : 'border-transparent'
                  )}
                  onClick={() => onColor(value)}
                  style={{ backgroundColor: value }}
                  type="button"
                />
              </PopoverClose>
            ))}
          </PopoverContent>
        </Popover>
        <Popover {...popover('width')}>
          <PopoverTrigger asChild>
            <ToolbarButton disabled={disabled} label={m.pdf_width()}>
              <Icon name="width" />
            </ToolbarButton>
          </PopoverTrigger>
          <PopoverContent align="center" className="w-40">
            {WEIGHTS.map((value) => (
              <PopoverClose asChild key={value}>
                <ToolbarPopoverItem
                  icon={<WeightIcon weight={value} />}
                  label={widthLabel(value)}
                  onClick={() => onWeight(value)}
                  selected={weight === value}
                />
              </PopoverClose>
            ))}
          </PopoverContent>
        </Popover>
      </ToolbarGroup>
      {/* Phones go without them everywhere (Epo 2026-11-04). */}
      <ToolbarGroup className="hidden sm:flex">
        <ToolbarButton
          disabled={disabled || !canUndo}
          label={m.editor_undo()}
          onClick={onUndo}
          shortcut="Ctrl+Z"
        >
          <Icon name="undo" />
        </ToolbarButton>
        <ToolbarButton
          disabled={disabled || !canRedo}
          label={m.editor_redo()}
          onClick={onRedo}
          shortcut="Ctrl+Shift+Z"
        >
          <Icon name="redo" />
        </ToolbarButton>
      </ToolbarGroup>
    </div>
  );
}
