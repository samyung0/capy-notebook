import type { MathfieldElement } from 'mathlive';
import { Collapsible } from 'radix-ui';
import {
  memo,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import * as limits from '@/api/limits.generated';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { useIsPhone } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { CharCount } from '@/components/ui/Input';
import {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { Switch } from '@/components/ui/Switch';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverItem,
} from '@/components/ui/ToolbarPopover';
import { EraserTrail } from '@/features/blocksuite/boardEraser';
import type { UndoTarget } from '@/features/collaboration/undo';
import { drawGraph } from '@/features/graph/draw';
import { fitPressed, fitWindow } from '@/features/graph/fit';
import { drawing, KATEX_OPTIONS, loadKatex } from '@/features/graph/formula';
import { attachGestures } from '@/features/graph/gestures';
import {
  type FreeMark,
  type GraphElement,
  LABEL_SIZE,
  type RowElement,
  type Vec,
} from '@/features/graph/model';
import { PAPER } from '@/features/graph/paper';
import { toolIcon } from '@/features/graph/toolIcons';
import {
  type GraphTools,
  graphTools,
  kindOf,
  SYMBOLS,
  symbolLabel,
  toolsFor,
} from '@/features/graph/tools';
import {
  bboxOf,
  framed,
  PLANE_ZOOM,
  panned,
  QUESTION_ZOOM,
  revealed,
  toPlane,
  toScreen,
  type View,
  zoomedAt,
} from '@/features/graph/view';
import { FigurePreview } from '@/features/materials/staticViews';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { useTheme } from '@/theme/theme';
import { CommitField, Field, FieldInput, SelectField } from './editorFields';
import { type FigureBinding, useBoundFigure } from './figureBinding';
import { GraphRowField } from './GraphRowField';
import { GraphError, graphFull, validateGraphRecipe } from './graph';
import {
  buildElements,
  type GraphRow,
  markRow,
  type ParsedRow,
  parsedKind,
  type RowStyle,
  readRow,
  reconcileRows,
  rowsAfterEdit,
  rowsFromElements,
  styleKeys,
  typedLine,
} from './graphSyntax';
import { graphWriter } from './graphWriter';
import { IssueIcon, IssueSummary } from './IssueViews';
import type { GraphBlock } from './types';

type ExpressionRow = Extract<GraphRow, { kind: 'expression' }>;
type Bbox = GraphBlock['board']['bbox'];

const elementType = (parsed: ParsedRow): RowElement['type'] =>
  parsed.kind === 'point'
    ? 'point'
    : parsed.kind === 'expression'
      ? 'expression'
      : parsed.command;

/** The rows with the elements they give and the rows that give none, built
 * once per change. */
const withElements = (rows: GraphRow[]) => ({ rows, ...buildElements(rows) });

const noSubscribe = () => () => undefined;
/** Fit's least span, in units, across and up (Epo 2026-11-13). */
const FIT_SPAN = 10;

/** Fit to size on leaving (Epo 2026-11-18): the figure keeps its size and
 * the window takes in its marks, labels and functions (`fitWindow`). */
function fitFigure(binding: FigureBinding) {
  const figure = binding.read()?.block;
  if (figure?.type !== 'graph') return;
  const bbox = fitWindow(figure.elements, figure, figure.board.bbox, {
    max: limits.QUESTION_GRAPH_DIMENSION_MAX,
    minH: limits.QUESTION_GRAPH_DIMENSION_MIN,
    minW: limits.QUESTION_GRAPH_DIMENSION_MIN,
  });
  if (!bbox) return;
  binding.setBoard(
    'bbox',
    bbox.map((value) => Number(value.toPrecision(12))) as typeof bbox
  );
}

/** The rows' list open or shut, as last chosen this session. */
let listChoice: boolean | null = null;

const sameBox = (a: number[], b: number[]) =>
  a.every(
    (value, i) =>
      Math.abs(value - b[i]) <= 1e-9 * Math.max(1, Math.abs(a[0] - a[2]))
  );

/** A canvas plane card edited in the graph editor (`PlaneEditing`): it has
 * no frame, so the plane fills the editor's room, and the board keeps its
 * camera and its undo history. */
export type PlaneMode = {
  camera: Camera;
  /** The camera after each pan or zoom, for the board to write on leaving. */
  onCamera: (camera: Camera) => void;
  history: UndoTarget;
  /** The rows' list: workspace canvases only (Epo 2026-11-13, L2). */
  list: boolean;
  /** Set by the editor: writes what it holds (a row typed, a label, an open
   * mark, the camera), for the host to run before the board closes. */
  leaving: { current: (() => void) | null };
};
type Camera = { centre: Vec; ppu: number };

/** The one graph editor (Epo 2026-11-17), for quiz and note graphs and the
 * canvas's plane cards, laid out as the plane's always was: the graph as
 * large as the dialog lets it be, its rows in a list floating over the top
 * left (a sheet over the lower half on a phone), the tools along the foot, a
 * ☰ menu and Done at the top right. A figure's frame (its size and the view
 * readers see) is scaled into the room the list, corners and tools leave; a
 * plane (`plane`) fills that room. It edits the graph where `binding` holds
 * it (Epo 2026-11-16, live figures), each change written as it is made: rows
 * through `graphWriter`, a figure's view once a pan or zoom settles, the
 * Advanced fields once typed in and left. Rows stay here: a keystroke parses
 * its row once and the canvas redraws on the next frame; a co-editor's change
 * reaches every row but one being typed. */
export const GraphEditor = memo(function GraphEditor({
  binding,
  descriptionMax,
  onDone,
  onRemove,
  plane,
}: {
  binding: FigureBinding;
  /** A figure's description bound: the bank's longer one or everyone else's. */
  descriptionMax?: number;
  onDone: () => void;
  /** Takes a figure out of where it lives. */
  onRemove?: () => void;
  plane?: PlaneMode;
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
  // Every row edits and saves, however many the figure holds (every reader
  // keeps up to twice the cap); nothing is added at the cap (`graphFull`,
  // here and in the writer).
  const [writer] = useState(() =>
    graphWriter(
      binding,
      () => ({
        elements: current.current.elements,
        keys: current.current.rows.map((row) => row.key),
      }),
      setRefused
    )
  );
  // What this session did, for Fit to size on leaving: it fits once a mark or
  // the view changed, unless a size or bounds were typed in Advanced (the
  // figure's Custom size, as a plane card's corner drag is).
  const session = useRef({ changed: false, typed: false });
  // Closing the dialog writes what still waits for its frame, then fits.
  useEffect(
    () => () => {
      writer.flush();
      // After the fields' and the stage's own cleanups: a field or label
      // still typed in commits as it goes, and is written before the fit.
      queueMicrotask(() => {
        writer.flush();
        writer.dispose();
        if (!plane && session.current.changed && !session.current.typed)
          fitFigure(binding);
      });
    },
    [binding, plane, writer]
  );
  // A plane's host runs this before the board closes it, while its steps are
  // still the editor's.
  useEffect(() => {
    if (!plane) return;
    plane.leaving.current = () => {
      stage.current?.leave();
      writer.flush();
    };
    return () => {
      plane.leaving.current = null;
    };
  }, [plane, writer]);
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
  // Shift or ⌘/Ctrl held on the press that focuses a row's field.
  const additive = useRef(false);
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  // The rows' list, as the plane's: open on wider screens, shut on phones,
  // until one is chosen this session.
  const phone = useIsPhone();
  const hasList = plane?.list ?? true;
  const [listOpen, setListOpen] = useState(
    () => hasList && (listChoice ?? !phone)
  );
  // An empty graph starts in its first row, once: the list mounts its rows
  // again each time it opens, and a phone's starts shut.
  const [startKey, setStartKey] = useState(() =>
    rows.length || !listOpen ? undefined : draftKey
  );
  useEffect(() => setStartKey(undefined), []);
  const fields = useRef(new Map<string, MathfieldElement>());
  // Fresh labels open with their text selected, ready to type over.
  const [freshLabel, setFreshLabel] = useState<string>();
  // The tools' selection, which the rows light, as it changes.
  const [, setToolsSeen] = useState(0);
  // A tool turned away at the cap: the cap's issue shows while it is full.
  const [capped, setCapped] = useState(false);
  const errors = useMemo(
    () => (refused.size ? new Map([...refused, ...rowErrors]) : rowErrors),
    [refused, rowErrors]
  );
  // Issues read like the question dialog's (Epo 2026-10-15): the first one
  // above the editor, a warning icon on each affected row and on Advanced.
  const advancedIssues = plane ? [] : boardIssues(drawn);
  // Anything else the graph refuses still reads here: checked once a change.
  const recipeIssue = useMemo(() => {
    try {
      validateGraphRecipe(
        plane
          ? // A plane has no stored size to bound: its elements are checked.
            {
              ...drawn,
              height: limits.QUESTION_GRAPH_DIMENSION_MIN,
              width: limits.QUESTION_GRAPH_DIMENSION_MIN,
            }
          : drawn
      );
      return null;
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      return error.message;
    }
  }, [drawn, plane]);
  // Each row is one element: a full graph offers no new row.
  const full = graphFull(rows.length);
  if (capped && !full) setCapped(false);
  const order = [...rows.map((row) => row.key), ...(full ? [] : [draftKey])];
  const issues = [
    ...(capped
      ? [
          m.question_ui_graph_elements_max({
            max: limits.QUESTION_GRAPH_ELEMENTS_MAX,
          }),
        ]
      : []),
    // A row's own trouble shows on its icon only (Epo 2026-11-18, "never show
    // the error row").
    ...advancedIssues,
  ];
  if (!issues.length && recipeIssue) issues.push(recipeIssue);

  /** New rows: drawn on the next frame, `touched` rows written on it. Rows
   * this change left unable to draw (a point they name went or was renamed)
   * keep their text, unwritten, until they draw again. */
  const commit = (next: GraphRow[], touched: string[]) => {
    const before = current.current.elements;
    session.current.changed = true;
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
  const edit = (key: string, latex: string) => {
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
            ...readRow(latex),
          },
        ],
        [key]
      );
      stage.current?.reveal(key);
      setDraftKey(crypto.randomUUID());
      return;
    }
    commit(
      now.map((row) =>
        row.key === key && row.kind === 'expression'
          ? { ...row, latex, ...readRow(latex) }
          : row
      ),
      [key]
    );
    // A function typed off the view brings the view to it (Epo 2026-11-18).
    stage.current?.reveal(key);
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
    full: () => graphFull(current.current.rows.length),
    onBoundingBox: (bbox) => {
      session.current.changed = true;
      binding.setBoard('bbox', bbox);
      setPending(({ bbox: _, ...rest }) => rest);
    },
    // Rows show what the tools selected.
    onToolsChange: () => setToolsSeen((n) => n + 1),
    // A tool's change goes through the rows, as typing does: each changed or
    // new element written on the next frame, a gone one at once.
    onWrite: (next) => {
      const now = current.current;
      const before = new Map(
        now.elements.map((element) => [element.id, element])
      );
      const kept = new Set(next.map((element) => element.id));
      commit(
        rowsAfterEdit(now.rows, now.elements, next),
        next.flatMap((element) =>
          before.get(element.id) === element ? [] : [element.id]
        )
      );
      for (const id of before.keys()) if (!kept.has(id)) writer.remove(id);
    },
    refused: () => setCapped(true),
  };

  const { min: sizeMin, max: sizeMax } = {
    max: limits.QUESTION_GRAPH_DIMENSION_MAX,
    min: limits.QUESTION_GRAPH_DIMENSION_MIN,
  };
  /** A typed width or height: written once it can be drawn. */
  const commitSize = (key: 'width' | 'height', text: string) => {
    session.current.typed = true;
    const size = typedNumber(text);
    if (Number.isInteger(size) && size >= sizeMin && size <= sizeMax) {
      binding.setFields(key === 'width' ? { width: size } : { height: size });
      setPending(({ [key]: _, ...rest }) => rest);
    } else setPending((now) => ({ ...now, [key]: size }));
  };
  /** A typed bound: the view written once its four bounds can be drawn. */
  const commitBound = (i: number, text: string) => {
    session.current.typed = true;
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

  const list = listOpen ? (phone ? 'sheet' : 'floating') : '';
  return (
    <div className="relative size-full overflow-hidden">
      <GraphStage
        drawable={advancedIssues.length === 0}
        graph={drawn}
        handle={stage}
        hooks={hooks}
        list={list}
        onClear={
          // Clear all where the history can take it back (Epo 2026-11-13).
          plane
            ? () => {
                const keys = current.current.rows.map((row) => row.key);
                commit([], []);
                for (const key of keys) writer.remove(key);
              }
            : undefined
        }
        onDone={onDone}
        onRemove={onRemove}
        plane={plane}
      />
      {hasList && (
        <button
          aria-label={m.drawing_board_objects()}
          aria-pressed={listOpen}
          className={cn(
            'absolute top-2 left-2 z-20 grid size-10 place-items-center rounded-(--radius-toolbar) border border-overlay-line bg-overlay text-fg-muted hover:bg-overlay-hover focus-visible:outline-2 focus-visible:outline-action-accent',
            listOpen && 'bg-overlay-hover text-action-accent'
          )}
          onClick={() => {
            listChoice = !listOpen;
            setListOpen(listChoice);
          }}
          type="button"
        >
          <Icon name="list" />
          {/* What keeps the graph from saving, while its list is shut. */}
          {!listOpen && issues.length > 0 && (
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-solid-error" />
          )}
        </button>
      )}
      {list && (
        <div
          className={cn(
            'absolute z-20 flex flex-col overflow-hidden border-overlay-line bg-overlay text-fg shadow-pop',
            list === 'floating'
              ? 'top-14 left-2 max-h-[calc(100%-8rem)] w-[300px] rounded-(--radius-toolbar) border'
              : 'inset-x-0 bottom-0 h-[48%] rounded-t-xl border-t'
          )}
        >
          {/* The plane's list (Epo 2026-11-13, L2): 36 px rows, then + Label;
              Advanced and what keeps the graph from saving are the figure's
              more. */}
          <div className="flex min-h-0 flex-col overflow-y-auto">
            <IssueSummary className="px-3 pt-3 pb-1" messages={issues} />
            <ol
              // Chrome reads Shift-click as stretching the focused field's
              // text, so focus stays put; move it to the clicked row instead.
              onMouseDownCapture={(event) => {
                if (!event.shiftKey) return;
                const target = event.target as Element;
                const row = target.closest('li');
                if (
                  !row ||
                  (target !== row &&
                    !target.closest(
                      '[data-row-field],[data-row-icon],math-field,input'
                    ))
                )
                  return;
                const field =
                  row.querySelector<HTMLElement>('math-field, input');
                if (!field || field.contains(document.activeElement)) return;
                event.preventDefault();
                field.focus();
              }}
              // The modifier only counts for the focus this press brings (on
              // press, or on click for the icon); the click or a key ends it.
              onPointerDownCapture={(event) => {
                additive.current =
                  event.shiftKey || event.metaKey || event.ctrlKey;
                if (!additive.current) return;
                const end = (next: Event) => {
                  if (
                    next instanceof KeyboardEvent &&
                    ['Control', 'Meta', 'Shift'].includes(next.key)
                  )
                    return;
                  additive.current = false;
                  window.removeEventListener('click', end);
                  window.removeEventListener('keydown', end, true);
                };
                window.addEventListener('click', end);
                window.addEventListener('keydown', end, true);
              }}
              onPointerLeave={() => stage.current?.setHot(null)}
            >
              {order.map((key, index) => {
                const row = rows.find((item) => item.key === key);
                // A row lights its element on the graph, and the graph's
                // selection lights its rows.
                const lit = {
                  // A row's field focused picks as a click on the graph does
                  // (Epo 2026-11-18): a label row its label, any other row
                  // nothing; Shift or ⌘/Ctrl adds to what is picked.
                  onFieldFocus: () => {
                    const add = additive.current;
                    additive.current = false;
                    if (row?.kind === 'label') stage.current?.select(key, add);
                    else if (!add) stage.current?.select(null);
                  },
                  onHover: () => stage.current?.setHot(row ? key : null),
                  selected: Boolean(row && stage.current?.selected(key)),
                };
                if (row?.kind === 'mark')
                  return (
                    <MarkRow
                      error={errors.get(key)}
                      key={key}
                      label={m.question_ui_graph_expression({
                        number: index + 1,
                      })}
                      onChange={(element) =>
                        commit(
                          current.current.rows.map((item) =>
                            item.key === key ? { ...row, element } : item
                          ),
                          [key]
                        )
                      }
                      onRemove={() => remove(key)}
                      row={row}
                      {...lit}
                    />
                  );
                if (row?.kind === 'label')
                  return (
                    <LabelRow
                      {...lit}
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
                    {...lit}
                    autoFocus={key === startKey}
                    error={row ? errors.get(key) : undefined}
                    key={key}
                    label={m.question_ui_graph_expression({
                      number: index + 1,
                    })}
                    onChange={(latex) => edit(key, latex)}
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
            <div className="flex shrink-0 items-center justify-between gap-2 pr-3">
              <button
                className="flex h-9 flex-1 items-center gap-[9px] pr-2.5 pl-[9px] font-semibold text-[13px] text-fg hover:bg-surface-hover-bg disabled:opacity-40 [&_svg]:size-[18px]"
                disabled={full}
                onClick={() => {
                  const [x, y] = stage.current?.centre() ?? [0, 0];
                  const key = crypto.randomUUID();
                  setFreshLabel(key);
                  commit(
                    [
                      ...current.current.rows,
                      {
                        coords: [
                          Number(x.toPrecision(12)),
                          Number(y.toPrecision(12)),
                        ],
                        key,
                        kind: 'label',
                        text: m.question_ui_label(),
                      },
                    ],
                    [key]
                  );
                }}
                type="button"
              >
                <Icon name="plus" />
                {m.drawing_board_plane_label()}
              </button>
              <CharCount
                max={limits.QUESTION_GRAPH_ELEMENTS_MAX}
                value={rows.length}
              />
            </div>
            {/* Opens on its own when the graph already has a description. */}
            <Collapsible.Root
              className="border-divider border-t"
              defaultOpen={Boolean(block.description)}
            >
              {/* A row like + Label above it: its icon, size and weight
                  (Epo 2026-11-18). */}
              <div className="flex items-center gap-1 pr-3">
                <Collapsible.Trigger asChild>
                  <button
                    className="flex h-9 flex-1 items-center gap-[9px] pr-2.5 pl-[9px] font-semibold text-[13px] text-fg hover:bg-surface-hover-bg [&_svg]:size-[18px]"
                    type="button"
                  >
                    <Icon name="chevronDown" />
                    {m.question_ui_advanced()}
                  </button>
                </Collapsible.Trigger>
                <IssueIcon messages={advancedIssues} />
              </div>
              <Collapsible.Content className="space-y-3 px-3 pt-2 pb-3.5">
                <div className="grid grid-cols-2 gap-3">
                  {/* A plane has no frame: its paper alone. */}
                  {!plane && (
                    <>
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
                    </>
                  )}
                  {/* Rings and spokes, as the canvas's polar plane has them. */}
                  <SelectField
                    label={m.question_ui_graph_paper()}
                    onChange={(next) =>
                      binding.setBoard('polar', next === 'polar' || undefined)
                    }
                    options={[
                      {
                        label: m.question_ui_graph_paper_square(),
                        value: 'square',
                      },
                      {
                        label: m.question_ui_graph_paper_polar(),
                        value: 'polar',
                      },
                    ]}
                    value={block.board.polar ? 'polar' : 'square'}
                  />
                </div>
                {descriptionMax !== undefined && (
                  <CommitField
                    count={descriptionMax}
                    label={m.question_ui_description()}
                    maxLength={descriptionMax}
                    onCommit={(description) =>
                      binding.setFields({
                        description: description || undefined,
                      })
                    }
                    value={block.description ?? ''}
                  />
                )}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>
        </div>
      )}
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

type StageHandle = {
  /** The plane point at the middle of what is shown. */
  centre: () => Vec | null;
  /** Ends what is under way and reports the view, before the editor goes. */
  leave: () => void;
  draw: (graph: GraphBlock) => void;
  /** Moves the view to a typed function wholly off it (`revealed`). */
  reveal: (id: string) => void;
  /** Whether the tools have a row's element selected. */
  selected: (id: string) => boolean;
  /** Lights a row's element on the graph, or none. */
  setHot: (id: string | null) => void;
  /** Selects a row's element on the graph (none for null), added to what
   * is selected with `add`. */
  select: (id: string | null, add?: boolean) => void;
};

type StageHooks = {
  /** Whether the graph holds all it can. */
  full: () => boolean;
  /** The visible area once a pan or zoom settles. */
  onBoundingBox: (bbox: Bbox) => void;
  /** The tool or what it selected changed. */
  onToolsChange: () => void;
  /** A tool's finished change: every element the graph holds after it. */
  onWrite: (next: GraphElement[]) => void;
  /** A tool's new element turned away at the cap. */
  refused: () => void;
};

/** A tool icon, the canvas plane's (graph/toolIcons.ts). */
function ToolIcon({ className, name }: { className?: string; name: string }) {
  return (
    <span
      aria-hidden
      className={cn('contents', className)}
      // The plane's own SVG strings, one set for both editors.
      dangerouslySetInnerHTML={{ __html: toolIcon(name) }}
    />
  );
}

/** The live graph filling the editor, as the canvas plane always has (Epo
 * 2026-11-17: the plane's editor is the one editor). The list, the corners and
 * the tools float over it. A figure's view is the stretch of its stored size
 * around the middle at the editor's scale, as a canvas card's is: a pan or zoom
 * writes it once settled. A plane's camera goes to the board. It has the
 * plane's gestures and tools (Epo 2026-11-16): the wheel pans, pinch and
 * Ctrl/⌘-wheel zoom, the middle button pans, and the plane's Select, Point,
 * Line, Vector, Curve, Ellipse, Label, Formula and Erase (graph/tools.ts). */
function GraphStage({
  graph,
  drawable,
  handle,
  hooks,
  list,
  onClear,
  onDone,
  onRemove,
  plane,
}: {
  graph: GraphBlock;
  /** Its size and bounds can be drawn; otherwise the last picture stays. */
  drawable: boolean;
  handle: Ref<StageHandle>;
  hooks: StageHooks;
  /** Where the rows' list sits: the tools ride above a phone's sheet. */
  list: '' | 'floating' | 'sheet';
  /** The menu's Clear all, last, where Undo can take it back. */
  onClear?: () => void;
  onDone: () => void;
  onRemove?: () => void;
  plane?: PlaneMode;
}) {
  const stageRoot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const labelField = useRef<HTMLInputElement>(null);
  const { isDark } = useTheme();
  const [size, setSize] = useState<{ h: number; w: number } | null>(null);
  const [preview, setPreview] = useState<{ bbox: Bbox; open: boolean }>();
  // The tools' state lives in them; this draws their strip and fields again.
  const [, toolsChanged] = useReducer((n: number) => n + 1, 0);
  const [formula, setFormula] = useState<{
    at: Vec;
    done: (latex: string) => void;
    latex: string;
  } | null>(null);
  // What frames, gestures and tools read: the newest graph and view.
  const live = useRef({
    drawable,
    frame: 0,
    // A pan or zoom under way: a co-editor's view waits for it.
    gesture: false,
    graph,
    hooks,
    list,
    /** The scale the editor opened on: the menu's 100%. */
    opened: 0,
    paper: PAPER.light,
    plane,
    /** The editor's pixels. */
    size: { h: 0, w: 0 },
    tools: null as GraphTools | null,
    view: null as View | null,
  });
  live.current.hooks = hooks;
  live.current.list = list;
  live.current.plane = plane;
  live.current.drawable = drawable;
  const zoomRange = () => (live.current.plane ? PLANE_ZOOM : QUESTION_ZOOM);
  /** The plane point at the middle of the editor. */
  const middle = () => {
    const { size: now, view } = live.current;
    return view && toPlane(view, [now.w / 2, now.h / 2]);
  };
  /** A figure's view: its stored size around the editor's middle. */
  const figureBox = (): Bbox | null => {
    const { graph: now, view } = live.current;
    const centre = middle();
    if (!(view && centre)) return null;
    const [x, y] = centre;
    const w = now.width / 2 / view.ppuX;
    const h = now.height / 2 / view.ppuY;
    return [x - w, y + h, x + w, y - h];
  };
  /** The view showing a figure's stored view at its scale, in the middle. */
  const viewOfFigure = (): View | null => {
    const { graph: now, size: room } = live.current;
    const [left, top, right, bottom] = now.board.bbox;
    const ppuX = now.width / (right - left);
    const ppuY = now.height / (top - bottom);
    // Bounds or a size typed that cannot be drawn: no view until they can.
    if (
      ![left, top, ppuX, ppuY].every(Number.isFinite) ||
      ppuX <= 0 ||
      ppuY <= 0
    )
      return null;
    return {
      left: (left + right) / 2 - room.w / 2 / ppuX,
      ppuX,
      ppuY,
      top: (top + bottom) / 2 + room.h / 2 / ppuY,
    };
  };
  const paint = () => {
    const now = live.current;
    now.frame = 0;
    const ctx = canvas.current?.getContext('2d');
    if (!(ctx && canvas.current && now.view && now.tools && now.size.w)) return;
    const shown = now.tools.shown();
    const k = canvas.current.width / now.size.w;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, now.size.w, now.size.h);
    drawGraph(
      ctx,
      { ...now.size, x: 0, y: 0 },
      now.view,
      shown === now.graph.elements
        ? now.graph
        : { ...now.graph, elements: shown },
      now.paper,
      redraw
    );
    now.tools.drawOverlay(now.paper.ink);
  };
  const redraw = () => {
    live.current.frame ||= requestAnimationFrame(paint);
  };
  /** A figure's view to the dialog when it changed; a plane's camera to the
   * board. */
  const report = () => {
    // Nothing is written while its size or bounds cannot be drawn.
    if (!live.current.drawable) return;
    const { graph: now, plane: card, view } = live.current;
    const centre = middle();
    if (!(view && centre)) return;
    if (card) {
      card.onCamera({ centre, ppu: view.ppuX });
      return;
    }
    const bbox = figureBox();
    if (bbox && !sameBox(bbox, now.board.bbox))
      live.current.hooks.onBoundingBox(bbox);
  };
  const zoomBy = (factor: number) => {
    const { size: now, view } = live.current;
    if (!view) return;
    live.current.view = zoomedAt(
      view,
      factor,
      [now.w / 2, now.h / 2],
      zoomRange()
    );
    redraw();
    report();
  };
  const fit = () => {
    const { graph: now, size: room, view } = live.current;
    if (!view) return;
    // As Fit to size frames, so a second press changes nothing (Epo
    // 2026-11-18), at least FIT_SPAN units each way (`fitPressed`).
    live.current.view = framed(
      fitPressed(
        now.elements,
        { height: room.h, width: room.w },
        bboxOf(view, room.w, room.h),
        FIT_SPAN
      ),
      view,
      room.w,
      room.h
    );
    redraw();
    report();
  };
  useImperativeHandle(handle, () => ({
    // Over a phone's sheet, the middle of what's left above it.
    centre: () => {
      const { list: shown, size: room, view } = live.current;
      return (
        view &&
        toPlane(view, [
          room.w / 2,
          shown === 'sheet' ? room.h * 0.26 : room.h / 2,
        ])
      );
    },
    draw(next) {
      live.current.graph = next;
      redraw();
    },
    // Leaving: a label typed is written, a line or curve with one point
    // goes, and the view as it is now, a gesture still settling included.
    leave: () => {
      live.current.tools?.leave();
      report();
    },
    reveal: (id) => {
      const { graph: now, list: shown, size: room, view } = live.current;
      const element = now.elements.find((one) => one.id === id);
      if (!(view && room.w && element?.type === 'expression')) return;
      // Over a phone's sheet, only what's above it is seen (as `centre`).
      const seen = shown === 'sheet' ? room.h * 0.52 : room.h;
      const moved = revealed(element, view, room.w, seen);
      if (!moved) return;
      live.current.view = moved;
      redraw();
      report();
    },
    select: (id, add) => live.current.tools?.select(id, add),
    selected: (id) => live.current.tools?.selected(id) ?? false,
    setHot: (id) => live.current.tools?.setHot(id),
  }));
  // A graph from the editor (a co-editor's, or ours rendered): drawn. A
  // figure's bounds or size typed, or a co-editor's view (once our own gesture
  // ends, which then writes ours), set its view again.
  useEffect(() => {
    live.current.graph = graph;
    const { gesture, size: room, view } = live.current;
    if (!plane && drawable && room.w && !gesture) {
      const shown = figureBox();
      if (!(view && shown && sameBox(shown, graph.board.bbox)))
        live.current.view = viewOfFigure();
    }
    redraw();
  });
  useEffect(() => {
    live.current.paper = isDark ? PAPER.dark : PAPER.light;
    redraw();
  }, [isDark]);
  // The canvas's pixels follow the editor's size and the screen's density.
  useEffect(() => {
    const target = canvas.current;
    if (!(target && size)) return;
    target.width = Math.round(size.w * window.devicePixelRatio);
    target.height = Math.round(size.h * window.devicePixelRatio);
    redraw();
  }, [size]);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('No canvas to draw the graph on');
    const tools = graphTools({
      accent: () =>
        getComputedStyle(target).getPropertyValue('--color-action-accent'),
      canvas: target,
      changed: () => {
        toolsChanged();
        live.current.hooks.onToolsChange();
      },
      ctx,
      dark: () => live.current.paper.dark,
      elements: () => live.current.graph.elements,
      formula: (near, at, done) =>
        setFormula({ at, done, latex: near?.latex ?? '' }),
      full: () => live.current.hooks.full(),
      labelText: () => labelField.current?.value ?? null,
      local: (event) => {
        const rect = target.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
      },
      polar: () => Boolean(live.current.graph.board.polar),
      redraw,
      refused: () => live.current.hooks.refused(),
      size: () => live.current.size,
      trail: new EraserTrail(redraw),
      // A graph that cannot draw shows nothing; its tools get a unit camera.
      view: () =>
        live.current.view ??
        viewOfFigure() ?? { left: 0, ppuX: 1, ppuY: 1, top: 0 },
      write: (next) => live.current.hooks.onWrite(next),
    });
    live.current.tools = tools;
    const detachTools = tools.attach();
    const detachGestures = attachGestures(
      target,
      {
        pan: (dx, dy) => {
          const { view } = live.current;
          if (!view) return;
          live.current.gesture = true;
          live.current.view = panned(view, dx, dy);
          redraw();
        },
        settle: () => {
          live.current.gesture = false;
          report();
        },
        zoom: (factor, at) => {
          const { view } = live.current;
          if (!view) return;
          live.current.gesture = true;
          live.current.view = zoomedAt(view, factor, at, zoomRange());
          redraw();
        },
      },
      () => 1
    );
    // The graph takes the keys once pressed: Delete, Escape and the tools'
    // letters, as on the plane. Escape with nothing of the tools' to end
    // reaches the dialog or the board, which close. Window capture, ahead of
    // theirs.
    const focus = () => target.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      const active = document.activeElement;
      const name = event.key.toLowerCase();
      if (active === labelField.current) {
        if (name !== 'escape') return;
        event.preventDefault();
        event.stopPropagation();
        tools.escape();
        return;
      }
      const command = event.metaKey || event.ctrlKey;
      // A plane's Undo and Redo: the board's steps, not a field's own.
      const history = live.current.plane?.history;
      if (
        history &&
        command &&
        !event.altKey &&
        (name === 'z' || name === 'y') &&
        !(
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active?.closest('math-field, [contenteditable="true"]')
        ) &&
        (active === document.body ||
          stageRoot.current?.parentElement?.contains(active))
      ) {
        event.preventDefault();
        if (name === 'y' || event.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (active !== target) return;
      if (name === 'escape') {
        if (!tools.escape()) return;
        event.preventDefault();
        event.stopPropagation();
      } else if (
        (name === 'delete' || name === 'backspace') &&
        tools.deleteSelected()
      )
        event.preventDefault();
      else if (
        !(command || event.altKey || event.shiftKey) &&
        event.code.startsWith('Key') &&
        tools.shortcut(event.code.slice(3))
      )
        event.preventDefault();
    };
    target.addEventListener('pointerdown', focus);
    window.addEventListener('keydown', key, true);
    toolsChanged();
    // A plane takes the keys at once, as it always has: its tools' letters,
    // Escape; a row the editor focused first keeps them.
    if (live.current.plane)
      requestAnimationFrame(() => {
        if (!stageRoot.current?.parentElement?.contains(document.activeElement))
          focus();
      });
    return () => {
      if (live.current.gesture) report();
      tools.leave();
      detachTools();
      detachGestures();
      target.removeEventListener('pointerdown', focus);
      window.removeEventListener('keydown', key, true);
      cancelAnimationFrame(live.current.frame);
      live.current.frame = 0;
      live.current.tools = null;
    };
  }, []);
  // The editor's size: its middle stays where it was as it changes.
  useEffect(() => {
    const root = stageRoot.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const next = { h: root.clientHeight, w: root.clientWidth };
      const { plane: card, view } = live.current;
      const centre = middle();
      live.current.size = next;
      if (view && centre)
        live.current.view = {
          ...view,
          left: centre[0] - next.w / 2 / view.ppuX,
          top: centre[1] + next.h / 2 / view.ppuY,
        };
      else if (card) {
        const {
          centre: [x, y],
          ppu,
        } = card.camera;
        live.current.view = {
          left: x - next.w / 2 / ppu,
          ppuX: ppu,
          ppuY: ppu,
          top: y + next.h / 2 / ppu,
        };
      } else live.current.view = viewOfFigure();
      live.current.opened ||= live.current.view?.ppuX ?? 0;
      setSize(next);
      redraw();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const tools = live.current.tools;
  const view = live.current.view;
  const typing = tools?.typing();
  const typedAt = typing && view && toScreen(view, typing.at);
  const finishLabel = tools?.finishLabel();
  const formulaAt = formula && view && toScreen(view, formula.at);
  /** A symbol typed where the label's caret is, within its length. */
  const insertSymbol = (symbol: string) => {
    const field = labelField.current;
    if (!field) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    if (
      field.value.length - (end - start) + symbol.length >
      limits.QUESTION_GRAPH_LABEL_MAX
    )
      return;
    field.setRangeText(symbol, start, end, 'end');
  };
  // The menu's zoom against the view the editor opened on.
  const percent =
    view && live.current.opened ? view.ppuX / live.current.opened : 1;
  const history = plane?.history;
  const canUndo = useSyncExternalStore(
    history?.subscribe ?? noSubscribe,
    () => history?.canUndo() ?? false
  );
  const canRedo = useSyncExternalStore(
    history?.subscribe ?? noSubscribe,
    () => history?.canRedo() ?? false
  );
  /** A menu press that keeps the menu open, its zoom shown again. */
  const step = (action: () => void) => () => {
    action();
    toolsChanged();
  };
  const sheet = list === 'sheet';
  return (
    <div
      className="@container absolute inset-0 overflow-hidden"
      ref={stageRoot}
    >
      <div className="absolute inset-0">
        <canvas
          aria-label={m.drawing_board_maths()}
          className="block origin-top-left touch-none outline-none"
          ref={canvas}
          style={{ height: size?.h, width: size?.w }}
          tabIndex={0}
        />
        {typing && typedAt && (
          <>
            <input
              aria-label={m.drawing_board_chart_label()}
              // The plane's label field, at its size on the graph.
              className="absolute z-10 w-[8.5em] -translate-x-1/2 -translate-y-1/2 border-[#1e96eb] border-b bg-overlay px-1 py-0.5 text-center font-[Arial,sans-serif] font-medium text-fg outline-none"
              defaultValue={typing.text}
              key={typing.id ?? typing.at.join()}
              maxLength={limits.QUESTION_GRAPH_LABEL_MAX}
              onBlur={() => tools?.commitLabel()}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                tools?.commitLabel();
                // The graph keeps the keys: its tools' letters, Delete, Escape.
                canvas.current?.focus({ preventScroll: true });
              }}
              ref={(field) => {
                if (field && labelField.current !== field) {
                  labelField.current = field;
                  field.focus();
                  field.select();
                } else if (!field) labelField.current = null;
              }}
              style={{
                fontSize: typing.size ?? LABEL_SIZE,
                left: typedAt[0],
                top: typedAt[1],
              }}
              type="text"
            />
            <div
              className="absolute z-10 flex max-w-[calc(100%-16px)] -translate-x-1/2 flex-wrap rounded-(--radius-toolbar) border border-overlay-line bg-overlay p-[3px] shadow-pop"
              style={{
                left: Math.min(Math.max(typedAt[0], 120), (size?.w ?? 0) - 120),
                top: typedAt[1] + (typing.size ?? LABEL_SIZE) / 2 + 12,
              }}
            >
              {SYMBOLS.map((symbol) => (
                <button
                  className="grid size-8 place-items-center rounded-(--radius-toolbar-button) text-[15px] text-fg hover:bg-surface-hover-bg"
                  key={symbol}
                  onClick={() => insertSymbol(symbol)}
                  onMouseDown={(event) => event.preventDefault()}
                  type="button"
                >
                  {symbolLabel(symbol)}
                </button>
              ))}
            </div>
          </>
        )}
        {formula && formulaAt && (
          <Popover
            onOpenChange={(open) => {
              if (!open) setFormula(null);
            }}
            open
          >
            <PopoverAnchor
              className="absolute size-0"
              style={{ left: formulaAt[0], top: formulaAt[1] }}
            />
            <PopoverContent
              className="w-72 p-3"
              // The formula's field takes the keys once MathLive has it, not Cancel.
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <FormulaCard
                latex={formula.latex}
                onCancel={() => setFormula(null)}
                onSave={(latex) => {
                  setFormula(null);
                  formula.done(latex);
                }}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
      {finishLabel && (
        <button
          className={cn(
            // Above the tools, as on the plane.
            'absolute inset-x-0 bottom-16 z-10 mx-auto h-9 w-fit whitespace-nowrap rounded-(--radius-toolbar-button) bg-action px-3 font-semibold text-[13px] text-action-fg shadow-pop',
            sheet && 'bottom-[calc(48%+60px)]'
          )}
          onClick={() => tools?.finish()}
          type="button"
        >
          {finishLabel}
        </button>
      )}
      {/* Top right, as an open canvas card's: the menu and Done. */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <button
              aria-label={m.drawing_board_menu()}
              className="grid size-10 place-items-center rounded-(--radius-toolbar) border border-overlay-line bg-overlay text-fg-muted hover:bg-overlay-hover focus-visible:outline-2 focus-visible:outline-action-accent"
              type="button"
            >
              <Icon name="menu" />
            </button>
          </PopoverTrigger>
          <ToolbarPopoverContent align="end" className="w-48">
            <PopoverClose asChild>
              <ToolbarPopoverItem
                icon={<Icon name="fitToScreen" />}
                label={m.drawing_board_fit_to_screen()}
                onClick={fit}
              />
            </PopoverClose>
            {/* They keep the menu open, so a few presses step back. */}
            {history && (
              <>
                <ToolbarPopoverItem
                  disabled={!canUndo}
                  icon={<Icon name="undo" />}
                  label={m.drawing_board_undo()}
                  onClick={history.undo}
                />
                <ToolbarPopoverItem
                  disabled={!canRedo}
                  icon={<Icon name="redo" />}
                  label={m.drawing_board_redo()}
                  onClick={history.redo}
                />
              </>
            )}
            {/* A figure as readers see it: its frame is not drawn here. */}
            {!plane && (
              <PopoverClose asChild>
                <ToolbarPopoverItem
                  icon={<Icon name="maximize" />}
                  label={m.material_fullscreen()}
                  onClick={() => {
                    const bbox = figureBox();
                    if (bbox) setPreview({ bbox, open: true });
                  }}
                />
              </PopoverClose>
            )}
            {onRemove && (
              <PopoverClose asChild>
                <ToolbarPopoverItem
                  icon={<Icon name="trash" />}
                  label={m.question_ui_remove_block()}
                  onClick={onRemove}
                />
              </PopoverClose>
            )}
            {onClear && (
              <PopoverClose asChild>
                <ToolbarPopoverItem
                  disabled={!graph.elements.length}
                  icon={<Icon name="trash" />}
                  label={m.drawing_board_clear_all()}
                  onClick={onClear}
                />
              </PopoverClose>
            )}
            {/* − 100% +, under the entries; they keep the menu open. */}
            <div className="mt-1 flex items-center justify-between border-overlay-line border-t pt-1">
              <ToolbarButton
                label={m.drawing_board_zoom_out()}
                onClick={step(() => zoomBy(1 / 1.5))}
                type="button"
              >
                <Icon name="minus" />
              </ToolbarButton>
              <button
                aria-label={m.drawing_board_zoom_reset()}
                className="h-7.5 flex-1 rounded-lg text-sm hover:bg-surface-hover-bg"
                onClick={step(() => zoomBy(percent ? 1 / percent : 1))}
                type="button"
              >
                {Math.round(percent * 100)}%
              </button>
              <ToolbarButton
                label={m.drawing_board_zoom_in()}
                onClick={step(() => zoomBy(1.5))}
                type="button"
              >
                <Icon name="plus" />
              </ToolbarButton>
            </div>
          </ToolbarPopoverContent>
        </Popover>
        <button
          className="h-10 rounded-(--radius-toolbar) bg-action px-4 font-semibold text-action-fg text-sm shadow-[0_4px_12px_rgb(0_0_0/14%)]"
          onClick={onDone}
          type="button"
        >
          {m.drawing_board_done()}
        </button>
      </div>
      {tools && (
        <BlockToolbar
          className={cn(
            // Centred by its margins: a left of 50% would halve the width it
            // may take. The plane's strip: 36 px buttons and icons of 24, 32 px
            // under 380 px so its nine fit a 360 px phone.
            'absolute inset-x-2 bottom-3 z-10 mx-auto flex-wrap justify-center p-1 @min-[380px]:[--toolbar-button:36px] [--toolbar-button:32px] [--toolbar-icon:24px] sm:p-1 sm:[--toolbar-button:36px]',
            sheet && 'bottom-[calc(48%+8px)]'
          )}
        >
          {toolsFor(Boolean(graph.board.polar)).map(
            ({ icon, id, key, label }) => (
              <ToolbarButton
                active={tools.tool() === id}
                key={id}
                label={label()}
                onClick={() => tools.pick(id)}
                shortcut={key}
                tooltipSide="top"
                type="button"
              >
                <ToolIcon name={icon} />
              </ToolbarButton>
            )
          )}
        </BlockToolbar>
      )}
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

/** A formula typed for the graph, as the board's formula card: Save keeps
 * the card open until KaTeX can draw it; an empty one takes the formula away. */
function FormulaCard({
  latex,
  onCancel,
  onSave,
}: {
  latex: string;
  onCancel: () => void;
  onSave: (latex: string) => void;
}) {
  const typed = useRef(latex);
  const [error, setError] = useState<string>();
  const save = async () => {
    const value = typed.current.trim();
    if (!value) {
      onSave('');
      return;
    }
    if ([...value].length > limits.QUESTION_GRAPH_LATEX_MAX) {
      setError(m.drawing_board_formula_too_long());
      return;
    }
    try {
      (await loadKatex()).renderToString(value, {
        ...KATEX_OPTIONS,
        throwOnError: true,
      });
      await drawing(value);
    } catch {
      setError(m.drawing_board_formula_error());
      return;
    }
    onSave(value);
  };
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-divider px-2 py-1.5">
        <GraphRowField
          autoFocus
          label={m.drawing_board_plane_formula()}
          latex={latex}
          onChange={(next) => {
            typed.current = next;
            setError(undefined);
          }}
          onEnter={() => void save()}
          onMoveOut={() => undefined}
          register={() => undefined}
        />
      </div>
      {error && <p className="text-[13px] text-solid-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          {m.action_cancel()}
        </Button>
        <Button
          onClick={() => void save()}
          size="sm"
          type="button"
          variant="accent"
        >
          {m.action_save()}
        </Button>
      </div>
    </div>
  );
}

/** A row's look: lit while typed in, or while the graph has its element
 * selected. */
/** A row as the plane's list draws it (Epo 2026-11-13): 36 px, its kind's
 * icon, the field, then ⋮ on hover; lit while selected or typed in. */
const rowClass = (selected: boolean) =>
  cn(
    'group grid min-h-9 cursor-text grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center gap-1.5 border-divider border-b py-0.5 pr-1 pl-1.5 text-sm focus-within:bg-action-accent/9 focus-within:shadow-[inset_2px_0_0_var(--color-action-accent)] hover:bg-surface-hover-bg',
    selected &&
      'bg-action-accent/9 shadow-[inset_2px_0_0_var(--color-action-accent)]'
  );

/** A row's kind, the plane's icon; lit with its row. */
const kindClass = (selected: boolean) =>
  cn(
    'grid size-6 place-items-center text-fg-muted group-focus-within:text-action-accent [&_svg]:size-[18px]',
    selected && 'text-action-accent'
  );

/** Escape in a row's field leaves the field first, as the plane's list did. */
const leaveOnEscape = (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.currentTarget.blur();
};

/** What lights a row: its element under the pointer or selected on the graph. */
type RowLight = {
  /** The row's own field took focus. */
  onFieldFocus: () => void;
  onHover: () => void;
  selected: boolean;
};

function ExpressionItem({
  autoFocus,
  onFieldFocus,
  onHover,
  selected,
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
  onChange: (latex: string) => void;
  onEnter: () => void;
  onMoveOut: (direction: 'up' | 'down') => void;
  onRemove?: () => void;
  onRemoveEmpty?: () => void;
  onRestyle: (style: RowStyle) => void;
  register: (field: MathfieldElement | null) => void;
} & RowLight) {
  const type = row?.parsed && !error ? elementType(row.parsed) : undefined;
  const kind = row?.parsed && !error ? parsedKind(row.parsed) : undefined;
  // A focused row doesn't light its curve (Epo 2026-11-18, "the highlight on
  // curve is a bit intrusive"); hovering still does.
  return (
    <li
      className={rowClass(selected)}
      onClick={focusRowField}
      onPointerEnter={onHover}
    >
      {error ? (
        <RowIssue message={error} />
      ) : kind && row ? (
        <KindIcon hidden={row.style.hidden} kind={kind} selected={selected} />
      ) : (
        <span />
      )}
      <span className="min-w-0" data-row-field onFocus={onFieldFocus}>
        <GraphRowField
          autoFocus={autoFocus}
          label={label}
          latex={row?.latex ?? ''}
          onChange={onChange}
          onEnter={onEnter}
          onMoveOut={onMoveOut}
          onRemoveEmpty={onRemoveEmpty}
          placeholder={row ? undefined : m.drawing_board_plane_type_formula()}
          register={register}
        />
      </span>
      {onRemove ? (
        <RowMenu onRemove={onRemove}>
          {type && row && (
            <StyleFields onChange={onRestyle} row={row} type={type} />
          )}
        </RowMenu>
      ) : (
        <span />
      )}
    </li>
  );
}

/** A click on a row's icon or blank space types in its field. */
function focusRowField(event: React.MouseEvent<HTMLLIElement>) {
  if (
    event.target === event.currentTarget ||
    (event.target as Element).closest('[data-row-field],[data-row-icon]')
  )
    (
      event.currentTarget.querySelector(
        'math-field, input'
      ) as HTMLElement | null
    )?.focus();
}

/** A row that cannot be drawn: the question dialog's warning icon. */
function RowIssue({ message }: { message: string }) {
  return (
    <span className="grid size-6 place-items-center">
      <IssueIcon messages={[message]} />
    </span>
  );
}

/** A row's ⋮: its style and Hide (Epo 2026-11-18, "put the hide button into
 * the menu icon button"), then Delete. */
function RowMenu({
  children,
  onRemove,
}: {
  children?: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={m.a11y_more_actions()}
          className="grid size-6 place-items-center rounded-(--radius-toolbar-button) text-fg-muted opacity-0 hover:bg-surface-hover-bg focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [&_svg]:size-[18px]"
          type="button"
        >
          <Icon name="moreVertical" />
        </button>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="end"
        className={cn(children ? 'w-60' : 'w-40')}
      >
        {children && (
          <div className="space-y-3 border-divider border-b p-3">
            {children}
          </div>
        )}
        <PopoverClose asChild>
          <ToolbarPopoverItem
            icon={<Icon name="trash" />}
            label={m.action_delete()}
            onClick={onRemove}
          />
        </PopoverClose>
      </ToolbarPopoverContent>
    </Popover>
  );
}

/** A row's style in its ⋮ menu: dash, marks, shading, label and Hide. */
function StyleFields({
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
    <>
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
    </>
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
  onFieldFocus,
  onHover,
  selected,
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
} & RowLight) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoSelect) return;
    input.current?.focus();
    input.current?.select();
  }, [autoSelect]);
  return (
    <li
      className={rowClass(selected)}
      onClick={focusRowField}
      onPointerEnter={onHover}
    >
      {error ? (
        <RowIssue message={error} />
      ) : (
        <KindIcon hidden={row.hidden} kind="label" selected={selected} />
      )}
      <FieldInput
        aria-label={m.question_ui_label()}
        className="py-0 leading-[1.4]"
        maxLength={limits.QUESTION_GRAPH_LABEL_MAX}
        onChange={(event) => onChange({ ...row, text: event.target.value })}
        // Its own field, not its ⋮ menu, picks the label on the graph.
        onFocus={onFieldFocus}
        onKeyDown={leaveOnEscape}
        ref={input}
        value={row.text}
        variant="transparent"
        wrapperClassName="h-auto min-w-0 px-0"
      />
      <RowMenu onRemove={onRemove}>
        <HideSwitch
          checked={Boolean(row.hidden)}
          onChange={(hidden) =>
            onChange({ ...row, hidden: hidden || undefined })
          }
        />
      </RowMenu>
    </li>
  );
}

/** A free mark's row, as the canvas plane lists it (Epo 2026-11-13, L2): a
 * line or vector typed in place from one point to the other, a curve, ellipse
 * or formula by its kind's name; drawn and changed on the graph. */
function MarkRow({
  error,
  label,
  onChange,
  onFieldFocus,
  onHover,
  onRemove,
  row,
  selected,
}: {
  error: string | undefined;
  label: string;
  onChange: (element: FreeMark) => void;
  onRemove: () => void;
  row: Extract<GraphRow, { kind: 'mark' }>;
} & RowLight) {
  const shown = markRow(row.element);
  return (
    <li className={rowClass(selected)} onPointerEnter={onHover}>
      {error ? (
        <RowIssue message={error} />
      ) : (
        <span className={kindClass(selected)}>
          <ToolIcon name={kindOf(row.element)} />
        </span>
      )}
      {shown.typed ? (
        <FieldInput
          aria-label={label}
          className="py-0 leading-[1.4]"
          defaultValue={shown.text}
          // A new value (a drag, a co-editor) starts the field again.
          key={shown.text}
          maxLength={80}
          onBlur={(event) => {
            const line = typedLine(row.element, event.currentTarget.value);
            if (line) onChange(line);
            else event.currentTarget.value = shown.text;
          }}
          onFocus={onFieldFocus}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            leaveOnEscape(event);
          }}
          variant="transparent"
          wrapperClassName="h-auto min-w-0 px-0"
        />
      ) : (
        <span className="truncate">{shown.text}</span>
      )}
      <RowMenu onRemove={onRemove} />
    </li>
  );
}

/** A row's kind, the label of its field: a click types in it (Epo
 * 2026-11-18; its style and Hide are in the row's ⋮). Faded when hidden. */
function KindIcon({
  hidden,
  kind,
  selected,
}: {
  hidden?: boolean;
  kind: string;
  selected: boolean;
}) {
  return (
    <span
      className={cn(kindClass(selected), hidden && 'opacity-35')}
      data-row-icon
    >
      <ToolIcon name={kind} />
    </span>
  );
}
