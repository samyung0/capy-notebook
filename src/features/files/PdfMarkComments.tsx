import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover, PopoverClose, PopoverTrigger } from '@/components/ui/Popover';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  ToolbarPopoverContent as PopoverContent,
  ToolbarPopoverButton,
} from '@/components/ui/ToolbarPopover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { PageInfo } from './PdfMarkLayer';
import { type Mark, type MarkKind, markBox } from './pdfMarks';

/** Comment cards beside the page, and the icons they collapse to (D11 B). */
export const MARGIN_CARDS_PX = 206;
export const MARGIN_ICONS_PX = 34;

const KIND_LABEL: Record<MarkKind, () => string> = {
  arrow: m.pdf_arrow,
  ellipse: m.pdf_ellipse,
  highlight: m.pdf_highlight,
  marker: m.pdf_marker,
  note: m.pdf_note,
  pen: m.pdf_pen,
  rectangle: m.pdf_rectangle,
  text: m.pdf_text,
  underline: m.pdf_underline,
};

/** Page order: by page, then down the page. */
export const pageOrder = (marks: readonly Mark[]) =>
  [...marks].sort((a, b) => a.page - b.page || markBox(a).y - markBox(b).y);

/** What a mark is about: the text it covers, or its own text. */
const quoteOf = (mark: Mark) =>
  mark.kind === 'highlight' || mark.kind === 'underline' || mark.kind === 'text'
    ? mark.text
    : '';

function CommentIcon({ color, current }: { color: string; current?: boolean }) {
  return (
    <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20">
      <path
        className={cn(current && 'stroke-action-accent')}
        d="M3 4h18v12H9l-6 5z"
        fill={color}
        stroke="rgb(0 0 0 / 0.3)"
        strokeWidth={current ? 2.5 : 1}
      />
    </svg>
  );
}

function MarkRow({ mark, onOpen }: { mark: Mark; onOpen: () => void }) {
  const quote = quoteOf(mark);
  return (
    <PopoverClose asChild>
      <ToolbarPopoverButton
        className="h-auto items-start gap-2 py-1.5 font-normal"
        onClick={onOpen}
      >
        <span
          aria-hidden
          className="mt-1 size-2.5 shrink-0 rounded-[3px]"
          style={{ backgroundColor: mark.color }}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-fg-muted text-xs">
            {m.pdf_mark_place({
              kind: KIND_LABEL[mark.kind](),
              page: mark.page,
            })}
          </span>
          {quote && (
            <span className="line-clamp-2 text-fg-muted">“{quote}”</span>
          )}
          {mark.comment && (
            <span className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words border-line border-l-2 pl-1.5">
              {mark.comment}
            </span>
          )}
        </span>
      </ToolbarPopoverButton>
    </PopoverClose>
  );
}

function MarkList({
  marks,
  empty,
  onOpen,
}: {
  marks: readonly Mark[];
  empty: string;
  onOpen: (mark: Mark) => void;
}) {
  return (
    <PopoverContent
      align="end"
      className="max-h-[min(60vh,22rem)] w-[min(18.5rem,calc(100vw-2rem))] overflow-y-auto"
    >
      {marks.length ? (
        pageOrder(marks).map((mark) => (
          <MarkRow key={mark.id} mark={mark} onOpen={() => onOpen(mark)} />
        ))
      ) : (
        <p className="px-2 py-1 font-normal text-fg-muted">{empty}</p>
      )}
    </PopoverContent>
  );
}

/** The toolbar's end, pinned as a note's comments are: every mark in page
 * order (D5), and the comments. Beside the page, Comments collapses the margin
 * to icons and back; with no margin it lists them. */
