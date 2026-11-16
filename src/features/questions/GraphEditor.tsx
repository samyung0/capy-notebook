import type { MathfieldElement } from 'mathlive';
import { Collapsible } from 'radix-ui';
import {
  memo,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as limits from '@/api/limits.generated';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { CharCount } from '@/components/ui/Input';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { Switch } from '@/components/ui/Switch';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { ToolbarPopoverContent } from '@/components/ui/ToolbarPopover';
import { drawGraph, labelFont, wrapLabel } from '@/features/graph/draw';
import { attachGestures } from '@/features/graph/gestures';
import { LABEL_SIZE, type RowElement, type Vec } from '@/features/graph/model';
import { PAPER } from '@/features/graph/paper';
import {
  bboxOf,
  elementBounds,
  framed,
  panned,
  QUESTION_ZOOM,
  snapped,
  toPlane,
  toScreen,
  type View,
  viewOf,
  zoomedAt,
} from '@/features/graph/view';
import { FigurePreview } from '@/features/materials/staticViews';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { useTheme } from '@/theme/theme';
import {
  CommitField,
  Field,
  FieldInput,
  MenuItem,
  SelectField,
} from './editorFields';
import { type FigureBinding, useBoundFigure } from './figureBinding';
import { GraphRowField } from './GraphRowField';
import { GraphError, validateGraphRecipe } from './graph';
import {
  buildElements,
  displayNumber,
  type GraphRow,
  type ParsedRow,
  parseRow,
  pointLatex,
  RowError,
  type RowStyle,
  reconcileRows,
  rowsFromElements,
  styleKeys,
} from './graphSyntax';
import { graphWriter } from './graphWriter';
import { IssueIcon, IssueSummary } from './IssueViews';
import type { GraphBlock } from './types';

type ExpressionRow = Extract<GraphRow, { kind: 'expression' }>;
type Bbox = GraphBlock['board']['bbox'];

const elementType = (parsed: ParsedRow): RowElement['type'] =>
  parsed.kind === 'point'
    ? 'point'
    : parsed.kind === 'function'
      ? 'functiongraph'
      : parsed.command;

function parsedRow(latex: string, ascii: string) {
  if (!latex.trim()) return { error: undefined, parsed: undefined };
  try {
    return { error: undefined, parsed: parseRow(ascii) };
  } catch (error) {
    if (!(error instanceof RowError)) throw error;
    return { error: error.message, parsed: undefined };
  }
}

/** The rows with the elements they give and the rows that give none, built
 * once per change. */
const withElements = (rows: GraphRow[]) => ({ rows, ...buildElements(rows) });

const sameBox = (a: number[], b: number[]) =>
  a.every(
    (value, i) =>
      Math.abs(value - b[i]) <= 1e-9 * Math.max(1, Math.abs(a[0] - a[2]))
  );

/** Desmos-style graph editor: typed rows on the left, the live graph on the
 * right; phones stack the graph on top. The graph frames what every view draws.
 * It edits the graph where `binding` holds it (Epo 2026-11-16, live figures),
 * each change written as it is made: rows through `graphWriter`, the view
 * once a pan or zoom settles, the Advanced fields once typed in and left.
 * Rows stay here: a keystroke parses its row once and the canvas redraws on
 * the next frame; a co-editor's change reaches every row but one being typed. */
export const GraphEditor = memo(function GraphEditor({
  binding,
  descriptionMax,
  onInvalidChange,
  toolbarTarget,
}: {
  binding: FigureBinding;
  /** The description's bound: the bank's longer one or everyone else's. */
  descriptionMax: number;
  /** Rows that cannot be drawn (a note dialog holds its Save meanwhile). */
  onInvalidChange?: (invalid: boolean) => void;
  /** Where the zoom tools go instead of floating over the graph. */
  toolbarTarget?: HTMLElement | null;
}) {
  const { block } = useBoundFigure(binding);
  if (block.type !== 'graph') throw new Error('The graph editor needs a graph');
  const [state, setState] = useState(() =>
    withElements(rowsFromElements(block.elements))
  );
  const { rows, errors: rowErrors } = state;
  const current = useRef(state);
  current.current = state;
  // Rows whose element the graph check refused: not written, named here.
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const [writer] = useState(() =>
    graphWriter(binding, () => current.current.elements, setRefused)
  );
  // Closing the dialog writes what still waits for its frame.
  useEffect(() => () => writer.flush(), [writer]);
  // The figure's elements as they change (ours written back, or a
  // co-editor's): every row follows them but one still being typed.
  const [seen, setSeen] = useState(block.elements);
  if (block.elements !== seen) {
    setSeen(block.elements);
    const next = reconcileRows(
      rows,
      block.elements,
      new Map(state.elements.map((element) => [element.id, element])),
      writer.typing
    );
    if (next !== rows) setState(withElements(next));
  }
  // Size and bounds typed here that cannot be drawn: shown with their issue,
  // not written, until they can.
  const [pending, setPending] = useState<{
    bbox?: Bbox;
    height?: number;
    width?: number;
  }>({});
  const drawn = useMemo(
    (): GraphBlock => ({
      ...block,
      board: { ...block.board, bbox: pending.bbox ?? block.board.bbox },
      elements: state.elements,
      height: pending.height ?? block.height,
      width: pending.width ?? block.width,
    }),
    [block, pending, state.elements]
  );
  const shown = useRef(drawn);
  shown.current = drawn;
  const stage = useRef<StageHandle>(null);
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  // An empty graph starts in its first row.
  const [startKey] = useState(() => (rows.length ? undefined : draftKey));
  const fields = useRef(new Map<string, MathfieldElement>());
  // Fresh labels open with their text selected, ready to type over.
  const [freshLabel, setFreshLabel] = useState<string>();
  // Rows past the cap (two editors' rows merged) are not drawn for readers:
  // each says so until the graph is back within it.
  const errors = useMemo(() => {
    const over = rows.slice(limits.QUESTION_GRAPH_ELEMENTS_MAX);
    if (!(over.length || refused.size)) return rowErrors;
    const out = new Map([...refused, ...rowErrors]);
    for (const row of over)
      if (!out.has(row.key))
        out.set(
          row.key,
          m.question_ui_graph_elements_max({
            max: limits.QUESTION_GRAPH_ELEMENTS_MAX,
          })
        );
    return out;
  }, [refused, rowErrors, rows]);
  // Issues read like the question dialog's (Epo 2026-10-15): the first one
  // above the editor, a warning icon on each affected row and on Advanced.
  const advancedIssues = boardIssues(drawn);
  // Anything else the graph refuses still reads here: checked once a change.
  const recipeIssue = useMemo(() => {
    try {
      validateGraphRecipe(drawn);
      return null;
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      return error.message;
    }
  }, [drawn]);
  // Each row is one element: a full graph offers no new row.
  const full = rows.length >= limits.QUESTION_GRAPH_ELEMENTS_MAX;
  const order = [...rows.map((row) => row.key), ...(full ? [] : [draftKey])];
  const issues = [
    ...order.flatMap((key, index) => {
      const message = errors.get(key);
      return message
        ? [m.question_ui_graph_row_issue({ message, number: index + 1 })]
        : [];
    }),
    ...advancedIssues,
  ];
  if (!issues.length && recipeIssue) issues.push(recipeIssue);
  const invalid = issues.length > 0;
  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);
  useEffect(() => () => onInvalidChange?.(false), [onInvalidChange]);

  /** New rows: drawn on the next frame, `touched` rows written on it. Rows
   * this change left unable to draw (a point they name went or was renamed)
   * keep their text, unwritten, until they draw again. */
  const commit = (next: GraphRow[], touched: string[]) => {
    const before = current.current.elements;
    const built = withElements(next);
    current.current = built;
    setState(built);
    stage.current?.draw({ ...shown.current, elements: built.elements });
    const drawable = new Set(built.elements.map((element) => element.id));
    const keys = new Set(next.map((row) => row.key));
    writer.touch([
      ...touched,
      ...before.flatMap((element) =>
        keys.has(element.id) && !drawable.has(element.id) ? [element.id] : []
      ),
    ]);
  };
  const edit = (key: string, latex: string, ascii: string) => {
    const now = current.current.rows;
    const index = now.findIndex((row) => row.key === key);
    if (index < 0) {
      if (!latex.trim()) return;
      commit(
        [
          ...now,
          {
            key,
            kind: 'expression',
            latex,
            style: {},
            ...parsedRow(latex, ascii),
          },
        ],
        [key]
      );
      setDraftKey(crypto.randomUUID());
      return;
    }
    commit(
      now.map((row) =>
        row.key === key && row.kind === 'expression'
          ? { ...row, latex, ...parsedRow(latex, ascii) }
          : row
      ),
      [key]
    );
  };
  const restyle = (key: string, style: RowStyle) =>
    commit(
      current.current.rows.map((row) =>
        row.key === key && row.kind === 'expression' ? { ...row, style } : row
      ),
      [key]
    );
  const remove = (key: string) => {
    commit(
      current.current.rows.filter((row) => row.key !== key),
      []
    );
    writer.remove(key);
  };
  const focus = (key: string | undefined) => {
    if (key) fields.current.get(key)?.focus();
  };
  const neighbour = (key: string, step: 1 | -1) => {
    const keys = order.filter(
      (other) =>
        other === draftKey ||
        rows.find((row) => row.key === other)?.kind === 'expression'
    );
    return keys[keys.indexOf(key) + step];
  };

  const hooks: StageHooks = {
    onBoundingBox: (bbox) => {
      binding.setBoard('bbox', bbox);
      setPending(({ bbox: _, ...rest }) => rest);
    },
    onMove: (id, coords) =>
      commit(
        current.current.rows.map((row) => {
          if (row.key !== id) return row;
          if (row.kind === 'label') return { ...row, coords };
          if (row.kind !== 'expression' || row.parsed?.kind !== 'point')
            return row;
          return {
            ...row,
            latex: pointLatex(row.parsed.name, coords),
            parsed: { ...row.parsed, coords },
          };
        }),
        [id]
      ),
  };

  const { min: sizeMin, max: sizeMax } = {
    max: limits.QUESTION_GRAPH_DIMENSION_MAX,
    min: limits.QUESTION_GRAPH_DIMENSION_MIN,
  };
  /** A typed width or height: written once it can be drawn. */
  const commitSize = (key: 'width' | 'height', text: string) => {
    const size = typedNumber(text);
    if (Number.isInteger(size) && size >= sizeMin && size <= sizeMax) {
      binding.setFields(key === 'width' ? { width: size } : { height: size });
      setPending(({ [key]: _, ...rest }) => rest);
    } else setPending((now) => ({ ...now, [key]: size }));
  };
  /** A typed bound: the view written once its four bounds can be drawn. */
  const commitBound = (i: number, text: string) => {
    const bbox = [...(pending.bbox ?? block.board.bbox)] as Bbox;
    bbox[i] = typedNumber(text);
    const [left, top, right, bottom] = bbox;
    if (bbox.every(Number.isFinite) && left < right && bottom < top) {
      binding.setBoard('bbox', bbox);
      setPending(({ bbox: _, ...rest }) => rest);
    } else setPending((now) => ({ ...now, bbox }));
  };
  const shownChoices = [
    { label: m.question_ui_graph_shown(), value: 'shown' },
    { label: m.question_ui_graph_hidden(), value: 'hidden' },
  ];
  const bboxLabels = [
    m.question_ui_x_minimum(),
    m.question_ui_y_maximum(),
    m.question_ui_x_maximum(),
    m.question_ui_y_minimum(),
  ];

  return (
    <div className="@container min-w-0">
      <IssueSummary className="mb-4" messages={issues} />
      <div className="grid min-w-0 @3xl:grid-cols-[20rem_minmax(0,1fr)] items-start gap-7">
        <GraphStage
          drawable={advancedIssues.length === 0}
          graph={drawn}
          handle={stage}
          hooks={hooks}
          toolbarTarget={toolbarTarget}
        />
        <div className="@3xl:order-first flex min-w-0 flex-col gap-3.5">
          <ol className="border-divider border-t">
            {order.map((key, index) => {
              const row = rows.find((item) => item.key === key);
              // A free mark keeps its place with no row of its own yet.
              if (row?.kind === 'mark') return null;
              if (row?.kind === 'label')
                return (
                  <LabelRow
                    autoSelect={key === freshLabel}
                    error={errors.get(key)}
                    key={key}
                    onChange={(next) =>
                      commit(
                        current.current.rows.map((item) =>
                          item.key === key ? next : item
                        ),
                        [key]
                      )
                    }
                    onRemove={() => remove(key)}
                    row={row}
                  />
                );
              return (
                <ExpressionItem
                  autoFocus={key === startKey}
                  error={row ? errors.get(key) : undefined}
                  key={key}
                  label={m.question_ui_graph_expression({ number: index + 1 })}
                  onChange={(latex, ascii) => edit(key, latex, ascii)}
                  onEnter={() => focus(neighbour(key, 1))}
                  onMoveOut={(direction) =>
                    focus(neighbour(key, direction === 'up' ? -1 : 1))
                  }
                  onRemove={row ? () => remove(key) : undefined}
                  onRemoveEmpty={
                    row
                      ? () => {
                          focus(neighbour(key, -1) ?? neighbour(key, 1));
                          remove(key);
                        }
                      : undefined
                  }
                  onRestyle={(style) => restyle(key, style)}
                  register={(field) => {
                    if (field) fields.current.set(key, field);
                    else fields.current.delete(key);
                  }}
                  row={row}
                />
              );
            })}
          </ol>
          {/* Rows count like characters: the counter shows from 90%. */}
          <div className="-mt-1.5 flex items-center justify-between gap-2">
            <Button
              className="-ml-4"
              disabled={full}
              iconLeft="plus"
              onClick={() => {
                const [left, top, right, bottom] = drawn.board.bbox;
                const key = crypto.randomUUID();
                setFreshLabel(key);
                commit(
                  [
                    ...current.current.rows,
                    {
                      coords: [
                        Number(((left + right) / 2).toPrecision(12)),
                        Number(((top + bottom) / 2).toPrecision(12)),
                      ],
                      key,
                      kind: 'label',
                      text: m.question_ui_label(),
                    },
                  ],
                  [key]
                );
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.question_ui_graph_add_label()}
            </Button>
            <CharCount
              max={limits.QUESTION_GRAPH_ELEMENTS_MAX}
              value={rows.length}
            />
          </div>
          {/* Opens on its own when the graph already has a description. */}
          <Collapsible.Root defaultOpen={Boolean(block.description)}>
            <div className="flex items-center gap-1">
              <Collapsible.Trigger asChild>
                <Button
                  className="-ml-4 self-start"
                  iconLeft="chevronDown"
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {m.question_ui_advanced()}
                </Button>
              </Collapsible.Trigger>
              <IssueIcon messages={advancedIssues} />
            </div>
            {/* Nudged under the chevron's ink, like the chart dialog. */}
            <Collapsible.Content className="translate-x-0.5 space-y-3 pt-3">
              <div className="grid grid-cols-2 gap-3">
                {(['width', 'height'] as const).map((key) => (
                  <CommitField
                    key={key}
                    label={
                      key === 'width'
                        ? m.question_ui_graph_width()
                        : m.question_ui_graph_height()
                    }
                    max={sizeMax}
                    min={sizeMin}
                    onCommit={(text) => commitSize(key, text)}
                    type="number"
                    value={numberText(drawn[key])}
                  />
                ))}
                <SelectField
                  label={m.question_ui_axes()}
                  onChange={(next) =>
                    binding.setBoard('axis', next === 'shown')
                  }
                  options={shownChoices}
                  value={block.board.axis ? 'shown' : 'hidden'}
                />
                <SelectField
                  label={m.question_ui_grid()}
                  onChange={(next) =>
                    binding.setBoard('grid', next === 'shown')
                  }
                  options={shownChoices}
                  value={block.board.grid ? 'shown' : 'hidden'}
                />
                {[0, 2, 3, 1].map((i) => (
                  <CommitField
                    key={i}
                    label={bboxLabels[i]}
                    onCommit={(text) => commitBound(i, text)}
                    type="number"
                    // Enough digits to tell a zoomed-in minimum from its maximum.
                    value={numberText(drawn.board.bbox[i], 12)}
                  />
                ))}
              </div>
              <CommitField
                count={descriptionMax}
                label={m.question_ui_description()}
                maxLength={descriptionMax}
                onCommit={(description) => binding.setFields({ description })}
                value={block.description ?? ''}
              />
            </Collapsible.Content>
          </Collapsible.Root>
        </div>
      </div>
    </div>
  );
});

/** A typed number: an empty field is NaN, which the issues name. */
const typedNumber = (text: string) => (text.trim() ? Number(text) : Number.NaN);

/** A number as its field shows it; empty when it is not one. */
const numberText = (value: number, digits?: number) =>
  Number.isFinite(value)
    ? String(digits ? Number(value.toPrecision(digits)) : value)
    : '';

/** What keeps the Advanced fields from drawing. */
function boardIssues({ width, height, board }: GraphBlock) {
  const min = limits.QUESTION_GRAPH_DIMENSION_MIN;
  const max = limits.QUESTION_GRAPH_DIMENSION_MAX;
  const [left, top, right, bottom] = board.bbox;
  return [
    ...([width, height].every(
      (n) => Number.isInteger(n) && n >= min && n <= max
    )
      ? []
      : [m.question_ui_graph_size_invalid({ max, min })]),
    ...([left, top, right, bottom].every(Number.isFinite) &&
    left < right &&
    bottom < top
      ? []
      : [m.question_ui_graph_bounds_invalid()]),
  ];
}

type StageHandle = { draw: (graph: GraphBlock) => void };

type StageHooks = {
  /** The visible area once a pan or zoom settles. */
  onBoundingBox: (bbox: Bbox) => void;
  /** A dragged point or label, landed on the view's precision. */
  onMove: (id: string, coords: [number, number]) => void;
};

/** The point or label under a pixel, topmost first, with the pixel's offset
 * from its anchor. */
function grabbable(
  graph: GraphBlock,
  view: View,
  at: Vec,
  measure: (font: string, text: string) => number
) {
  for (const element of [...graph.elements].reverse()) {
    if (element.hidden) continue;
    if (element.type !== 'point' && element.type !== 'text') continue;
    const [x, y] = toScreen(view, element.coords);
    const offset: Vec = [x - at[0], y - at[1]];
    if (element.type === 'point') {
      if (Math.hypot(...offset) <= 10) return { element, offset };
      continue;
    }
    const size = element.size ?? LABEL_SIZE;
    const font = labelFont(size);
    const lines = wrapLabel(element.text, (line) => measure(font, line));
    const w = Math.max(...lines.map((line) => measure(font, line)));
    const h = lines.length * size * 1.2;
    if (Math.abs(offset[0]) <= w / 2 + 4 && Math.abs(offset[1]) <= h / 2 + 4)
      return { element, offset };
  }
  return null;
}

/** The live graph at its stored pixel size, scaled to the column and no
 * taller than the dialog leaves room for, so the dialog never scrolls for it.
 * It takes the canvas plane's gestures (Epo 2026-11-16): the wheel pans,
 * pinch and Ctrl/⌘-wheel zoom, and a drag on empty paper pans (no Select tool
 * here yet). */
function GraphStage({
  graph,
  drawable,
  handle,
  hooks,
  toolbarTarget,
}: {
  graph: GraphBlock;
  /** Its size and bounds can be drawn; otherwise the last picture stays. */
  drawable: boolean;
  handle: Ref<StageHandle>;
  hooks: StageHooks;
  toolbarTarget?: HTMLElement | null;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { isDark } = useTheme();
  const [scale, setScale] = useState(0);
  const [preview, setPreview] = useState<{ bbox: Bbox; open: boolean }>();
  const { width, height } = graph;
  // What frames and gestures read: the newest graph, view and drag.
  const live = useRef({
    drag: null as { coords: Vec; id: string } | null,
    frame: 0,
    // A pan, zoom or drag under way: a co-editor's view waits for it.
    gesture: false,
    graph,
    hooks,
    paper: PAPER.light,
    view: null as View | null,
  });
  live.current.hooks = hooks;
  const paint = () => {
    const now = live.current;
    now.frame = 0;
    const ctx = canvas.current?.getContext('2d');
    if (!(ctx && canvas.current && now.view)) return;
    const { drag } = now;
    const shown = drag
      ? {
          ...now.graph,
          elements: now.graph.elements.map((element) =>
            element.id === drag.id &&
            (element.type === 'point' || element.type === 'text')
              ? { ...element, coords: drag.coords }
              : element
          ),
        }
      : now.graph;
    const k = canvas.current.width / now.graph.width;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, now.graph.width, now.graph.height);
    drawGraph(
      ctx,
      { h: now.graph.height, w: now.graph.width, x: 0, y: 0 },
      now.view,
      shown,
      now.paper,
      redraw
    );
  };
  const redraw = () => {
    live.current.frame ||= requestAnimationFrame(paint);
  };
  /** The view as a bbox, to the dialog when it changed. */
  const report = () => {
    const { graph: now, view } = live.current;
    if (!view) return;
    const bbox = bboxOf(view, now.width, now.height);
    if (!sameBox(bbox, now.board.bbox)) live.current.hooks.onBoundingBox(bbox);
  };
  const zoomBy = (factor: number) => {
    const { graph: now, view } = live.current;
    if (!view) return;
    live.current.view = zoomedAt(
      view,
      factor,
      [now.width / 2, now.height / 2],
      QUESTION_ZOOM
    );
    redraw();
    report();
  };
  const fit = () => {
    const { graph: now, view } = live.current;
    if (!view) return;
    const box = elementBounds(now, bboxOf(view, now.width, now.height));
    if (!box) return;
    live.current.view = framed(box, view, now.width, now.height);
    redraw();
    report();
  };
  useImperativeHandle(handle, () => ({
    draw(next) {
      live.current.graph = next;
      redraw();
    },
  }));
  // A graph from the editor (a co-editor's, or ours rendered): drawn; bounds
  // typed or a co-editor's view (once our own gesture ends, which then writes
  // ours), a new size or the first drawable value set the view.
  const { bbox } = graph.board;
  useEffect(() => {
    live.current.graph = graph;
    if (!drawable) return;
    const { gesture, view } = live.current;
    if (!view || (!gesture && !sameBox(bboxOf(view, width, height), bbox)))
      live.current.view = viewOf(bbox, width, height);
    redraw();
  });
  useEffect(() => {
    live.current.paper = isDark ? PAPER.dark : PAPER.light;
    redraw();
  }, [isDark]);
  // The canvas's pixels follow its shown size and the screen's density.
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const density = window.devicePixelRatio * (scale || 1);
    target.width = Math.round(width * density);
    target.height = Math.round(height * density);
    redraw();
  }, [width, height, scale]);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const measurer = document.createElement('canvas').getContext('2d');
    if (!measurer) throw new Error('No canvas to measure graph labels');
    const measure = (font: string, text: string) => {
      measurer.font = font;
      return measurer.measureText(text).width;
    };
    const hit = (at: Vec) => {
      const { graph: now, view } = live.current;
      return view ? grabbable(now, view, at, measure) : null;
    };
    const detach = attachGestures(
      target,
      {
        dragPans: true,
        pan: (dx, dy) => {
          const { view } = live.current;
          if (!view) return;
          live.current.gesture = true;
          live.current.view = panned(view, dx, dy);
          redraw();
        },
        press: (at) => {
          const grabbed = hit(at);
          if (!grabbed) return null;
          const { element, offset } = grabbed;
          target.style.cursor = 'grabbing';
          live.current.gesture = true;
          return {
            end: () => {
              const { drag, view } = live.current;
              live.current.drag = null;
              live.current.gesture = false;
              target.style.cursor = '';
              if (!(drag && view)) return;
              const coords = snapped(view, drag.coords);
              if (
                coords[0] !== element.coords[0] ||
                coords[1] !== element.coords[1]
              )
                live.current.hooks.onMove(element.id, coords);
              redraw();
            },
            move: (to) => {
              const { view } = live.current;
              if (!view) return;
              live.current.drag = {
                coords: toPlane(view, [to[0] + offset[0], to[1] + offset[1]]),
                id: element.id,
              };
              redraw();
            },
          };
        },
        settle: () => {
          live.current.gesture = false;
          report();
        },
        zoom: (factor, at) => {
          const { view } = live.current;
          if (!view) return;
          live.current.gesture = true;
          live.current.view = zoomedAt(view, factor, at, QUESTION_ZOOM);
          redraw();
        },
      },
      () => target.getBoundingClientRect().width / live.current.graph.width
    );
    // Points and labels show they can be picked up.
    const hover = (event: PointerEvent) => {
      if (event.buttons) return;
      const rect = target.getBoundingClientRect();
      const k = rect.width / live.current.graph.width;
      target.style.cursor = hit([
        (event.clientX - rect.left) / k,
        (event.clientY - rect.top) / k,
      ])
        ? 'grab'
        : '';
    };
    target.addEventListener('pointermove', hover);
    return () => {
      detach();
      target.removeEventListener('pointermove', hover);
      cancelAnimationFrame(live.current.frame);
      live.current.frame = 0;
    };
  }, []);
  // The column's width or the wrapper's max-height, whichever binds first.
  const fitStage = () => {
    const target = wrapper.current;
    const column = target?.parentElement;
    if (!target || !column) return;
    const maxHeight = Number.parseFloat(getComputedStyle(target).maxHeight);
    const { graph: now } = live.current;
    setScale(Math.min(column.clientWidth / now.width, maxHeight / now.height));
  };
  useEffect(() => {
    const column = wrapper.current?.parentElement;
    if (!column) return;
    const observer = new ResizeObserver(fitStage);
    observer.observe(column);
    // The max-height follows the viewport's height, which the column's
    // width does not.
    window.addEventListener('resize', fitStage);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitStage);
    };
  }, []);
  // A new size refits; fitStage reads it from `live`.
  useEffect(fitStage, [width, height]);
  const tools = (
    <BlockToolbar
      className={cn(
        // In the heading row it is part of the page, not floating over it.
        toolbarTarget ? 'shadow-none!' : 'absolute top-2 right-2 z-10'
      )}
    >
      <ToolbarButton
        label={m.material_zoom_in()}
        onClick={() => zoomBy(1.5)}
        type="button"
      >
        <Icon name="zoomIn" />
      </ToolbarButton>
      <ToolbarButton
        label={m.material_zoom_out()}
        onClick={() => zoomBy(1 / 1.5)}
        type="button"
      >
        <Icon name="zoomOut" />
      </ToolbarButton>
      <ToolbarButton
        label={m.question_ui_graph_fit()}
        onClick={fit}
        type="button"
      >
        <Icon name="fitToScreen" />
      </ToolbarButton>
      <ToolbarButton
        label={m.material_fullscreen()}
        onClick={() => {
          const { graph: now, view } = live.current;
          if (!view) return;
          setPreview({ bbox: bboxOf(view, now.width, now.height), open: true });
        }}
        type="button"
      >
        <Icon name="maximize" />
      </ToolbarButton>
    </BlockToolbar>
  );
  return (
    <div className="min-w-0">
      <div
        // Room under the dialog's title, the block's heading and footer.
        className="relative mx-auto max-h-[calc(88dvh-15rem)] overflow-hidden"
        ref={wrapper}
        style={{
          aspectRatio: scale ? undefined : `${width} / ${height}`,
          height: scale ? height * scale : undefined,
          width: scale ? width * scale : '100%',
        }}
      >
        <canvas
          className="block origin-top-left touch-none"
          ref={canvas}
          style={{ height, transform: `scale(${scale || 1})`, width }}
        />
        {/* MediaFrame's toolbar, always shown, unless the dialog's heading
            row holds it. */}
        {!toolbarTarget && tools}
      </div>
      {toolbarTarget && createPortal(tools, toolbarTarget)}
      {/* The graph as shown, full screen like a note figure. */}
      {preview && (
        <FigurePreview
          block={{ ...graph, board: { ...graph.board, bbox: preview.bbox } }}
          onOpenChange={(open) => setPreview({ ...preview, open })}
          open={preview.open}
        />
      )}
    </div>
  );
}

