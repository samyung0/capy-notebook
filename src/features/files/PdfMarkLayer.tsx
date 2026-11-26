import { memo, type ReactNode, useLayoutEffect, useRef } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  arrowPath,
  type Box,
  type Handle,
  type Mark,
  markBox,
  NOTE_SIZE,
  smoothPath,
} from './pdfMarks';

/** A page wrapper and its size in units (pdfMarks.pageFrame). */
export type PageInfo = {
  element: HTMLElement;
  number: number;
  width: number;
  height: number;
};

/** Highlighter ink multiplies with the page, so text under it stays black. */
const HIGHLIGHT_OPACITY = 0.42;

const pct = (value: number, total: number) => `${(value / total) * 100}%`;

export const boxStyle = (box: Box, page: PageInfo) => ({
  height: pct(box.height, page.height),
  left: pct(box.x, page.width),
  top: pct(box.y, page.height),
  width: pct(box.width, page.width),
});

/** A text box's font, scaled with the page (1cqw is a hundredth of its width). */
export const textStyle = (mark: Mark, page: PageInfo) => ({
  color: mark.color,
  fontSize: `${(mark.size * 100) / page.width}cqw`,
  left: pct(mark.rects[0].x, page.width),
  top: pct(mark.rects[0].y, page.height),
  width: pct(mark.rects[0].width, page.width),
});

function MarkShape({ mark }: { mark: Mark }) {
  const ink = {
    fill: 'none',
    stroke: mark.color,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: mark.width,
  };
  switch (mark.kind) {
    case 'highlight':
      return mark.rects.map((r, i) => (
        <rect
          fill={mark.color}
          fillOpacity={HIGHLIGHT_OPACITY}
          height={r.height}
          key={i}
          style={{ mixBlendMode: 'multiply' }}
          width={r.width}
          x={r.x}
          y={r.y}
        />
      ));
    case 'underline':
      return mark.rects.map((r, i) => {
        const thick = Math.max(1, r.height * 0.12);
        return (
          <rect
            fill={mark.color}
            height={thick}
            key={i}
            width={r.width}
            x={r.x}
            y={r.y + r.height - thick}
          />
        );
      });
    case 'marker':
      return (
        <path
          {...ink}
          d={mark.strokes.map(smoothPath).join('')}
          strokeLinecap="butt"
          strokeOpacity={HIGHLIGHT_OPACITY}
          style={{ mixBlendMode: 'multiply' }}
        />
      );
    case 'pen':
      return <path {...ink} d={mark.strokes.map(smoothPath).join('')} />;
    case 'arrow': {
      const [a, b] = mark.strokes[0];
      return <path {...ink} d={arrowPath(a, b, mark.width)} />;
    }
    case 'rectangle': {
      const r = mark.rects[0];
      return (
        <rect
          {...ink}
          height={r.height}
          rx={1.5}
          width={r.width}
          x={r.x}
          y={r.y}
        />
      );
    }
    case 'ellipse': {
      const r = mark.rects[0];
      return (
        <ellipse
          {...ink}
          cx={r.x + r.width / 2}
          cy={r.y + r.height / 2}
          rx={r.width / 2}
          ry={r.height / 2}
        />
      );
    }
    case 'note': {
      const r = mark.rects[0];
      const s = r.width / NOTE_SIZE;
      return (
        <g transform={`translate(${r.x} ${r.y}) scale(${s})`}>
          <path
            d="M2 2h20v15H10l-6 5v-5H2z"
            fill={mark.color}
            stroke="rgb(0 0 0 / 0.25)"
            strokeWidth={0.75}
          />
          <path
            d="M6 7.5h12M6 11.5h8"
            stroke="#fff"
            strokeLinecap="round"
            strokeWidth={1.6}
          />
        </g>
      );
    }
    case 'text':
      return null;
  }
}

/** A text box's height in units to fit its text as shown, measured on the
 * page's hidden copy (data-pdf-text-probe); null while the page has none. */
export function measureTextHeight(mark: Mark, page: PageInfo): number | null {
  const probe = page.element.querySelector<HTMLElement>(
    '[data-pdf-text-probe]'
  );
  if (!probe) return null;
  Object.assign(probe.style, textStyle(mark, page));
  probe.textContent = mark.text;
  const height = (probe.offsetHeight * page.width) / page.element.clientWidth;
  probe.textContent = '';
  return height;
}