export function MarksMenus({
  marks,
  margin,
  collapsed,
  onCollapse,
  onOpen,
}: {
  marks: readonly Mark[];
  /** Comments show beside the page. */
  margin: boolean;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onOpen: (mark: Mark, comment: boolean) => void;
}) {
  const commented = marks.filter((mark) => mark.comment);
  const count = String(commented.length);
  const commentsButton = (
    <ToolbarButton
      active={margin ? !collapsed : undefined}
      className="w-auto min-w-8 px-1 text-fg-muted data-[state=open]:bg-surface-hover-bg"
      label={m.pdf_comments({ count })}
      onClick={margin ? () => onCollapse(!collapsed) : undefined}
    >
      <Icon name="comment" />
      <span className="font-semibold text-xs">{count}</span>
    </ToolbarButton>
  );
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <ToolbarButton
            className="data-[state=open]:bg-surface-hover-bg"
            label={m.pdf_marks()}
          >
            <Icon name="list" />
          </ToolbarButton>
        </PopoverTrigger>
        <MarkList
          empty={m.pdf_marks_empty()}
          marks={marks}
          onOpen={(mark) => onOpen(mark, false)}
        />
      </Popover>
      {margin ? (
        commentsButton
      ) : (
        <Popover>
          <PopoverTrigger asChild>{commentsButton}</PopoverTrigger>
          <MarkList
            empty={m.pdf_comments_empty()}
            marks={commented}
            onOpen={(mark) => onOpen(mark, true)}
          />
        </Popover>
      )}
    </>
  );
}

/** Comments beside their marks (D11 B, Word's and Google Docs's margin): a card
 * at its mark's height, pushed down past the one above, or an icon at that
 * height once collapsed. */
export function CommentMargin({
  marks,
  pages,
  collapsed,
  selected,
  layout,
  onOpen,
}: {
  marks: readonly Mark[];
  pages: readonly PageInfo[];
  collapsed: boolean;
  selected: ReadonlySet<string>;
  /** Changes whenever pages move: zoom, resize, a page measured. */
  layout: string;
  onOpen: (mark: Mark) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const commented = useMemo(
    () => pageOrder(marks.filter((mark) => mark.comment)),
    [marks]
  );
  // `layout` changes when the pages move, so the cards are placed again.
  useLayoutEffect(() => {
    const margin = root.current;
    if (!margin) return;
    const top = margin.getBoundingClientRect().top;
    const byNumber = new Map(pages.map((page) => [page.number, page]));
    let floor = 0;
    for (const item of margin.querySelectorAll<HTMLElement>('[data-mark]')) {
      const mark = commented.find((row) => row.id === item.dataset.mark);
      const page = mark && byNumber.get(mark.page);
      if (!(mark && page)) continue;
      const rect = page.element.getBoundingClientRect();
      const at = rect.top - top + (markBox(mark).y / page.height) * rect.height;
      const y = collapsed ? at - 4 : Math.max(at, floor);
      item.style.top = `${y}px`;
      floor = y + item.offsetHeight + 8;
    }
    setHeight(floor);
  }, [commented, collapsed, layout, pages]);
  return (
    <div className="relative" ref={root} style={{ minHeight: height }}>
      {commented.map((mark) =>
        collapsed ? (
          <button
            aria-current={selected.has(mark.id) || undefined}
            aria-label={m.pdf_comment_label({ comment: mark.comment })}
            className="absolute left-1 grid size-6 place-items-center rounded-sm focus-visible:outline-2 focus-visible:outline-action-accent"
            data-mark={mark.id}
            key={mark.id}
            onClick={() => onOpen(mark)}
            title={mark.comment}
            type="button"
          >
            <CommentIcon color={mark.color} current={selected.has(mark.id)} />
          </button>
        ) : (
          <button
            aria-current={selected.has(mark.id) || undefined}
            className="absolute inset-x-0 flex flex-col gap-0.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[12.5px] shadow-xs transition-[top] duration-150 aria-[current]:border-action-accent aria-[current]:ring-1 aria-[current]:ring-action-accent motion-reduce:transition-none"
            data-mark={mark.id}
            key={mark.id}
            onClick={() => onOpen(mark)}
            type="button"
          >
            {quoteOf(mark) ? (
              <span
                className="line-clamp-2 border-l-[3px] pl-1.5 text-[11.5px] text-fg-muted"
                style={{ borderColor: mark.color }}
              >
                {quoteOf(mark)}
              </span>
            ) : (
              <span className="text-[11px] text-fg-muted">
                {KIND_LABEL[mark.kind]()}
              </span>
            )}
            <span className="whitespace-pre-wrap break-words">
              {mark.comment}
            </span>
          </button>
        )
      )}
    </div>
  );
}