function ExpressionItem({
  autoFocus,
  row,
  error,
  label,
  onChange,
  onEnter,
  onMoveOut,
  onRemove,
  onRemoveEmpty,
  onRestyle,
  register,
}: {
  autoFocus?: boolean;
  row: ExpressionRow | undefined;
  error: string | undefined;
  label: string;
  onChange: (latex: string, ascii: string) => void;
  onEnter: () => void;
  onMoveOut: (direction: 'up' | 'down') => void;
  onRemove?: () => void;
  onRemoveEmpty?: () => void;
  onRestyle: (style: RowStyle) => void;
  register: (field: MathfieldElement | null) => void;
}) {
  const type = row?.parsed && !error ? elementType(row.parsed) : undefined;
  return (
    <li
      className="group grid min-h-12 cursor-text grid-cols-[2rem_minmax(0,1fr)_1.75rem] items-center gap-2 border-divider border-b py-1 pl-1 focus-within:bg-tint-accent-1/25 focus-within:shadow-[inset_2px_0_0_var(--color-action-accent)]"
      onClick={(event) => {
        if (
          event.target === event.currentTarget ||
          (event.target as Element).closest('[data-row-field]')
        )
          (
            event.currentTarget.querySelector(
              'math-field'
            ) as HTMLElement | null
          )?.focus();
      }}
    >
      {error ? (
        <RowIssue message={error} />
      ) : type && row ? (
        <StyleMenu onChange={onRestyle} row={row} type={type} />
      ) : (
        <span />
      )}
      <span className="min-w-0" data-row-field>
        <GraphRowField
          autoFocus={autoFocus}
          label={label}
          latex={row?.latex ?? ''}
          onChange={onChange}
          onEnter={onEnter}
          onMoveOut={onMoveOut}
          onRemoveEmpty={onRemoveEmpty}
          register={register}
        />
      </span>
      {onRemove ? <RowMenu onRemove={onRemove} /> : <span />}
    </li>
  );
}

