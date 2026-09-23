import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFAnnotation, PDFAnnotationBody } from '@/api/types';
import { WarningBanner } from '@/components/banners/WarningBanner';
import { m } from '@/i18n';
import { PdfAnnotationToolbar, type PdfTool } from './PdfAnnotationToolbar';
import {
  clientRectToPage,
  eraseRects,
  eraserIntersectsPen,
  eraserIntersectsRect,
  fullyHighlighted,
  intersection,
  type PdfSelection,
  pdfTextSelection,
  rotateRect,
} from './pdfAnnotationGeometry';
import { usePdfAnnotations } from './usePdfAnnotations';

type Point = { x: number; y: number };
const ERASER_RADIUS = 48;
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="98" height="98"><circle cx="49" cy="49" r="48" fill="#ffffff33" stroke="white" stroke-width="2"/><circle cx="49" cy="49" r="47" fill="none" stroke="#333"/></svg>')}") 49 49, none`;

export function PdfAnnotations({
  containerRef,
  toolbar,
  fileId,
  revision,
  renderVersion,
  editing,
  onPendingChange,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  toolbar: HTMLElement | null;
  fileId: string;
  revision: number;
  renderVersion: string;
  editing: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const sourceIdentity = `revision:${revision}`;
  const {
    annotations,
    change,
    isPending,
    isSaving,
    unavailable,
    writeError,
    canUndo,
    canRedo,
    undo,
    redo,
  } = usePdfAnnotations(fileId, sourceIdentity);
  const [tool, setTool] = useState<PdfTool>('select');
  const [color, setColor] = useState('#d94848');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<PDFAnnotationBody | null>(null);
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef({
    annotations,
    change,
    color,
    editing,
    isPending,
    redo,
    text,
    tool,
    undo,
  });
  stateRef.current = {
    annotations,
    change,
    color,
    editing,
    isPending,
    redo,
    text,
    tool,
    undo,
  };
  const selectedRef = useRef<PdfSelection[]>([]);
  useEffect(() => {
    onPendingChange?.(isSaving || dragging);
    return () => onPendingChange?.(false);
  }, [isSaving, dragging, onPendingChange]);

  function applyHighlight(selection: PdfSelection[], toggle: boolean) {
    const state = stateRef.current;
    if (!selection.length || state.isPending || !state.editing) return;
    const erase =
      toggle &&
      selection.every((part) =>
        fullyHighlighted(
          part.rects,
          state.annotations
            .filter(
              (mark) => mark.page === part.page && mark.kind === 'highlight'
            )
            .flatMap((mark) => mark.rects)
        )
      );
    if (!erase) {
      void state.change({
        create: selection.map((part) => ({
          ...part,
          color: state.color,
          kind: 'highlight',
          sourceIdentity,
        })),
      });
      return;
    }
    const update: PDFAnnotation[] = [],
      remove: string[] = [];
    for (const mark of state.annotations) {
      if (mark.kind !== 'highlight') continue;
      const cuts = selection
        .filter((part) => part.page === mark.page)
        .flatMap((part) => part.rects);
      if (
        !cuts.some((cut) => mark.rects.some((rect) => intersection(rect, cut)))
      )
        continue;
      const rects = eraseRects(mark.rects, cuts);
      if (rects.length) update.push({ ...mark, rects });
      else remove.push(mark.id);
    }
    void state.change({ remove, update });
  }
  const highlightRef = useRef(applyHighlight);
  highlightRef.current = applyHighlight;
  const chooseTool = (next: PdfTool) => {
    if (next === 'highlight' && selectedRef.current.length) {
      applyHighlight(selectedRef.current, true);
      window.getSelection()?.removeAllRanges();
    }
    selectedRef.current = [];
    setTool(next);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let drag: {
      page: HTMLElement;
      start: Point;
      last: Point;
      points: Point[];
      removed: Set<string>;
      tool: PdfTool;
    } | null = null;
    const point = (event: PointerEvent) => ({
      x: event.clientX,
      y: event.clientY,
    });
    const normalized = (p: Point, page: HTMLElement) => {
      const { x, y } = clientRectToPage(
        { height: 0, left: p.x, top: p.y, width: 0 },
        page
      );
      return { x, y };
    };
    const hit = (start: Point, end: Point) => {
      const page = document
        .elementFromPoint(end.x, end.y)
        ?.closest<HTMLElement>('[data-page]');
      if (!drag || !page || !container.contains(page)) return;
      const bounds = page.getBoundingClientRect();
      const rotation = Number(page.dataset.rotation ?? 0);
      for (const mark of stateRef.current.annotations) {
        if (mark.page !== Number(page.dataset.page)) continue;
        if (
          mark.rects.some((raw) => {
            const rect = rotateRect(raw, rotation);
            return eraserIntersectsRect(
              start,
              end,
              {
                height: (rect.height * bounds.height) / 1000,
                width: (rect.width * bounds.width) / 1000,
                x: bounds.left + (rect.x * bounds.width) / 1000,
                y: bounds.top + (rect.y * bounds.height) / 1000,
              },
              ERASER_RADIUS
            );
          }) &&
          (mark.kind !== 'pen' ||
            eraserIntersectsPen(
              start,
              end,
              (mark.points ?? []).map((point) => {
                const rotated = rotateRect(
                  { ...point, height: 0, width: 0 },
                  rotation
                );
                return {
                  x: bounds.left + (rotated.x * bounds.width) / 1000,
                  y: bounds.top + (rotated.y * bounds.height) / 1000,
                };
              }),
              ERASER_RADIUS + Math.max(bounds.width, bounds.height) / 1000
            ))
        )
          drag.removed.add(mark.id);
      }
    };
    const makeDraft = (end: Point): PDFAnnotationBody | null => {
      if (!drag) return null;
      const { color, text } = stateRef.current;
      const kind = drag.tool;
      if (
        kind !== 'pen' &&
        kind !== 'text' &&
        kind !== 'rectangle' &&
        kind !== 'ellipse'
      )
        return null;
      const rect = clientRectToPage(
        {
          height: Math.abs(end.y - drag.start.y),
          left: Math.min(drag.start.x, end.x),
          top: Math.min(drag.start.y, end.y),
          width: Math.abs(end.x - drag.start.x),
        },
        drag.page
      );
      const body: PDFAnnotationBody = {
        color,
        kind,
        page: Number(drag.page.dataset.page),
        rects: [rect],
        sourceIdentity,
      };
      if (kind === 'pen') {
        const points = drag.points.map((p) => normalized(p, drag!.page));
        const x = Math.max(0, Math.min(...points.map((p) => p.x)) - 1),
          y = Math.max(0, Math.min(...points.map((p) => p.y)) - 1);
        body.rects = [
          {
            height: Math.min(
              1000 - y,
              Math.max(...points.map((p) => p.y)) - y + 1
            ),
            width: Math.min(
              1000 - x,
              Math.max(...points.map((p) => p.x)) - x + 1
            ),
            x,
            y,
          },
        ];
        body.points = points;
      }
      if (kind === 'text') {
        if (!text) return null;
        const p = normalized(drag.start, drag.page);
        const x = Math.min(999, p.x),
          y = Math.min(980, p.y);
        body.rects = [
          {
            height: 20,
            width: Math.min(1000 - x, Math.max(20, [...text].length * 12)),
            x,
            y,
          },
        ];
        body.text = text;
      }
      return body;
    };
    const down = (event: PointerEvent) => {
      const state = stateRef.current;
      if (
        !state.editing ||
        state.isPending ||
        event.button !== 0 ||
        !(event.target instanceof Element)
      )
        return;
      const page = event.target.closest<HTMLElement>('[data-page]');
      if (
        !page ||
        !container.contains(page) ||
        state.tool === 'select' ||
        state.tool === 'highlight'
      )
        return;
      event.preventDefault();
      container.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges();
      const start = point(event);
      drag = {
        last: start,
        page,
        points: [start],
        removed: new Set(),
        start,
        tool: state.tool,
      };
      setDragging(true);
      if (state.tool === 'eraser') hit(start, start);
      else setDraft(makeDraft(start));
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      const end = point(event);
      if (drag.tool === 'eraser') hit(drag.last, end);
      else {
        if (
          drag.tool === 'pen' &&
          drag.points.length < 4096 &&
          Math.hypot(end.x - drag.last.x, end.y - drag.last.y) >= 1
        )
          drag.points.push(end);
        setDraft(makeDraft(end));
      }
      drag.last = end;
    };
    const cancel = () => {
      drag = null;
      setDraft(null);
      setDragging(false);
    };
    const up = (event: PointerEvent) => {
      if (drag) {
        if (drag.tool === 'eraser') {
          hit(drag.last, point(event));
          void stateRef.current.change({ remove: [...drag.removed] });
        } else {
          if (drag.tool === 'pen' && drag.points.length === 1)
            drag.points.push(point(event));
          const body = makeDraft(point(event));
          if (body?.rects.every((rect) => rect.width > 0 && rect.height > 0))
            void stateRef.current.change({ create: [body] });
        }
        cancel();
      } else if (
        stateRef.current.editing &&
        stateRef.current.tool === 'highlight' &&
        event.target instanceof Node &&
        container.contains(event.target)
      ) {
        highlightRef.current(pdfTextSelection(container), false);
        selectedRef.current = [];
        window.getSelection()?.removeAllRanges();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        !stateRef.current.editing ||
        !(event.target instanceof Node) ||
        !container.contains(event.target)
      )
        return;
      if (event.key === 'Escape') {
        cancel();
        setTool('select');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (!stateRef.current.isPending)
          (event.shiftKey ? stateRef.current.redo : stateRef.current.undo)();
      }
    };
    container.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    container.addEventListener('keydown', keydown);
    window.addEventListener('blur', cancel);
    return () => {
      container.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      container.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', cancel);
    };
  }, [containerRef, sourceIdentity]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!editing) selectedRef.current = [];
    container.style.cursor =
      !editing || tool === 'select' || tool === 'highlight'
        ? 'text'
        : tool === 'eraser'
          ? ERASER_CURSOR
          : 'crosshair';
    container.style.touchAction =
      editing && tool !== 'select' && tool !== 'highlight' ? 'none' : '';
    return () => {
      container.style.cursor = '';
      container.style.touchAction = '';
    };
  }, [containerRef, editing, tool]);
  const pages = containerRef.current
    ? [...containerRef.current.querySelectorAll<HTMLElement>('[data-page]')]
    : [];
  void renderVersion;
  return (
    <>
      {toolbar &&
        createPortal(
          <PdfAnnotationToolbar
            canRedo={canRedo}
            canUndo={canUndo}
            color={color}
            disabled={!editing || isPending || unavailable}
            onColor={setColor}
            onDrawOpen={() => {
              // Capture only the current selection before the menu takes focus.
              selectedRef.current = containerRef.current
                ? pdfTextSelection(containerRef.current)
                : [];
            }}
            onRedo={redo}
            onText={setText}
            onTool={chooseTool}
            onUndo={undo}
            tool={tool}
          />,
          toolbar
        )}
      {writeError && (
        <WarningBanner message={m.pdf_annotations_write_failed()} />
      )}
      {pages.map((page) => {
        const number = Number(page.dataset.page),
          rotation = Number(page.dataset.rotation ?? 0);
        const marks: PDFAnnotationBody[] = [
          ...annotations.filter((mark) => mark.page === number),
          ...(draft?.page === number ? [draft] : []),
        ];
        return createPortal(
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-[2] h-full w-full"
            preserveAspectRatio="none"
            viewBox="0 0 1000 1000"
          >
            <g transform={`rotate(${rotation} 500 500)`}>
              {marks.map((mark, index) =>
                mark.kind === 'pen' ? (
                  <polyline
                    fill="none"
                    key={index}
                    points={mark.points?.map((p) => `${p.x},${p.y}`).join(' ')}
                    stroke={mark.color}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                  />
                ) : (
                  mark.rects.map((rect, i) =>
                    mark.kind === 'text' ? (
                      <text
                        fill={mark.color}
                        fontSize={20}
                        key={`${index}:${i}`}
                        lengthAdjust="spacingAndGlyphs"
                        textLength={rect.width}
                        x={rect.x}
                        y={rect.y + 16}
                      >
                        {mark.text}
                      </text>
                    ) : mark.kind === 'ellipse' ? (
                      <ellipse
                        cx={rect.x + rect.width / 2}
                        cy={rect.y + rect.height / 2}
                        fill="none"
                        key={`${index}:${i}`}
                        rx={rect.width / 2}
                        ry={rect.height / 2}
                        stroke={mark.color}
                        strokeWidth={2}
                      />
                    ) : (
                      <rect
                        {...rect}
                        fill={mark.kind === 'highlight' ? mark.color : 'none'}
                        fillOpacity={0.35}
                        key={`${index}:${i}`}
                        stroke={mark.kind === 'highlight' ? 'none' : mark.color}
                        strokeWidth={2}
                      />
                    )
                  )
                )
              )}
            </g>
          </svg>,
          page,
          `annotations:${number}`
        );
      })}
    </>
  );
}
