import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { CreatePDFAnnotationBody } from '@/api/gen/validators';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Input, InputError } from '@/components/ui/Input';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export type PdfTool =
  | 'select'
  | 'pen'
  | 'highlight'
  | 'text'
  | 'rectangle'
  | 'ellipse'
  | 'eraser';
const COLORS = [
  '#d94848',
  '#7c5cc4',
  '#287bb8',
  '#2d9161',
  '#dfa626',
  '#333333',
];
const textSchema = CreatePDFAnnotationBody.pick({ text: true }).extend({
  text: CreatePDFAnnotationBody.shape.text.unwrap().trim().min(1),
});

export function PdfAnnotationToolbar({
  tool,
  onTool,
  color,
  onColor,
  onText,
  disabled,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDrawOpen,
}: {
  tool: PdfTool;
  onTool: (tool: PdfTool) => void;
  color: string;
  onColor: (value: string) => void;
  onText: (value: string) => void;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDrawOpen: () => void;
}) {
  const [toolPopover, setToolPopover] = useState<string | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ text: string }>({
    defaultValues: { text: '' },
    resolver: zodResolver(textSchema),
  });
  const toolButton = (value: PdfTool, icon: IconName, label: string) => (
    <ToolbarButton
      active={tool === value}
      disabled={disabled}
      label={label}
      onClick={() => onTool(value)}
    >
      <Icon name={icon} />
    </ToolbarButton>
  );
  const popoverButton = (
    icon: IconName,
    label: string,
    options: { tool: PdfTool; icon: IconName; label: string }[],
    onOpen?: () => void
  ) => (
    <Popover
      onOpenChange={(open) => {
        setToolPopover(open ? label : null);
        if (open) onOpen?.();
      }}
      open={toolPopover === label}
    >
      <PopoverTrigger asChild>
        <ToolbarButton
          active={options.some((option) => option.tool === tool)}
          disabled={disabled}
          label={label}
        >
          <Icon name={icon} />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        aria-hidden={toolPopover !== label || undefined}
        className="w-40 gap-0.5 p-1"
        inert={toolPopover !== label}
      >
        {options.map((option) => (
          <PopoverClose asChild key={option.tool}>
            <Button
              className="h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal [&_svg]:size-4"
              onClick={() => onTool(option.tool)}
              size="sm"
              type="button"
              variant="ghost-hover"
            >
              <Icon name={option.icon} />
              <span>{option.label}</span>
              {tool === option.tool && (
                <Icon className="ml-auto" name="check" />
              )}
            </Button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );
  return (
    <div className="flex h-full w-max shrink-0 items-center">
      <ToolbarGroup>
        {toolButton('select', 'cursor', m.pdf_select())}
        {popoverButton(
          tool === 'highlight' ? 'highlighter' : 'pencil',
          m.pdf_draw(),
          [
            { icon: 'pencil', label: m.pdf_pen(), tool: 'pen' },
            {
              icon: 'highlighter',
              label: m.pdf_highlight(),
              tool: 'highlight',
            },
          ],
          onDrawOpen
        )}
        <Popover onOpenChange={setTextOpen} open={textOpen}>
          <PopoverTrigger asChild>
            <ToolbarButton
              active={tool === 'text'}
              disabled={disabled}
              label={m.pdf_text()}
            >
              <Icon name="text" />
            </ToolbarButton>
          </PopoverTrigger>
          <PopoverContent>
            <form
              className="flex flex-col gap-2"
              onSubmit={handleSubmit(({ text }) => {
                onText(text);
                onTool('text');
                setTextOpen(false);
              })}
            >
              <Input
                aria-invalid={!!errors.text}
                aria-label={m.pdf_text()}
                maxLength={2000}
                placeholder={m.pdf_text()}
                {...register('text')}
              />
              {errors.text && <InputError errors={[errors.text]} />}
              <Button size="sm" type="submit" variant="accent">
                {m.pdf_place_text()}
              </Button>
            </form>
          </PopoverContent>
        </Popover>
        {popoverButton('shape', m.pdf_shape(), [
          { icon: 'rectangle', label: m.pdf_rectangle(), tool: 'rectangle' },
          { icon: 'ellipse', label: m.pdf_ellipse(), tool: 'ellipse' },
        ])}
        <Popover onOpenChange={setColorOpen} open={colorOpen}>
          <PopoverTrigger asChild>
            <ToolbarButton disabled={disabled} label={m.common_color()}>
              <span
                className="block size-5 rounded-full border border-line"
                style={{ backgroundColor: color }}
              />
            </ToolbarButton>
          </PopoverTrigger>
          <PopoverContent className="grid w-auto grid-cols-3 gap-2">
            {COLORS.map((value) => (
              <button
                aria-label={m.pdf_annotation_color({ color: value })}
                aria-pressed={value === color}
                className={cn(
                  'size-7 rounded-full border-2',
                  color === value ? 'border-fg' : 'border-transparent'
                )}
                key={value}
                onClick={() => {
                  onColor(value);
                  setColorOpen(false);
                }}
                style={{ backgroundColor: value }}
                type="button"
              />
            ))}
          </PopoverContent>
        </Popover>
        {toolButton('eraser', 'eraser', m.pdf_eraser())}
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton
          disabled={disabled || !canUndo}
          label={m.editor_undo()}
          onClick={onUndo}
        >
          <Icon name="undo" />
        </ToolbarButton>
        <ToolbarButton
          disabled={disabled || !canRedo}
          label={m.editor_redo()}
          onClick={onRedo}
        >
          <Icon name="redo" />
        </ToolbarButton>
      </ToolbarGroup>
    </div>
  );
}
