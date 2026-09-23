import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { CreatePDFAnnotationBody } from '@/api/gen/validators';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input, InputError } from '@/components/ui/Input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
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
    <IconButton
      aria-pressed={tool === value}
      className="shrink-0 p-2"
      disabled={disabled}
      icon={icon}
      label={label}
      onClick={() => onTool(value)}
      size="sm"
      tooltip
      variant={tool === value ? 'accent-light' : 'ghost-hover'}
    />
  );
  const menuButton = (
    icon: IconName,
    label: string,
    options: { tool: PdfTool; icon: IconName; label: string }[],
    onOpen?: () => void
  ) => (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            'shrink-0 gap-0.5 p-2',
            options.some((option) => option.tool === tool) &&
              'bg-tint-accent-1 text-tint-accent-1-fg'
          )}
          disabled={disabled}
          iconLeft={icon}
          iconRight="chevronDown"
          size="sm"
          variant="ghost-hover"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.tool}
            onSelect={() => onTool(option.tool)}
          >
            <Icon name={option.icon} />
            <span>{option.label}</span>
            {tool === option.tool && <Icon className="ml-auto" name="check" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <div className="flex w-max shrink-0 items-center">
      {toolButton('select', 'cursor', m.pdf_select())}
      {menuButton(
        tool === 'highlight' ? 'highlighter' : 'pencil',
        m.pdf_draw(),
        [
          { icon: 'pencil', label: m.pdf_pen(), tool: 'pen' },
          { icon: 'highlighter', label: m.pdf_highlight(), tool: 'highlight' },
        ],
        onDrawOpen
      )}
      <Popover onOpenChange={setTextOpen} open={textOpen}>
        <PopoverTrigger asChild>
          <IconButton
            aria-pressed={tool === 'text'}
            className="p-2"
            disabled={disabled}
            icon="text"
            label={m.pdf_text()}
            size="sm"
            variant={tool === 'text' ? 'accent-light' : 'ghost-hover'}
          />
        </PopoverTrigger>
        <PopoverContent className="border border-line bg-surface shadow-pop">
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
      {menuButton('shape', m.pdf_shape(), [
        { icon: 'rectangle', label: m.pdf_rectangle(), tool: 'rectangle' },
        { icon: 'ellipse', label: m.pdf_ellipse(), tool: 'ellipse' },
      ])}
      <Popover onOpenChange={setColorOpen} open={colorOpen}>
        <PopoverTrigger asChild>
          <button
            aria-label={m.common_color()}
            className="shrink-0 rounded-button p-2 disabled:opacity-40"
            disabled={disabled}
            type="button"
          >
            <span
              className="block size-5 rounded-full border border-line"
              style={{ backgroundColor: color }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent className="grid w-auto grid-cols-3 gap-2 border border-line bg-surface shadow-pop">
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
      <span className="mx-1 h-5 w-px shrink-0 bg-divider" />
      <IconButton
        className="shrink-0 p-2"
        disabled={disabled || !canUndo}
        icon="undo"
        label={m.editor_undo()}
        onClick={onUndo}
        size="sm"
        tooltip
        variant="ghost-hover"
      />
      <IconButton
        className="shrink-0 p-2"
        disabled={disabled || !canRedo}
        icon="redo"
        label={m.editor_redo()}
        onClick={onRedo}
        size="sm"
        tooltip
        variant="ghost-hover"
      />
    </div>
  );
}