/** A row that cannot be drawn: the question dialog's warning icon. */
function RowIssue({ message }: { message: string }) {
  return (
    <span className="grid size-8 place-items-center">
      <IssueIcon messages={[message]} />
    </span>
  );
}

function RowMenu({ onRemove }: { onRemove: () => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ToolbarButton
          className="opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          label={m.question_ui_element_actions()}
          type="button"
        >
          <Icon name="moreVertical" />
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="end" className="w-44">
        <MenuItem label={m.question_ui_delete()} onClick={onRemove} />
      </ToolbarPopoverContent>
    </Popover>
  );
}

function StyleMenu({
  row,
  type,
  onChange,
}: {
  row: ExpressionRow;
  type: RowElement['type'];
  onChange: (style: RowStyle) => void;
}) {
  const keys = styleKeys(type);
  const { style } = row;
  const pointName = row.parsed?.kind === 'point' ? (row.parsed.name ?? '') : '';
  const label =
    type === 'point' ? (style.label ?? pointName) : (style.label ?? '');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ToolbarButton label={m.question_ui_graph_style()} type="button">
          <GraphGlyph style={style} type={type} />
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="start" className="w-60 space-y-3 p-3">
        {keys.includes('dash') && (
          <SelectField
            label={m.question_ui_graph_line_style()}
            onChange={(next) =>
              onChange({ ...style, dash: next === 'dashed' || undefined })
            }
            options={[
              { label: m.question_ui_graph_solid(), value: 'solid' },
              { label: m.question_ui_graph_dashed(), value: 'dashed' },
            ]}
            value={style.dash ? 'dashed' : 'solid'}
          />
        )}
        {keys.includes('ticks') && (
          <SelectField
            label={m.question_ui_graph_marks()}
            onChange={(next) =>
              onChange({ ...style, ticks: Number(next) || undefined })
            }
            options={[
              { label: m.question_ui_graph_none(), value: '0' },
              ...[1, 2, 3].map((n) => ({ label: String(n), value: String(n) })),
            ]}
            value={String(style.ticks ?? 0)}
          />
        )}
        {keys.includes('shade') && (
          <SelectField
            label={m.question_ui_graph_shading()}
            onChange={(next) =>
              onChange({ ...style, shade: next === 'shaded' || undefined })
            }
            options={[
              { label: m.question_ui_graph_none(), value: 'none' },
              { label: m.question_ui_graph_shaded(), value: 'shaded' },
            ]}
            value={style.shade ? 'shaded' : 'none'}
          />
        )}
        {(type === 'point' || type === 'angle') && (
          <Field
            count={{
              max: limits.QUESTION_GRAPH_NAME_MAX,
              value: textLength(label),
            }}
            label={m.question_ui_label()}
          >
            <FieldInput
              maxLength={limits.QUESTION_GRAPH_NAME_MAX}
              onChange={(event) => {
                const next = event.target.value;
                onChange({
                  ...style,
                  label:
                    type === 'point' && next === pointName ? undefined : next,
                });
              }}
              value={label}
            />
          </Field>
        )}
        <HideSwitch
          checked={Boolean(style.hidden)}
          onChange={(hidden) =>
            onChange({ ...style, hidden: hidden || undefined })
          }
        />
      </ToolbarPopoverContent>
    </Popover>
  );
}

function HideSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="t-label">{m.question_ui_hide()}</span>
      <Switch checked={checked} onCheckedChange={onChange} size="sm" />
    </label>
  );
}

function LabelRow({
  autoSelect,
  row,
  error,
  onChange,
  onRemove,
}: {
  autoSelect: boolean;
  row: Extract<GraphRow, { kind: 'label' }>;
  error: string | undefined;
  onChange: (row: Extract<GraphRow, { kind: 'label' }>) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoSelect) return;
    input.current?.focus();
    input.current?.select();
  }, [autoSelect]);
  return (
    <li
      className="group grid min-h-12 cursor-text grid-cols-[2rem_minmax(0,1fr)_1.75rem] items-center gap-2 border-divider border-b py-1 pl-1 focus-within:bg-tint-accent-1/25 focus-within:shadow-[inset_2px_0_0_var(--color-action-accent)]"
      onClick={(event) => {
        if (
          event.target === event.currentTarget ||
          (event.target as Element).closest('[data-row-field]')
        )
          (
            event.currentTarget.querySelector(
              'math-field'
            ) as HTMLElement | null
          )?.focus();
      }}
    >
      {error ? (
        <RowIssue message={error} />
      ) : (
        <Popover>
          <PopoverTrigger asChild>
            <ToolbarButton label={m.question_ui_graph_style()} type="button">
              <GraphGlyph style={{ hidden: row.hidden }} type="text" />
            </ToolbarButton>
          </PopoverTrigger>
          <ToolbarPopoverContent align="start" className="w-60 p-3">
            <HideSwitch
              checked={Boolean(row.hidden)}
              onChange={(hidden) =>
                onChange({ ...row, hidden: hidden || undefined })
              }
            />
          </ToolbarPopoverContent>
        </Popover>
      )}
      <span className="flex min-w-0 items-baseline gap-2">
        <FieldInput
          aria-label={m.question_ui_label()}
          maxLength={limits.QUESTION_GRAPH_LABEL_MAX}
          onChange={(event) => onChange({ ...row, text: event.target.value })}
          ref={input}
          value={row.text}
          variant="transparent"
          wrapperClassName="min-w-0 flex-1"
        />
        <CharCount
          max={limits.QUESTION_GRAPH_LABEL_MAX}
          value={textLength(row.text)}
        />
        <span className="shrink-0 text-fg-muted text-sm">
          {m.question_ui_graph_label_at({
            x: displayNumber(row.coords[0]),
            y: displayNumber(row.coords[1]),
          })}
        </span>
      </span>
      <RowMenu onRemove={onRemove} />
    </li>
  );
}

