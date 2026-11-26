import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { FileBanner } from '@/components/banners/FileBanner';
import { m } from '@/i18n';
import { useReportEditorStatus } from './fileModeContext';
import {
  PdfAnnotationToolbar,
  type PdfTool,
  type ShapeTool,
  TOOL_KEYS,
} from './PdfAnnotationToolbar';
import { CommentEditor, SelectionBar, TextSelectionBar } from './PdfMarkBars';
import { CommentMargin, MarksMenus } from './PdfMarkComments';
import { measureTextHeight, type PageInfo, PdfMarkLayer } from './PdfMarkLayer';
import {
  applyChange,
  clampShift,
  distance,
  ERASER_PX,
  eraseAlong,
  GROUP_MS,
  GROUP_REACH,
  type Handle,
  isStroked,
  MARK_COLORS,
  MAX_POINTS,
  type Mark,
  type MarkChange,
  markBox,
  markHandles,
  moveMark,
  NOTE_SIZE,
  newMarkId,
  normalizeMark,
  onText,
  type PageFrame,
  type Point,
  pageFrame,
  resizeMark,
  roundPoint,
  simplify,
  smoothPath,
  straighten,
  strokeWidth,
  TEXT_SIZES,
  TEXT_WIDTH,
  type TextBand,
  textSelectionBands,
  toPage,
  topHit,
  unionBox,
  type Weight,
} from './pdfMarks';
import { usePdfMarks } from './usePdfMarks';

const YELLOW = MARK_COLORS[0];
/** A note's colour while the yellow default is picked (Epo 2026-11-24). */
const PURPLE = MARK_COLORS[4];
const COLOR_KEY = /^[1-6]$/;
const BLACK = MARK_COLORS[5];
/** A mark is hit this near its ink, in CSS pixels. */
const HIT_PX = 6;
/** A shape smaller than this, in units, was a click: it is not kept. */
const MIN_SHAPE = 4;
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${ERASER_PX * 2 + 2}" height="${ERASER_PX * 2 + 2}"><circle cx="${ERASER_PX + 1}" cy="${ERASER_PX + 1}" r="${ERASER_PX}" fill="#ffffff55" stroke="#333"/></svg>`)}") ${ERASER_PX + 1} ${ERASER_PX + 1}, crosshair`;

const blankMark = (kind: Mark['kind'], page: number, color: string): Mark => ({
  color,
  comment: '',
  id: newMarkId(),
  kind,
  page,
  rects: [],
  size: 0,
  strokes: [],
  text: '',
  width: 0,
});

type Drag =
  | {
      kind: 'stroke';
      mark: Mark;
      /** The pen mark this stroke joins (D6), as it was. */
      joins: Mark | null;
      points: Point[];
      frame: PageFrame;
      live: SVGPathElement | null;
    }
  | {
      kind: 'move';
      start: Point;
      frame: PageFrame;
      marks: Mark[];
      moved: boolean;
      /** A note whose comment a click opens; a drag moves it instead. */
      open?: string;
    }
  | { kind: 'resize'; mark: Mark; handle: Handle; frame: PageFrame }
  | { kind: 'shape'; mark: Mark; start: Point; frame: PageFrame }
  | { kind: 'erase'; page: number; last: Point; frame: PageFrame };