/** A text box being typed: grows with its text, sized and placed as it draws. */
function TextEditor({
  mark,
  page,
  onChange,
  onDone,
}: {
  mark: Mark;
  page: PageInfo;
  onChange: (text: string) => void;
  /** `kept` when Escape closed it, so the box stays selected. */
  onDone: (kept: boolean) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const escaped = useRef(false);
  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  });
  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);
  return (
    <textarea
      aria-label={m.pdf_text()}
      className="pointer-events-auto absolute m-0 resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-sans leading-[1.25] outline-none"
      maxLength={2000}
      onBlur={() => onDone(escaped.current)}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          escaped.current = true;
          event.currentTarget.blur();
        }
      }}
      ref={ref}
      rows={1}
      style={textStyle(mark, page)}
      value={mark.text}
    />
  );
}

export const PdfMarkLayer = memo(function PdfMarkLayer({
  page,
  marks,
  selected,
  editing,
  onTextChange,
  onTextDone,
  bubbles,
  onBubble,
  handles,
  onHandle,
  children,
}: {
  page: PageInfo;
  /** This page's marks in drawing order. */
  marks: readonly Mark[];
  selected: readonly Mark[];
  /** The text box being typed on this page. */
  editing: Mark | null;
  onTextChange: (text: string) => void;
  onTextDone: (kept: boolean) => void;
  /** Comment icons on commented marks, when no margin shows them. */
  bubbles: boolean;
  onBubble: (mark: Mark) => void;
  /** The lone selection's handles. */
  handles: { mark: Mark; handles: Handle[] } | null;
  onHandle: (event: React.PointerEvent, mark: Mark, handle: Handle) => void;
  /** The selection's bar and comment anchor. */
  children?: ReactNode;
}) {
  const underText = marks.filter(
    (mark) => mark.kind === 'highlight' || mark.kind === 'marker'
  );
  const ink = marks.filter(
    (mark) => mark.kind !== 'highlight' && mark.kind !== 'marker'
  );
  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[2] h-full w-full overflow-visible"
        data-pdf-marks={page.number}
        viewBox={`0 0 ${page.width} ${page.height}`}
      >
        {underText.map((mark) => (
          <MarkShape key={mark.id} mark={mark} />
        ))}
        {ink.map((mark) => (
          <MarkShape key={mark.id} mark={mark} />
        ))}
        {/* The stroke being drawn, set straight on the element (no render). */}
        <path data-live fill="none" />
      </svg>
      <div className="pointer-events-none absolute inset-0 z-[3] [container-type:inline-size]">
        <div
          aria-hidden="true"
          className="invisible absolute whitespace-pre-wrap break-words font-sans leading-[1.25]"
          data-pdf-text-probe
        />
        {marks.map((mark) =>
          mark.kind === 'text' ? (
            editing?.id === mark.id ? null : (
              <div
                className="absolute whitespace-pre-wrap break-words font-sans leading-[1.25]"
                key={mark.id}
                style={textStyle(mark, page)}
              >
                {mark.text}
              </div>
            )
          ) : null
        )}
        {editing && (
          <TextEditor
            mark={editing}
            onChange={onTextChange}
            onDone={onTextDone}
            page={page}
          />
        )}
        {selected.map((mark) => (
          <div
            className="absolute outline outline-1 outline-action-accent outline-offset-2"
            key={mark.id}
            style={boxStyle(markBox(mark), page)}
          />
        ))}
        {handles?.handles.map((handle) => {
          const box = markBox(handles.mark);
          const x = handle.includes('w') ? box.x : box.x + box.width;
          const y =
            handle === 'e'
              ? box.y + box.height / 2
              : handle.includes('n')
                ? box.y
                : box.y + box.height;
          return (
            <div
              className={cn(
                'pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-action-accent bg-surface',
                handle === 'e'
                  ? 'cursor-ew-resize'
                  : handle === 'nw' || handle === 'se'
                    ? 'cursor-nwse-resize'
                    : 'cursor-nesw-resize'
              )}
              data-handle={handle}
              key={handle}
              onPointerDown={(event) => onHandle(event, handles.mark, handle)}
              style={{ left: pct(x, page.width), top: pct(y, page.height) }}
            />
          );
        })}
        {bubbles &&
          marks
            .filter((mark) => mark.comment && mark.kind !== 'note')
            .map((mark) => {
              const box = markBox(mark);
              return (
                <button
                  aria-label={m.pdf_comment_label({ comment: mark.comment })}
                  className="pointer-events-auto absolute -translate-y-1/2 p-0.5"
                  data-pdf-bubble
                  key={mark.id}
                  onClick={() => onBubble(mark)}
                  style={{
                    left: pct(box.x + box.width, page.width),
                    top: pct(box.y, page.height),
                  }}
                  title={mark.comment}
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    height="16"
                    viewBox="0 0 24 24"
                    width="16"
                  >
                    <path
                      d="M3 4h18v12H9l-6 5z"
                      fill={mark.color}
                      stroke="#fff"
                      strokeWidth="1.5"
                    />
                  </svg>
                </button>
              );
            })}
        {children}
      </div>
    </>
  );
});
