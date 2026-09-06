import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/api/client';
import type { PDFAnnotation, PDFAnnotationBody } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  clientRectToPage,
  eraseRects,
  fullyHighlighted,
  intersection,
  type PdfRect,
  type PdfSelection,
  pdfTextSelection,
  rotateRect,
  segmentIntersectsRect,
  toolbarPosition,
} from './pdfAnnotationGeometry';

type PrivatePdfAnnotation = PDFAnnotation;
type AnnotationInput = PDFAnnotationBody;
type Tool = PrivatePdfAnnotation['kind'] | 'eraser';
const CLIPPED_OVERFLOW = /(auto|scroll|hidden|clip)/;
const COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6'];

export function PdfAnnotations({
  containerRef,
  fileId,
  revision,
  renderVersion,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  fileId: string;
  revision: number;
  renderVersion: string;
}) {
  const sourceIdentity = `revision:${revision}`;
  const queryKey = ['file', fileId, 'private-annotations'];
  const cache = useQueryClient();
  const { data: annotations = [], isError } = useQuery({
    meta: { errorBoundary: false },
    queryFn: () =>
      api.get<PrivatePdfAnnotation[]>(`/files/${fileId}/annotations`),
    queryKey,
  });
  const { mutateAsync: change, isPending } = useMutation({
    mutationFn: async (changes: {
      create?: AnnotationInput[];
      update?: PrivatePdfAnnotation[];
      remove?: string[];
    }) => {
      // Serial writes keep partial erasing deterministic. The query is refetched even on failure.
      for (const id of changes.remove ?? [])
        await api.del(`/files/${fileId}/annotations/${id}`);
      for (const mark of changes.update ?? [])
        await api.patch(`/files/${fileId}/annotations/${mark.id}`, {
          color: mark.color,
          kind: mark.kind,
          page: mark.page,
          rects: mark.rects,
          sourceIdentity: mark.sourceIdentity,
        });
      for (const mark of changes.create ?? [])
        await api.post(`/files/${fileId}/annotations`, mark);
    },
    onSettled: () => cache.invalidateQueries({ queryKey }),
    scope: { id: `pdf-annotations:${fileId}` },
  });
  const [tool, setTool] = useState<Tool | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<{ page: number; rect: PdfRect } | null>(
    null
  );
  const [layout, setLayout] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const current = annotations.filter(
    (mark) => mark.sourceIdentity === sourceIdentity
  );
  const stateRef = useRef({ change, color, current, isPending, tool });
  stateRef.current = { change, color, current, isPending, tool };

  async function applySelection(
    selection: PdfSelection[],
    mode: 'highlight' | 'eraser',
    toggle: boolean
  ) {
    const state = stateRef.current;
    if (!selection.length || state.isPending || isError) return;
    const erase =
      mode === 'eraser' ||
      (toggle &&
        selection.every((part) =>
          fullyHighlighted(
            part.rects,
            state.current
              .filter(
                (mark) => mark.page === part.page && mark.kind === 'highlight'
              )
              .flatMap((mark) => mark.rects)
          )
        ));
    if (!erase) {
      await state
        .change({
          create: selection.map((part) => ({
            ...part,
            color: state.color,
            kind: 'highlight',
            sourceIdentity,
          })),
        })
        .catch(() => {});
      return;
    }
    const update: PrivatePdfAnnotation[] = [],
      remove: string[] = [];
    for (const mark of state.current) {
      const cuts = selection
        .filter((part) => part.page === mark.page)
        .flatMap((part) => part.rects);
      if (
        !cuts.some((cut) => mark.rects.some((rect) => intersection(rect, cut)))
      )
        continue;
      const rects =
        mark.kind === 'highlight' ? eraseRects(mark.rects, cuts) : [];
      if (rects.length) update.push({ ...mark, rects });
      else remove.push(mark.id);
    }
    await state.change({ remove, update }).catch(() => {});
  }
  const applyRef = useRef(applySelection);
  applyRef.current = applySelection;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const placeCursor = (x: number, y: number) => {
      const bounds = container.getBoundingClientRect();
      setCursor({ x: x - bounds.left, y: y - bounds.top });
    };
    let drag: {
      page: HTMLElement;
      x: number;
      y: number;
      eraseIds: Set<string>;
      lastX: number;
      lastY: number;
    } | null = null;
    const insideToolbar = (target: EventTarget | null) =>
      target instanceof Node && toolbarRef.current?.contains(target);
    const hitMarks = (x: number, y: number, page: HTMLElement) => {
      const point = clientRectToPage(
        { height: 6, left: x - 3, top: y - 3, width: 6 },
        page
      );
      return stateRef.current.current
        .filter(
          (mark) =>
            mark.page === Number(page.dataset.page) &&
            mark.rects.some((rect) => intersection(rect, point))
        )
        .map((mark) => mark.id);
    };
    const down = (event: PointerEvent) => {
      if (insideToolbar(event.target)) return;
      if (
        !(event.target instanceof Element) ||
        !container.contains(event.target)
      ) {
        setFocused(false);
        return;
      }
      const page = event.target.closest<HTMLElement>('[data-page]');
      if (!page || stateRef.current.isPending) return;
      setFocused(true);
      placeCursor(event.clientX, event.clientY);
      if (stateRef.current.tool && stateRef.current.tool !== 'highlight') {
        event.preventDefault();
        container.focus({ preventScroll: true });
        window.getSelection()?.removeAllRanges();
        drag = {
          eraseIds: new Set(hitMarks(event.clientX, event.clientY, page)),
          lastX: event.clientX,
          lastY: event.clientY,
          page,
          x: event.clientX,
          y: event.clientY,
        };
      }
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      if (stateRef.current.tool === 'eraser') {
        const page = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-page]');
        if (page && container.contains(page)) {
          const start = clientRectToPage(
            { height: 0, left: drag.lastX, top: drag.lastY, width: 0 },
            page
          );
          const end = clientRectToPage(
            { height: 0, left: event.clientX, top: event.clientY, width: 0 },
            page
          );
          for (const mark of stateRef.current.current)
            if (
              mark.page === Number(page.dataset.page) &&
              mark.rects.some((rect) => segmentIntersectsRect(start, end, rect))
            )
              drag.eraseIds.add(mark.id);
          drag.lastX = event.clientX;
          drag.lastY = event.clientY;
        }
      } else {
        setDraft({
          page: Number(drag.page.dataset.page),
          rect: clientRectToPage(
            {
              height: Math.abs(event.clientY - drag.y),
              left: Math.min(drag.x, event.clientX),
              top: Math.min(drag.y, event.clientY),
              width: Math.abs(event.clientX - drag.x),
            },
            drag.page
          ),
        });
      }
    };
    const up = (event: PointerEvent) => {
      if (insideToolbar(event.target)) return;
      const state = stateRef.current;
      if (drag) {
        if (state.tool === 'eraser')
          void state.change({ remove: [...drag.eraseIds] }).catch(() => {});
        else if (state.tool === 'rectangle' || state.tool === 'ellipse') {
          const rect = clientRectToPage(
            {
              height: Math.abs(event.clientY - drag.y),
              left: Math.min(drag.x, event.clientX),
              top: Math.min(drag.y, event.clientY),
              width: Math.abs(event.clientX - drag.x),
            },
            drag.page
          );
          if (rect.width > 1 && rect.height > 1)
            void state
              .change({
                create: [
                  {
                    color: state.color,
                    kind: state.tool,
                    page: Number(drag.page.dataset.page),
                    rects: [rect],
                    sourceIdentity,
                  },
                ],
              })
              .catch(() => {});
        }
        placeCursor(event.clientX, event.clientY);
        drag = null;
        setDraft(null);
      } else if (
        state.tool === 'highlight' &&
        event.target instanceof Node &&
        container.contains(event.target)
      ) {
        placeCursor(event.clientX, event.clientY);
        void applyRef.current(pdfTextSelection(container), 'highlight', false);
      }
    };
    const focus = (event: FocusEvent) => {
      if (
        !insideToolbar(event.target) &&
        event.target instanceof Node &&
        !container.contains(event.target)
      )
        setFocused(false);
    };
    const blur = () => setFocused(false);
    const reposition = () => setLayout((value) => value + 1);
    const observer = new ResizeObserver(reposition);
    observer.observe(container);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('focusin', focus);
    window.addEventListener('blur', blur);
    window.addEventListener('scroll', reposition, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('focusin', focus);
      window.removeEventListener('blur', blur);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [containerRef, fileId, sourceIdentity]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.style.cursor =
      tool === null || tool === 'highlight'
        ? 'text'
        : tool === 'eraser'
          ? 'cell'
          : 'crosshair';
    return () => {
      container.style.cursor = '';
    };
  }, [containerRef, tool]);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!focused || !toolbar) return;
    const observer = new ResizeObserver(() => setLayout((value) => value + 1));
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [focused]);

  const pages = containerRef.current
    ? [...containerRef.current.querySelectorAll<HTMLElement>('[data-page]')]
    : [];
  const overlays = pages.map((page) => {
    const number = Number(page.dataset.page),
      rotation = Number(page.dataset.rotation ?? 0);
    const marks = current.filter((mark) => mark.page === number);
    if (draft?.page === number)
      marks.push({
        authorId: '',
        color,
        createdAt: '',
        fileId,
        id: 'draft',
        kind: tool === 'ellipse' ? 'ellipse' : 'rectangle',
        page: number,
        rects: [draft.rect],
        sourceIdentity,
        updatedAt: '',
      });
    return createPortal(
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[2] h-full w-full"
        preserveAspectRatio="none"
        viewBox="0 0 1000 1000"
      >
        {marks.flatMap((mark) =>
          mark.rects.map((raw, i) => {
            const rect = rotateRect(raw, rotation);
            return mark.kind === 'ellipse' ? (
              <ellipse
                cx={rect.x + rect.width / 2}
                cy={rect.y + rect.height / 2}
                fill="none"
                key={`${mark.id}:${i}`}
                rx={rect.width / 2}
                ry={rect.height / 2}
                stroke={mark.color}
                strokeWidth={2}
              />
            ) : (
              <rect
                key={`${mark.id}:${i}`}
                {...rect}
                fill={mark.kind === 'highlight' ? mark.color : 'none'}
                fillOpacity={0.35}
                stroke={mark.kind === 'highlight' ? 'none' : mark.color}
                strokeWidth={2}
              />
            );
          })
        )}
      </svg>,
      page,
      `annotations:${number}`
    );
  });
  void renderVersion;
  void layout;
  const bounds = containerRef.current?.getBoundingClientRect();
  const viewport = containerRef.current
    ? visiblePdfBounds(containerRef.current)
    : null;
  const position =
    cursor && bounds && viewport
      ? toolbarPosition(
          { x: cursor.x + bounds.left, y: cursor.y + bounds.top },
          viewport,
          toolbarRef.current?.offsetWidth ?? 300,
          toolbarRef.current?.offsetHeight ?? 42
        )
      : null;
  const labels = {
    ellipse: m.pdf_ellipse(),
    eraser: m.pdf_eraser(),
    highlight: m.pdf_highlight(),
    rectangle: m.pdf_rectangle(),
  };
  return (
    <>
      {overlays}
      {isError && (
        <p className="p-2 text-sm text-tint-error-fg">
          {m.pdf_annotations_failed()}
        </p>
      )}
      {focused && position && (
        <div
          aria-label={m.pdf_private_annotations()}
          className="fixed z-40 flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-1 shadow-lg"
          onPointerDown={(event) => event.preventDefault()}
          ref={toolbarRef}
          role="toolbar"
          style={{
            ...position,
            maxWidth: viewport
              ? viewport.right - viewport.left - 16
              : undefined,
          }}
        >
          {(Object.keys(labels) as Tool[]).map((value) => (
            <Button
              aria-pressed={tool === value}
              disabled={isPending || isError}
              key={value}
              onClick={() => {
                setTool(value);
                const container = containerRef.current;
                if (container && (value === 'highlight' || value === 'eraser'))
                  void applySelection(pdfTextSelection(container), value, true);
              }}
              size="sm"
              variant={tool === value ? 'surface' : 'ghost-hover'}
            >
              {labels[value]}
            </Button>
          ))}
          {COLORS.map((value) => (
            <button
              aria-label={m.pdf_annotation_color({ color: value })}
              aria-pressed={value === color}
              className={cn(
                'h-5 w-5 rounded-full border-2',
                value === color ? 'border-fg' : 'border-transparent'
              )}
              key={value}
              onClick={() => setColor(value)}
              style={{ backgroundColor: value }}
              type="button"
            />
          ))}
        </div>
      )}
    </>
  );
}

function visiblePdfBounds(element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  const visible = {
    bottom: Math.min(window.innerHeight, bounds.bottom),
    left: Math.max(0, bounds.left),
    right: Math.min(window.innerWidth, bounds.right),
    top: Math.max(0, bounds.top),
  };
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = window.getComputedStyle(parent);
    if (CLIPPED_OVERFLOW.test(`${style.overflowX} ${style.overflowY}`)) {
      const clip = parent.getBoundingClientRect();
      visible.left = Math.max(visible.left, clip.left);
      visible.top = Math.max(visible.top, clip.top);
      visible.right = Math.min(visible.right, clip.right);
      visible.bottom = Math.min(visible.bottom, clip.bottom);
    }
  }
  return visible;
}
