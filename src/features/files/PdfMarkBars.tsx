import { zodResolver } from '@hookform/resolvers/zod';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { changePDFAnnotationsBodySaveItemCommentMax as COMMENT_MAX } from '@/api/gen/validators';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { CharCount } from '@/components/ui/Input';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/Popover';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { colorName, WeightIcon, weightLabel } from './PdfAnnotationToolbar';
import { boxStyle, type PageInfo } from './PdfMarkLayer';
import {
  type Box,
  isStroked,
  MARK_COLORS,
  type Mark,
  markBox,
  markWeight,
  onText,
  WEIGHTS,
  type Weight,
} from './pdfMarks';

/** A bar over a box on the page, or under it near the page's top. Presses on
 * it never reach the page, nor take focus from a text box being typed. */
function BarAt({
  box,
  page,
  children,
}: {
  box: Box;
  page: PageInfo;
  children: ReactNode;
}) {
  const above = (box.y / page.height) * page.element.clientHeight > 56;
  const center = ((box.x + box.width / 2) / page.width) * 100;
  return (
    <div
      className="pointer-events-auto absolute z-[4] max-w-[calc(100vw-16px)]"
      data-pdf-bar
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!(event.target instanceof HTMLTextAreaElement))
          event.preventDefault();
      }}
      style={{
        left: `clamp(9rem, ${center}%, calc(100% - 9rem))`,
        top: `${((above ? box.y : box.y + box.height) / page.height) * 100}%`,
        transform: above
          ? 'translate(-50%, calc(-100% - 10px))'
          : 'translate(-50%, 10px)',
      }}
    >
      <BlockToolbar>{children}</BlockToolbar>
    </div>
  );
}

function ColorDots({
  colors,
  current,
  label,
  onPick,
}: {
  colors: readonly string[];
  current?: string;
  label: (color: string) => string;
  onPick: (color: string) => void;
}) {
  return (
    <ToolbarGroup className="gap-1 px-1">
      {colors.map((color) => (
        <button
          aria-label={label(color)}
          aria-pressed={current === undefined ? undefined : color === current}
          className={cn(
            'size-5 shrink-0 rounded-full border-2',
            color === current ? 'border-fg' : 'border-transparent'
          )}
          key={color}
          onClick={() => onPick(color)}
          style={{ backgroundColor: color }}
          title={label(color)}
          type="button"
        />
      ))}
    </ToolbarGroup>
  );
}

/** The selected marks' bar (D1): colour, width or text size, underline for a
 * band on the text (D8), comment (D4) and delete. */
export function SelectionBar({
  marks,
  box,
  page,
  onColor,
  onWeight,
  onUnderline,
  onComment,
  onDelete,
}: {
  marks: readonly Mark[];
  box: Box;
  page: PageInfo;
  onColor: (color: string) => void;
  onWeight: (weight: Weight) => void;
  onUnderline: () => void;
  onComment: () => void;
  onDelete: () => void;
}) {
  const one = marks.length === 1 ? marks[0] : null;
  const colors = new Set(marks.map((mark) => mark.color));
  const weights = new Set(marks.map(markWeight));
  const sized = one?.kind === 'text';
  const stroked = marks.every((mark) => isStroked(mark.kind));
  return (
    <BarAt box={box} page={page}>
      <ColorDots
        colors={MARK_COLORS}
        current={colors.size === 1 ? [...colors][0] : ''}
        label={colorName}
        onPick={onColor}
      />
      {/* The weights sit in the bar, each drawn as it looks (Epo 2026-11-24). */}
      {(stroked || sized) && (
        <ToolbarGroup>
          {WEIGHTS.map((weight) => (
            <ToolbarButton
              active={weights.size === 1 && weights.has(weight)}
              key={weight}
              label={weightLabel(weight, sized)}
              onClick={() => onWeight(weight)}
            >
              <WeightIcon text={sized} weight={weight} />
            </ToolbarButton>
          ))}
        </ToolbarGroup>
      )}
      <ToolbarGroup>
        {one && onText(one.kind) && (
          <ToolbarButton
            active={one.kind === 'underline'}
            label={m.pdf_underline()}
            onClick={onUnderline}
          >
            <Icon name="underline" />
          </ToolbarButton>
        )}
        {/* A note is a comment already. */}
        {one && one.kind !== 'note' && (
          <ToolbarButton
            active={!!one.comment}
            label={m.editor_comment()}
            onClick={onComment}
          >
            <Icon name="comment" />
          </ToolbarButton>
        )}
        <ToolbarButton label={m.action_delete()} onClick={onDelete}>
          <Icon name="trash" />
        </ToolbarButton>
      </ToolbarGroup>
    </BarAt>
  );
}

/** The bar over selected PDF text (D3): highlight in a colour, underline, or
 * highlight with a comment. */
export function TextSelectionBar({
  box,
  page,
  onHighlight,
  onUnderline,
  onComment,
}: {
  box: Box;
  page: PageInfo;
  onHighlight: (color: string) => void;
  onUnderline: () => void;
  onComment: () => void;
}) {
  return (
    <BarAt box={box} page={page}>
      <ColorDots
        colors={MARK_COLORS.slice(0, 5)}
        label={(color) => m.pdf_highlight_color({ color: colorName(color) })}
        onPick={onHighlight}
      />
      <ToolbarGroup>
        <ToolbarButton label={m.pdf_underline()} onClick={onUnderline}>
          <Icon name="underline" />
        </ToolbarButton>
        <ToolbarButton label={m.editor_comment()} onClick={onComment}>
          <Icon name="comment" />
        </ToolbarButton>
      </ToolbarGroup>
    </BarAt>
  );
}

const commentSchema = z.object({ comment: z.string().max(COMMENT_MAX) });

/** A mark's comment, under the mark: read only on a trashed or view-only file. */
export function CommentEditor({
  mark,
  page,
  readOnly,
  onSave,
  onClose,
}: {
  mark: Mark;
  page: PageInfo;
  readOnly: boolean;
  onSave: (comment: string) => void;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<{ comment: string }>({
    defaultValues: { comment: mark.comment },
    resolver: zodResolver(commentSchema),
  });
  const save = handleSubmit(({ comment }) => onSave(comment.trim()));
  return (
    <Popover onOpenChange={(open) => !open && onClose()} open>
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={boxStyle(markBox(mark), page)}
        />
      </PopoverAnchor>
      <PopoverContent
        align="center"
        className="w-72"
        collisionPadding={8}
        onOpenAutoFocus={(event) => readOnly && event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        side="bottom"
        sideOffset={10}
      >
        {readOnly ? (
          <p className="whitespace-pre-wrap break-words text-sm">
            {mark.comment}
          </p>
        ) : (
          <form
            className="flex flex-col gap-2"
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
                void save();
            }}
            onSubmit={save}
          >
            <Textarea
              aria-invalid={!!errors.comment || undefined}
              aria-label={m.editor_comment()}
              rows={3}
              {...register('comment')}
            />
            <div className="flex items-center gap-2">
              <CharCount
                max={COMMENT_MAX}
                value={textLength(watch('comment'))}
              />
              <Button
                className="ml-auto"
                onClick={onClose}
                size="sm"
                type="button"
                variant="outline"
              >
                {m.action_cancel()}
              </Button>
              <Button size="sm" type="submit" variant="accent">
                {m.action_save()}
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