export function PdfAnnotations({
  containerRef,
  toolbar,
  toolbarEnd,
  strip,
  margin,
  onMarginChange,
  fileId,
  revision,
  renderVersion,
  readOnly: viewOnly,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  /** The toolbar's scrolling tools, and its pinned end. */
  toolbar: HTMLElement | null;
  toolbarEnd: HTMLElement | null;
  /** Under the PDF toolbar, outside the scrolling pages, so a strip stays in
   * view like the ones under a note's toolbar. */
  strip: HTMLElement | null;
  /** Beside the pages, while the pane has room and a mark has a comment. */
  margin: HTMLElement | null;
  onMarginChange: (state: { comments: number; collapsed: boolean }) => void;
  fileId: string;
  revision: number;
  renderVersion: string;
  /** Trashed or shared to view: the marks draw and nothing changes them. */
  readOnly: boolean;
}) {
  const store = usePdfMarks(fileId, `revision:${revision}`);
  const { commit, ready, saving, wrote, writeError } = store;
  // A member's feedback on their own submission reads only.
  const readOnly = viewOnly || store.readOnly;
  const editable = !readOnly;
  const [tool, setToolState] = useState<PdfTool>('select');
  const [shape, setShape] = useState<ShapeTool>('rectangle');
  // Marks start yellow, notes purple (Epo 2026-11-24).
  const [color, setColor] = useState<string>(YELLOW);
  const [weight, setWeight] = useState<Weight>('m');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** A text box or note not saved yet, or a text box being retyped. */
  const [draft, setDraft] = useState<Mark | null>(null);
  const [typing, setTyping] = useState(false);
  const [commentFor, setCommentFor] = useState<string | null>(null);
  /** Marks as a drag, a shape or the eraser leaves them, until it ends. */
  const [preview, setPreviewState] = useState<MarkChange | null>(null);
  const previewRef = useRef<MarkChange | null>(null);
  const setPreview = useCallback((next: MarkChange | null) => {
    previewRef.current = next;
    setPreviewState(next);
  }, []);
  const [bands, setBands] = useState<TextBand[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pages, setPages] = useState<PageInfo[]>([]);

  const marks = useMemo(() => {
    let list = preview ? applyChange(store.marks, preview) : store.marks;
    if (draft)
      list = list.some((mark) => mark.id === draft.id)
        ? list.map((mark) => (mark.id === draft.id ? draft : mark))
        : [...list, draft];
    return list;
  }, [store.marks, preview, draft]);
  // A page keeps its array while its marks are the same, so its layer skips.
  const byPageRef = useRef(new Map<number, Mark[]>());
  const byPage = useMemo(() => {
    const next = new Map<number, Mark[]>();
    for (const mark of marks) {
      const list = next.get(mark.page);
      if (list) list.push(mark);
      else next.set(mark.page, [mark]);
    }
    for (const [page, list] of next) {
      const before = byPageRef.current.get(page);
      if (
        before?.length === list.length &&
        before.every((mark, i) => mark === list[i])
      )
        next.set(page, before);
    }
    byPageRef.current = next;
    return next;
  }, [marks]);
  const selected = useMemo(
    () =>
      editable ? marks.filter((mark) => selectedIds.includes(mark.id)) : [],
    [editable, marks, selectedIds]
  );

  useReportEditorStatus(
    editable
      ? saving
        ? 'syncing'
        : writeError
          ? 'error'
          : wrote
            ? 'saved'
            : 'synced'
      : null
  );
  const comments = store.marks.filter((mark) => mark.comment).length;
  useEffect(() => {
    onMarginChange({ collapsed, comments });
  }, [collapsed, comments, onMarginChange]);

  useLayoutEffect(() => {
    // Portals need the page wrappers from this commit, including cached PDF opens.
    const container = containerRef.current;
    setPages(
      container
        ? [...container.querySelectorAll<HTMLElement>('[data-page]')].map(
            (element) => {
              const frame = pageFrame(element);
              return {
                element,
                height: frame.height,
                number: Number(element.dataset.page),
                width: frame.width,
              };
            }
          )
        : []
    );
  }, [containerRef, renderVersion]);

  const state = {
    bands,
    color,
    commentFor,
    commit,
    draft,
    editable,
    marks,
    pages,
    ready,
    redo: store.redo,
    savedMarks: store.marks,
    selectedIds,
    shape,
    tool,
    typing,
    undo: store.undo,
    weight,
  };
  const stateRef = useRef(state);
  stateRef.current = state;

  const setTool = useCallback((next: PdfTool) => {
    if (next === 'rectangle' || next === 'ellipse' || next === 'arrow')
      setShape(next);
    setToolState(next);
    setSelectedIds([]);
    setBands(null);
    setCommentFor(null);
  }, []);
  const change = useCallback((entries: [string, Mark | null][]) => {
    stateRef.current.commit(new Map(entries));
  }, []);
  /** Edits the draft when it is one of them, else saves them. */
  const edit = useCallback(
    (targets: readonly Mark[], update: (mark: Mark) => Mark) => {
      const { draft: current } = stateRef.current;
      if (current && targets.some((mark) => mark.id === current.id))
        setDraft(update(current));
      const saved = targets.filter((mark) => mark.id !== current?.id);
      if (saved.length) change(saved.map((mark) => [mark.id, update(mark)]));
    },
    [change]
  );

  // A pen mark the next stroke may join (D6).
  const lastPen = useRef<{ id: string; at: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const activePointer = useRef<number | null>(null);
  const activeType = useRef<string | null>(null);
  /** A pen was used here: a touch while drawing is a palm, not ink. */
  const penSeen = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pageOf = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest<HTMLElement>('[data-page]')
        : null;
    const info = (element: HTMLElement) =>
      stateRef.current.pages.find((page) => page.element === element);
    const finishTyping = () => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && container.contains(active))
        active.blur();
    };
    let frameRequest = 0;
    const drawLive = () => {
      frameRequest = 0;
      const current = drag.current;
      if (current?.kind === 'stroke' && current.live)
        current.live.setAttribute('d', smoothPath(current.points));
    };
    const end = () => {
      drag.current = null;
      activePointer.current = null;
      activeType.current = null;
      setDragging(false);
    };

    const startStroke = (
      element: HTMLElement,
      frame: PageFrame,
      p: Point,
      kind: 'pen' | 'marker'
    ) => {
      const s = stateRef.current;
      const color = kind === 'marker' && s.color === BLACK ? YELLOW : s.color;
      const width = strokeWidth(kind, s.weight);
      const mark = {
        ...blankMark(kind, Number(element.dataset.page), color),
        width,
      };
      let joins: Mark | null = null;
      const last = lastPen.current;
      if (kind === 'pen' && last && performance.now() - last.at < GROUP_MS) {
        const candidate = s.savedMarks.find((row) => row.id === last.id);
        const box = candidate && markBox(candidate);
        if (
          candidate &&
          box &&
          candidate.page === mark.page &&
          candidate.color === color &&
          candidate.width === width &&
          p.x > box.x - GROUP_REACH &&
          p.x < box.x + box.width + GROUP_REACH &&
          p.y > box.y - GROUP_REACH &&
          p.y < box.y + box.height + GROUP_REACH
        )
          joins = candidate;
      }
      const live = element.querySelector<SVGPathElement>(
        'svg[data-pdf-marks] path[data-live]'
      );
      live?.setAttribute('stroke', color);
      live?.setAttribute('stroke-width', String(width));
      live?.setAttribute('stroke-linecap', kind === 'pen' ? 'round' : 'butt');
      live?.setAttribute('stroke-linejoin', 'round');
      live?.setAttribute('stroke-opacity', kind === 'marker' ? '0.42' : '1');
      live?.style.setProperty(
        'mix-blend-mode',
        kind === 'marker' ? 'multiply' : 'normal'
      );
      drag.current = { frame, joins, kind: 'stroke', live, mark, points: [p] };
      drawLive();
    };

    const down = (event: PointerEvent) => {
      const s = stateRef.current;
      if (!s.editable || !s.ready || event.button !== 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[data-pdf-bar], [data-handle], [data-pdf-bubble], textarea'
        )
      )
        return;
      const element = pageOf(event.target);
      if (!element || !container.contains(element)) return;
      if (event.pointerType === 'pen') penSeen.current = true;
      else if (
        event.pointerType === 'touch' &&
        penSeen.current &&
        s.tool !== 'select'
      )
        return;
      if (activePointer.current !== null) {
        if (event.pointerType !== 'pen' || activeType.current === 'pen') return;
        // The pen came down while a palm was drawing: the palm's drag goes.
        cancel();
      }
      const page = info(element);
      if (!page) return;
      const frame = pageFrame(element);
      const p = toPage(frame, event.clientX, event.clientY);
      setBands(null);
      finishTyping();
      if (s.commentFor) {
        setCommentFor(null);
        if (s.draft?.kind === 'note') setDraft(null);
      }
      const capture = () => {
        event.preventDefault();
        container.focus({ preventScroll: true });
        window.getSelection()?.removeAllRanges();
        activePointer.current = event.pointerId;
        activeType.current = event.pointerType;
        setDragging(true);
      };
      const pageMarks = s.marks.filter((mark) => mark.page === page.number);
      switch (s.tool) {
        case 'select': {
          const hit = topHit(pageMarks, p, HIT_PX * frame.scale);
          if (!hit) {
            // Native text selection goes on; its bar shows on release (D3).
            if (s.selectedIds.length) setSelectedIds([]);
            return;
          }
          capture();
          const onPage = s.selectedIds.filter((id) =>
            pageMarks.some((mark) => mark.id === id)
          );
          const ids = event.shiftKey
            ? onPage.includes(hit.id)
              ? onPage.filter((id) => id !== hit.id)
              : [...onPage, hit.id]
            : onPage.includes(hit.id)
              ? onPage
              : [hit.id];
          setSelectedIds(ids);
          drag.current = {
            frame,
            kind: 'move',
            marks: pageMarks.filter(
              (mark) => ids.includes(mark.id) && !onText(mark.kind)
            ),
            moved: false,
            open: hit.kind === 'note' && ids.length === 1 ? hit.id : undefined,
            start: p,
          };
          return;
        }
        case 'highlight':
          // On the text, the browser selects and the highlight lands on release.
          if (
            event.target instanceof HTMLElement &&
            event.target.tagName === 'SPAN' &&
            event.target.closest('.react-pdf__Page__textContent')
          )
            return;
          capture();
          startStroke(element, frame, p, 'marker');
          return;
        case 'pen':
          capture();
          startStroke(element, frame, p, 'pen');
          return;
        case 'eraser':
          capture();
          drag.current = { frame, kind: 'erase', last: p, page: page.number };
          move(event);
          return;
        case 'text': {
          capture();
          end();
          const size = TEXT_SIZES.m;
          const mark: Mark = {
            ...blankMark(
              'text',
              page.number,
              s.color === YELLOW ? BLACK : s.color
            ),
            rects: [
              {
                height: size * 1.25,
                width: Math.min(TEXT_WIDTH, page.width),
                x: Math.max(0, Math.min(p.x, page.width - TEXT_WIDTH)),
                y: Math.max(
                  0,
                  Math.min(p.y - size * 0.6, page.height - size * 1.25)
                ),
              },
            ],
            size,
          };
          // Placing text switches to Select; the box is typed in without a
          // frame and selected once Escape closes it (Epo 2026-11-24).
          setToolState('select');
          setDraft(mark);
          setTyping(true);
          setSelectedIds([]);
          return;
        }
        case 'note': {
          capture();
          end();
          const mark: Mark = {
            ...blankMark(
              'note',
              page.number,
              s.color === YELLOW ? PURPLE : s.color
            ),
            rects: [
              {
                height: NOTE_SIZE,
                width: NOTE_SIZE,
                x: Math.max(0, Math.min(p.x - 4, page.width - NOTE_SIZE)),
                y: Math.max(
                  0,
                  Math.min(p.y - NOTE_SIZE + 4, page.height - NOTE_SIZE)
                ),
              },
            ],
          };
          setToolState('select');
          setDraft(mark);
          setSelectedIds([mark.id]);
          setCommentFor(mark.id);
          return;
        }
        default: {
          capture();
          const mark: Mark = {
            ...blankMark(s.tool, page.number, s.color),
            rects:
              s.tool === 'arrow'
                ? []
                : [{ height: 0.5, width: 0.5, x: p.x, y: p.y }],
            strokes: s.tool === 'arrow' ? [[p, p]] : [],
            width: strokeWidth(s.tool, s.weight),
          };
          drag.current = { frame, kind: 'shape', mark, start: p };
          setPreview(new Map([[mark.id, mark]]));
        }
      }
    };

    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== activePointer.current) return;
      const p = toPage(current.frame, event.clientX, event.clientY);
      switch (current.kind) {
        case 'stroke': {
          // Every sample the browser coalesced into this event (PDF.js).
          const samples = event.getCoalescedEvents?.() ?? [];
          for (const sample of samples.length ? samples : [event]) {
            const q = toPage(current.frame, sample.clientX, sample.clientY);
            if (distance(q, current.points.at(-1) as Point) >= 0.6)
              current.points.push(q);
          }
          if (!frameRequest) frameRequest = requestAnimationFrame(drawLive);
          return;
        }
        case 'move': {
          const dx = p.x - current.start.x,
            dy = p.y - current.start.y;
          if (!current.moved && Math.hypot(dx, dy) < 2 * current.frame.scale)
            return;
          current.moved = true;
          setCommentFor(null);
          const [x, y] = clampShift(current.marks, dx, dy, current.frame);
          setPreview(
            new Map(
              current.marks.map((mark) => [mark.id, moveMark(mark, x, y)])
            )
          );
          return;
        }
        case 'resize':
          setPreview(
            new Map([
              [
                current.mark.id,
                resizeMark(current.mark, current.handle, p, current.frame),
              ],
            ])
          );
          return;
        case 'shape': {
          const { mark, start } = current;
          const next: Mark =
            mark.kind === 'arrow'
              ? { ...mark, strokes: [[start, p]] }
              : {
                  ...mark,
                  rects: [
                    {
                      height: Math.max(0.5, Math.abs(p.y - start.y)),
                      width: Math.max(0.5, Math.abs(p.x - start.x)),
                      x: Math.min(p.x, start.x),
                      y: Math.min(p.y, start.y),
                    },
                  ],
                };
          current.mark = next;
          setPreview(new Map([[next.id, next]]));
          return;
        }
        case 'erase': {
          // The marks as this drag has cut them so far, not as last drawn.
          const { savedMarks } = stateRef.current;
          const onPage = (
            previewRef.current
              ? applyChange(savedMarks, previewRef.current)
              : savedMarks
          ).filter((mark) => mark.page === current.page);
          const cut = eraseAlong(
            onPage,
            current.last,
            p,
            ERASER_PX * current.frame.scale
          );
          current.last = p;
          if (cut.size)
            setPreview(new Map([...(previewRef.current ?? []), ...cut]));
        }
      }
    };

    const up = (event: PointerEvent) => {
      const current = drag.current;
      if (current && event.pointerId === activePointer.current) {
        end();
        if (frameRequest) cancelAnimationFrame(frameRequest);
        frameRequest = 0;
        finish(current);
        return;
      }
      if (
        current ||
        !(event.target instanceof Node) ||
        !container.contains(event.target)
      )
        return;
      const s = stateRef.current;
      if (!s.editable || !(s.tool === 'highlight' || s.tool === 'select'))
        return;
      // The selection settles after the release.
      window.setTimeout(() => {
        const found = textSelectionBands(container);
        if (!found.length) return;
        if (stateRef.current.tool === 'select') setBands(found);
        else {
          addTextMarksRef.current(
            found,
            'highlight',
            stateRef.current.color === BLACK ? YELLOW : stateRef.current.color
          );
          window.getSelection()?.removeAllRanges();
        }
      }, 0);
    };

    const finish = (current: Drag) => {
      const s = stateRef.current;
      switch (current.kind) {
        case 'stroke': {
          current.live?.removeAttribute('d');
          let points = current.points;
          if (points.length === 1) {
            // A tap is a dot: two points half a unit apart, on the page.
            const [p] = points;
            const x = p.x + 0.5 <= current.frame.width ? p.x + 0.5 : p.x - 0.5;
            points = [p, { x, y: p.y }];
          }
          if (current.mark.kind === 'marker') points = straighten(points);
          const stroke = simplify(points, 0.25).map(roundPoint);
          const total = (mark: Mark) =>
            mark.strokes.reduce((n, item) => n + item.length, 0);
          const joins = current.joins;
          const mark =
            joins &&
            total(joins) + stroke.length <= MAX_POINTS &&
            joins.strokes.length < 512
              ? { ...joins, strokes: [...joins.strokes, stroke] }
              : { ...current.mark, strokes: [stroke.slice(0, MAX_POINTS)] };
          s.commit(new Map([[mark.id, mark]]));
          if (mark.kind === 'pen')
            lastPen.current = { at: performance.now(), id: mark.id };
          return;
        }
        case 'move':
        case 'resize':
        case 'erase': {
          if (current.kind === 'move' && !current.moved && current.open)
            setCommentFor(current.open);
          const last = previewRef.current;
          setPreview(null);
          if (!last?.size) return;
          const resized =
            current.kind === 'resize' ? last.get(current.mark.id) : null;
          // A text box's new width rewraps its text.
          if (resized?.kind === 'text')
            last.set(resized.id, fitTextRef.current(resized));
          s.commit(last);
          return;
        }
        case 'shape': {
          const { mark } = current;
          const box = markBox({ ...mark, width: 0 });
          const big =
            mark.kind === 'arrow'
              ? distance(mark.strokes[0][0], mark.strokes[0][1]) >= MIN_SHAPE
              : box.width >= MIN_SHAPE && box.height >= MIN_SHAPE;
          setPreview(null);
          if (!big) return;
          s.commit(new Map([[mark.id, mark]]));
          // A placed shape opens selected, its bar showing, and the tool
          // goes back to Select, as after text (Epo 2026-11-24).
          setToolState('select');
          setSelectedIds([mark.id]);
        }
      }
    };

    const cancel = () => {
      const current = drag.current;
      if (!current) return;
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      if (current.kind === 'stroke') current.live?.removeAttribute('d');
      end();
      setPreview(null);
    };
    const cancelPointer = (event: PointerEvent) => {
      if (event.pointerId === activePointer.current) cancel();
    };
    /** Double-clicking a text box with Select types in it again. */
    const retype = (event: MouseEvent) => {
      const s = stateRef.current;
      if (!s.editable || !s.ready || s.tool !== 'select') return;
      const element = pageOf(event.target);
      const page = element && info(element);
      if (!(element && page)) return;
      const frame = pageFrame(element);
      const hit = topHit(
        s.marks.filter((mark) => mark.page === page.number),
        toPage(frame, event.clientX, event.clientY),
        HIT_PX * frame.scale
      );
      if (hit?.kind !== 'text') return;
      event.preventDefault();
      setDraft(hit);
      setTyping(true);
      setSelectedIds([]);
    };

    const keydown = (event: KeyboardEvent) => {
      const s = stateRef.current;
      if (
        !s.editable ||
        !(event.target instanceof Element) ||
        !container.contains(event.target) ||
        event.target.closest('textarea, input, [contenteditable="true"]')
      )
        return;
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;
      if (mod && key === 'z') {
        event.preventDefault();
        (event.shiftKey ? s.redo : s.undo)();
        return;
      }
      if (mod && key === 'y') {
        event.preventDefault();
        s.redo();
        return;
      }
      if (mod || event.altKey) return;
      const chosen = s.marks.filter((mark) => s.selectedIds.includes(mark.id));
      if (key === 'escape') {
        if (s.bands) setBands(null);
        else if (s.selectedIds.length) setSelectedIds([]);
        else setTool('select');
        return;
      }
      if ((key === 'delete' || key === 'backspace') && chosen.length) {
        event.preventDefault();
        removeSelectedRef.current();
        return;
      }
      if (key.startsWith('arrow') && chosen.length) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 2;
        const movable = chosen.filter((mark) => !onText(mark.kind));
        const page = s.pages.find((row) => row.number === chosen[0].page);
        if (!(movable.length && page)) return;
        const [dx, dy] = clampShift(
          movable,
          key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0,
          key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0,
          page
        );
        if (dx || dy)
          change(movable.map((mark) => [mark.id, moveMark(mark, dx, dy)]));
        return;
      }
      const next = TOOL_KEYS[key];
      if (next) {
        event.preventDefault();
        setTool(next === 'shape' ? s.shape : next);
        return;
      }
      if (COLOR_KEY.test(key)) {
        const picked = MARK_COLORS[Number(key) - 1];
        setColor(picked);
        if (chosen.length) edit(chosen, (mark) => ({ ...mark, color: picked }));
      }
    };

    container.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancelPointer);
    container.addEventListener('dblclick', retype);
    container.addEventListener('keydown', keydown);
    window.addEventListener('blur', cancel);
    return () => {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      container.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancelPointer);
      container.removeEventListener('dblclick', retype);
      container.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', cancel);
    };
    // The handlers read the latest state through stateRef.
  }, [containerRef]);

  // Selected text goes when it collapses.
  useEffect(() => {
    if (!bands) return;
    const collapsedSelection = () => {
      if (window.getSelection()?.isCollapsed) setBands(null);
    };
    document.addEventListener('selectionchange', collapsedSelection);
    return () =>
      document.removeEventListener('selectionchange', collapsedSelection);
  }, [bands]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!editable) {
      setToolState('select');
      setSelectedIds([]);
      setBands(null);
      setDraft(null);
      setTyping(false);
    }
    container.style.cursor = editable
      ? tool === 'eraser'
        ? ERASER_CURSOR
        : tool === 'highlight' || tool === 'text'
          ? 'text'
          : tool === 'select'
            ? ''
            : 'crosshair'
      : '';
    // A finger or pen draws instead of scrolling the pages.
    container.style.touchAction = editable && tool !== 'select' ? 'none' : '';
    return () => {
      container.style.cursor = '';
      container.style.touchAction = '';
    };
  }, [containerRef, editable, tool]);

  function addTextMarks(
    found: readonly TextBand[],
    kind: 'highlight' | 'underline',
    color: string
  ) {
    const added = found.map((band) => ({
      ...blankMark(kind, band.page, color),
      rects: band.rects,
      text: band.text,
    }));
    change(added.map((mark) => [mark.id, mark]));
    return added;
  }
  const addTextMarksRef = useRef(addTextMarks);
  addTextMarksRef.current = addTextMarks;
  const removeSelectedRef = useRef(removeSelected);
  removeSelectedRef.current = removeSelected;
  function removeSelected() {
    const { draft: current, selectedIds: ids } = stateRef.current;
    if (current && ids.includes(current.id)) {
      setDraft(null);
      setTyping(false);
    }
    const saved = stateRef.current.savedMarks.filter((mark) =>
      ids.includes(mark.id)
    );
    if (saved.length) change(saved.map((mark) => [mark.id, null]));
    setSelectedIds([]);
    setCommentFor(null);
  }

  /** A text box's height fitted to its text as shown. */
  function fitText(mark: Mark): Mark {
    const page = stateRef.current.pages.find((row) => row.number === mark.page);
    const height = page && measureTextHeight(mark, page);
    if (!(page && height)) return mark;
    const rect = mark.rects[0];
    return {
      ...mark,
      rects: [
        {
          ...rect,
          height: Math.max(1, Math.min(height, page.height - rect.y)),
        },
      ],
    };
  }
  const fitTextRef = useRef(fitText);
  fitTextRef.current = fitText;

  /** The text box closes: an empty one goes, a changed one saves, and one
   * closed with Escape stays selected. */
  const onTextDone = useCallback(
    (kept: boolean) => {
      const { draft: current, savedMarks } = stateRef.current;
      setTyping(false);
      if (!current) return;
      setDraft(null);
      const before = savedMarks.find((mark) => mark.id === current.id);
      if (!current.text.trim()) {
        if (before) change([[current.id, null]]);
        return;
      }
      const next = normalizeMark(fitTextRef.current(current));
      if (JSON.stringify(before) !== JSON.stringify(next))
        change([[next.id, next]]);
      if (kept) setSelectedIds([next.id]);
    },
    [change]
  );
  const onTextChange = useCallback((text: string) => {
    setDraft((current) => (current ? { ...current, text } : current));
  }, []);

  /** Opens a mark from a list, the margin or its bubble. */
  const openMark = useCallback(
    (mark: Mark, comment: boolean) => {
      const page = stateRef.current.pages.find(
        (row) => row.number === mark.page
      );
      const scroller = containerRef.current?.parentElement;
      if (page && scroller) {
        const rect = page.element.getBoundingClientRect();
        const top =
          rect.top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop +
          (markBox(mark).y / page.height) * rect.height;
        if (
          top < scroller.scrollTop ||
          top > scroller.scrollTop + scroller.clientHeight - 80
        )
          scroller.scrollTo({
            behavior: 'smooth',
            top: top - scroller.clientHeight / 3,
          });
      }
      if (stateRef.current.editable) {
        setToolState('select');
        setSelectedIds([mark.id]);
      }
      setCommentFor(comment || mark.kind === 'note' ? mark.id : null);
    },
    [containerRef]
  );
  const onBubble = useCallback(
    (mark: Mark) => openMark(mark, true),
    [openMark]
  );

  const onHandle = useCallback(
    (event: React.PointerEvent, mark: Mark, handle: Handle) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const page = stateRef.current.pages.find(
        (row) => row.number === mark.page
      );
      if (!page) return;
      activePointer.current = event.pointerId;
      activeType.current = event.pointerType;
      setDragging(true);
      setCommentFor(null);
      drag.current = {
        frame: pageFrame(page.element),
        handle,
        kind: 'resize',
        mark,
      };
    },
    []
  );

  const commentMark = commentFor
    ? marks.find((mark) => mark.id === commentFor)
    : undefined;
  function saveComment(comment: string) {
    const mark = commentMark;
    setCommentFor(null);
    if (!mark) return;
    const isDraft =
      draft?.id === mark.id && !store.marks.some((row) => row.id === mark.id);
    if (mark.kind === 'note' && !comment) {
      // A note is its comment: an empty one goes.
      if (isDraft) setDraft(null);
      else change([[mark.id, null]]);
      setSelectedIds([]);
      return;
    }
    if (isDraft && mark.kind === 'note') {
      setDraft(null);
      change([[mark.id, { ...mark, comment }]]);
      return;
    }
    if (mark.comment !== comment) edit([mark], (row) => ({ ...row, comment }));
  }
  function closeComment() {
    if (commentMark?.kind === 'note' && draft?.id === commentMark.id) {
      setDraft(null);
      setSelectedIds([]);
    }
    setCommentFor(null);
  }

  const lone = selected.length === 1 ? selected[0] : null;
  const handles = useMemo(
    () =>
      lone && !dragging && !typing && markHandles(lone).length
        ? { handles: markHandles(lone), mark: lone }
        : null,
    [lone, dragging, typing]
  );
  const editingMark = typing && draft ? draft : null;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const barPage = !dragging && !bands ? selected[0]?.page : undefined;
  const bandsPage = bands?.[0]?.page;
  const commentPage = dragging ? undefined : commentMark?.page;

  return (
    <>
      {/* A member reading their feedback gets no tools, only the Marks list
          and the comments (mock B6H1Z7o4byVFBVyCRSUK3B). */}
      {toolbar &&
        !store.readOnly &&
        createPortal(
          <PdfAnnotationToolbar
            canRedo={store.canRedo}
            canUndo={store.canUndo}
            color={color}
            // Dimmed until the pages are in, so the row never sits empty.
            disabled={readOnly || !ready || !pages.length}
            onColor={(value) => {
              setColor(value);
              if (selected.length)
                edit(selected, (mark) => ({ ...mark, color: value }));
            }}
            onRedo={store.redo}
            onTool={setTool}
            onUndo={store.undo}
            onWeight={setWeight}
            shape={shape}
            tool={tool}
            weight={weight}
          />,
          toolbar
        )}
      {toolbarEnd &&
        createPortal(
          <MarksMenus
            collapsed={collapsed}
            margin={!!margin}
            marks={store.marks}
            onCollapse={setCollapsed}
            onOpen={openMark}
          />,
          toolbarEnd
        )}
      {margin &&
        createPortal(
          <CommentMargin
            collapsed={collapsed}
            layout={renderVersion}
            marks={store.marks}
            onOpen={(mark) => openMark(mark, true)}
            pages={pages}
            selected={selectedSet}
          />,
          margin
        )}
      {writeError &&
        strip &&
        createPortal(
          <FileBanner
            message={m.pdf_annotations_write_failed()}
            tone="error"
          />,
          strip
        )}
      {pages.map((page) =>
        createPortal(
          <PdfMarkLayer
            bubbles={!margin}
            editing={editingMark?.page === page.number ? editingMark : null}
            handles={handles?.mark.page === page.number ? handles : null}
            marks={byPage.get(page.number) ?? EMPTY_MARKS}
            onBubble={onBubble}
            onHandle={onHandle}
            onTextChange={onTextChange}
            onTextDone={onTextDone}
            page={page}
            selected={
              selected[0]?.page === page.number ? selected : EMPTY_MARKS
            }
          >
            {/* Children only where they show, so the other pages' layers skip. */}
            {barPage === page.number ||
            bandsPage === page.number ||
            commentPage === page.number ? (
              <>
                {barPage === page.number && (
                  <SelectionBar
                    box={unionBox(selected.map(markBox))}
                    marks={selected}
                    onColor={(value) =>
                      edit(selected, (mark) => ({ ...mark, color: value }))
                    }
                    onComment={() => lone && setCommentFor(lone.id)}
                    onDelete={removeSelected}
                    onUnderline={() =>
                      lone &&
                      edit([lone], (mark) => ({
                        ...mark,
                        kind:
                          mark.kind === 'underline' ? 'highlight' : 'underline',
                      }))
                    }
                    onWeight={(value) =>
                      edit(selected, (mark) =>
                        mark.kind === 'text'
                          ? fitText({ ...mark, size: TEXT_SIZES[value] })
                          : isStroked(mark.kind)
                            ? { ...mark, width: strokeWidth(mark.kind, value) }
                            : mark
                      )
                    }
                    page={page}
                  />
                )}
                {bandsPage === page.number && bands && (
                  <TextSelectionBar
                    box={unionBox(bands[0].rects)}
                    onComment={() => {
                      const [first] = addTextMarksRef.current(
                        bands,
                        'highlight',
                        color === BLACK ? YELLOW : color
                      );
                      window.getSelection()?.removeAllRanges();
                      setBands(null);
                      setSelectedIds([first.id]);
                      setCommentFor(first.id);
                    }}
                    onHighlight={(value) => {
                      addTextMarksRef.current(bands, 'highlight', value);
                      window.getSelection()?.removeAllRanges();
                      setBands(null);
                    }}
                    onUnderline={() => {
                      addTextMarksRef.current(
                        bands,
                        'underline',
                        color === YELLOW ? MARK_COLORS[1] : color
                      );
                      window.getSelection()?.removeAllRanges();
                      setBands(null);
                    }}
                    page={page}
                  />
                )}
                {commentMark && commentPage === page.number && (
                  <CommentEditor
                    key={commentMark.id}
                    mark={commentMark}
                    onClose={closeComment}
                    onSave={saveComment}
                    page={page}
                    readOnly={readOnly}
                  />
                )}
              </>
            ) : undefined}
          </PdfMarkLayer>,
          page.element,
          `annotations:${page.number}`
        )
      )}
    </>
  );
}

const EMPTY_MARKS: Mark[] = [];