/** What a row draws, in the export's ink; dashed or shaded when styled so. */
function GraphGlyph({
  type,
  style,
}: {
  type: RowElement['type'];
  style: RowStyle;
}) {
  const dash = style.dash ? '3.5 3' : undefined;
  const shade = style.shade ? 0.18 : 0;
  const paths: Record<RowElement['type'], React.ReactNode> = {
    angle: (
      <>
        <path d="M18 17H3L14 4" fill="none" />
        <path d="M9 17a5 5 0 0 0-1.6-3.6" fill="none" strokeWidth={1.5} />
      </>
    ),
    arc: <path d="M4 15a7 7 0 0 1 12 0" fill="none" strokeDasharray={dash} />,
    circle: <circle cx="10" cy="10" fill="none" r="7" strokeDasharray={dash} />,
    functiongraph: (
      <path
        d="M2 17C6 17 7 3 10 3s4 14 8 14"
        fill="none"
        strokeDasharray={dash}
      />
    ),
    line: <path d="M2 18 18 2" strokeDasharray={dash} />,
    point: <circle cx="10" cy="10" fill="currentColor" r="4" stroke="none" />,
    polygon: (
      <path
        d="M10 3 18 17H2z"
        fillOpacity={shade}
        strokeDasharray={dash}
        strokeWidth={1.5}
      />
    ),
    sector: (
      <path
        d="M10 15 3 8a10 10 0 0 1 14 0z"
        fillOpacity={shade}
        strokeDasharray={dash}
        strokeWidth={1.5}
      />
    ),
    segment: (
      <>
        <path d="M3 17 17 3" strokeDasharray={dash} />
        {Array.from({ length: style.ticks ?? 0 }, (_, i) => (
          <path
            d={`M${6 + i * 2.5} ${8 - i * 2.5}l5 5`}
            key={i}
            strokeWidth={1.5}
          />
        ))}
      </>
    ),
    text: (
      <text
        fill="currentColor"
        fontSize="12"
        fontWeight="700"
        stroke="none"
        textAnchor="middle"
        x="10"
        y="14.5"
      >
        Aa
      </text>
    ),
  };
  return (
    <svg
      aria-hidden
      className={cn('size-5', style.hidden && 'opacity-35')}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 20 20"
    >
      {paths[type]}
    </svg>
  );
}
