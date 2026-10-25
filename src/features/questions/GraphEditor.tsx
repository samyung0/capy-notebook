import type { MathfieldElement } from 'mathlive';
import { Collapsible } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { FigurePreview } from '@/features/materials/staticViews';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { Field, FieldInput, MenuItem, SelectField } from './editorFields';
import { GraphRowField } from './GraphRowField';
import { createGraphBoard, GraphError, validateGraphRecipe } from './graph';
import {
  buildElements,
  displayNumber,
  type GraphRow,
  type ParsedRow,
  parseRow,
  pointLatex,
  RowError,
  type RowStyle,
  rowsFromElements,
  styleKeys,
  syncRows,
} from './graphSyntax';
import { IssueIcon, IssueSummary } from './IssueViews';
import type { GraphBlock, GraphElement } from './types';

type Board = Awaited<ReturnType<typeof createGraphBoard>>;
type ExpressionRow = Extract<GraphRow, { kind: 'expression' }>;

const elementType = (parsed: ParsedRow): GraphElement['type'] =>
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

/** Desmos-style graph editor: typed rows on the left, the live board on the
 * right; phones stack the board on top. The board frames what Save exports. */
export function GraphEditor({
  descriptionMax,
  value,
  onChange,
  onInvalidChange,
  toolbarTarget,
}: {
  /** The description's bound: the bank's longer one or everyone else's. */
  descriptionMax: number;
  /** Where the zoom tools go instead of floating over the board. */
  toolbarTarget?: HTMLElement | null;
  value: GraphBlock;
  onChange: (value: GraphBlock) => void;
  /** Rows that cannot be drawn keep the dialog from saving. */
  onInvalidChange?: (invalid: boolean) => void;
}) {
  const [rows, setRows] = useState(() => rowsFromElements(value.elements));
  // Elements arriving that the rows did not give are a peer's change.
  const [synced, setSynced] = useState(value.elements);
  if (value.elements !== synced) {
    setSynced(value.elements);
    setRows(syncRows(rows, value.elements));
  }
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  // An empty graph starts in its first row.
  const [startKey] = useState(() => (rows.length ? undefined : draftKey));
  const latest = useRef({ onChange, rows, value });
  latest.current = { onChange, rows, value };
  const fields = useRef(new Map<string, MathfieldElement>());
  // Fresh labels open with their text selected, ready to type over.
  const [freshLabel, setFreshLabel] = useState<string>();
  const { errors: rowErrors } = useMemo(() => buildElements(rows), [rows]);
  // Rows past the cap (two editors' rows merged) are not drawn for readers:
  // each says so until the graph is back within it.
  const errors = useMemo(() => {
    const over = rows.slice(limits.QUESTION_GRAPH_ELEMENTS_MAX);
    if (!over.length) return rowErrors;
    const out = new Map(rowErrors);
    for (const row of over)
      if (!out.has(row.key))
        out.set(
          row.key,
          m.question_ui_a_graph_can_contain_at_most_60_elements()
        );
    return out;
  }, [rowErrors, rows]);
  // Issues read like the question dialog's (Epo 2026-10-15): the first one
  // above the editor, a warning icon on each affected row and on Advanced.
  const advancedIssues = boardIssues(value);
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
  // Anything else the board refuses still reads here, never as a blank board.
  if (!issues.length) {
    try {
      validateGraphRecipe(value);
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      issues.push(error.message);
    }
  }
  const invalid = issues.length > 0;
  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);
  useEffect(() => () => onInvalidChange?.(false), [onInvalidChange]);

  const commit = (next: GraphRow[]) => {
    setRows(next);
    const { elements } = buildElements(next);
    setSynced(elements);
    latest.current.onChange({ ...latest.current.value, elements });
  };
  const edit = (key: string, latex: string, ascii: string) => {
    const current = latest.current.rows;
    const index = current.findIndex((row) => row.key === key);
    if (index < 0) {
      if (!latex.trim()) return;
      commit([
        ...current,
        {
          key,
          kind: 'expression',
          latex,
          style: {},
          ...parsedRow(latex, ascii),
        },
      ]);
      setDraftKey(crypto.randomUUID());
      return;
    }
    commit(
      current.map((row) =>
        row.key === key && row.kind === 'expression'
          ? { ...row, latex, ...parsedRow(latex, ascii) }
          : row
      )
    );
  };
  const restyle = (key: string, style: RowStyle) =>
    commit(
      latest.current.rows.map((row) =>
        row.key === key && row.kind === 'expression' ? { ...row, style } : row
      )
    );
  const remove = (key: string) =>
    commit(latest.current.rows.filter((row) => row.key !== key));
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

  const hooks = useMemo(
    () => ({
      onBoundingBox: (bbox: GraphBlock['board']['bbox']) => {
        const { value, onChange } = latest.current;
        onChange({ ...value, board: { ...value.board, bbox } });
      },
      onMove: (id: string, coords: [number, number]) =>
        commit(
          latest.current.rows.map((row) => {
            if (row.key !== id) return row;
            if (row.kind === 'label') return { ...row, coords };
            if (row.parsed?.kind !== 'point') return row;
            return {
              ...row,
              latex: pointLatex(row.parsed.name, coords),
              parsed: { ...row.parsed, coords },
            };
          })
        ),
    }),
    // commit only reads refs.
    []
  );

  const setBoard = (board: Partial<GraphBlock['board']>) =>
    onChange({ ...value, board: { ...value.board, ...board } });
  const shown = [
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
        <GraphStage hooks={hooks} toolbarTarget={toolbarTarget} value={value} />
        <div className="@3xl:order-first flex min-w-0 flex-col gap-3.5">
          <ol className="border-divider border-t">
            {order.map((key, index) => {
              const row = rows.find((item) => item.key === key);
              if (row?.kind === 'label')
                return (
                  <LabelRow
                    autoSelect={key === freshLabel}
                    error={errors.get(key)}
                    key={key}
                    onChange={(next) =>
                      commit(
                        rows.map((item) => (item.key === key ? next : item))
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
                const [left, top, right, bottom] = value.board.bbox;
                const key = crypto.randomUUID();
                setFreshLabel(key);
                commit([
                  ...rows,
                  {
                    coords: [
                      Number(((left + right) / 2).toPrecision(12)),
                      Number(((top + bottom) / 2).toPrecision(12)),
                    ],
                    key,
                    kind: 'label',
                    text: m.question_ui_label(),
                  },
                ]);
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
          <Collapsible.Root defaultOpen={Boolean(value.description)}>
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
                  <Field
                    key={key}
                    label={
                      key === 'width'
                        ? m.question_ui_graph_width()
                        : m.question_ui_graph_height()
                    }
                  >
                    <FieldInput
                      max={limits.QUESTION_GRAPH_DIMENSION_MAX}
                      min={limits.QUESTION_GRAPH_DIMENSION_MIN}
                      onChange={(event) =>
                        onChange({
                          ...value,
                          [key]: event.target.valueAsNumber,
                        })
                      }
                      type="number"
                      value={Number.isFinite(value[key]) ? value[key] : ''}
                    />
                  </Field>
                ))}
                <SelectField
                  label={m.question_ui_axes()}
                  onChange={(next) => setBoard({ axis: next === 'shown' })}
                  options={shown}
                  value={value.board.axis ? 'shown' : 'hidden'}
                />
                <SelectField
                  label={m.question_ui_grid()}
                  onChange={(next) => setBoard({ grid: next === 'shown' })}
                  options={shown}
                  value={value.board.grid ? 'shown' : 'hidden'}
                />
                {[0, 2, 3, 1].map((i) => (
                  <Field key={i} label={bboxLabels[i]}>
                    <FieldInput
                      onChange={(event) => {
                        const bbox = [
                          ...value.board.bbox,
                        ] as GraphBlock['board']['bbox'];
                        bbox[i] = event.target.valueAsNumber;
                        setBoard({ bbox });
                      }}
                      type="number"
                      // Enough digits to tell a zoomed-in minimum from its maximum.
                      value={
                        Number.isFinite(value.board.bbox[i])
                          ? Number(value.board.bbox[i].toPrecision(12))
                          : ''
                      }
                    />
                  </Field>
                ))}
              </div>
              <Field
                count={{
                  max: descriptionMax,
                  value: textLength(value.description),
                }}
                label={m.question_ui_description()}
              >
                <FieldInput
                  maxLength={descriptionMax}
                  onChange={(event) =>
                    onChange({ ...value, description: event.target.value })
                  }
                  value={value.description ?? ''}
                />
              </Field>
            </Collapsible.Content>
          </Collapsible.Root>
        </div>
      </div>
    </div>
  );
}

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

/** The live board at the export's pixel size, scaled to the column and
 * no taller than the dialog leaves room for, so the dialog never scrolls for
 * it. */
function GraphStage({
  value,
  hooks,
  toolbarTarget,
}: {
  value: GraphBlock;
  hooks: Parameters<typeof createGraphBoard>[2];
  toolbarTarget?: HTMLElement | null;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const board = useRef<Board | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const [scale, setScale] = useState(0);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ open: boolean; svg: string }>();
  const show = (error: unknown) =>
    setError(
      error instanceof GraphError
        ? error.message
        : m.question_ui_graph_could_not_load()
    );
  // The column's width or the wrapper's max-height, whichever binds first.
  const fit = () => {
    const target = wrapper.current;
    const column = target?.parentElement;
    if (!target || !column) return;
    const maxHeight = Number.parseFloat(getComputedStyle(target).maxHeight);
    const { width, height } = latest.current;
    setScale(Math.min(column.clientWidth / width, maxHeight / height));
  };
  useEffect(() => {
    const column = wrapper.current?.parentElement;
    if (!column) return;
    const observer = new ResizeObserver(fit);
    observer.observe(column);
    // The max-height follows the viewport's height, which the column's
    // width does not.
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);
  const { width, height } = value;
  const { axis, grid } = value.board;
  // The editor lists why a recipe cannot be drawn; the stage waits for a
  // drawable one instead of failing.
  let drawable = true;
  try {
    validateGraphRecipe(value);
  } catch (error) {
    if (!(error instanceof GraphError)) throw error;
    drawable = false;
  }
  // A new size refits; fit reads it from `latest`.
  useEffect(fit, [width, height]);
  // Size and axes are fixed when JSXGraph builds a board; anything else updates it.
  useEffect(() => {
    let cancelled = false;
    if (!stage.current || !drawable) return;
    // A fresh host per board: freeing a stale board clears its container.
    const target = document.createElement('div');
    target.style.cssText = `width:${width}px;height:${height}px`;
    stage.current.append(target);
    setError('');
    createGraphBoard(target, latest.current, hooks)
      .then((created) => {
        if (cancelled) return created.destroy();
        board.current = created;
        // Catch up with edits made while JSXGraph loaded.
        created.update(latest.current);
      })
      .catch((error: unknown) => {
        if (!cancelled) show(error);
      });
    return () => {
      cancelled = true;
      board.current?.destroy();
      board.current = null;
      target.remove();
    };
  }, [width, height, axis, grid, hooks, drawable]);
  useEffect(() => {
    if (!board.current || !drawable) return;
    try {
      board.current.update(value);
      setError('');
    } catch (error) {
      show(error);
    }
  }, [value, drawable]);
  const tools = (
    <BlockToolbar
      className={cn(
        'rounded-md p-0.5',
        // In the heading row it is part of the page, not floating over it.
        toolbarTarget ? 'shadow-none!' : 'absolute top-2 right-2 z-10'
      )}
    >
      <ToolbarButton
        label={m.material_zoom_in()}
        onClick={() => board.current?.zoom(1.5)}
        type="button"
      >
        <Icon name="zoomIn" />
      </ToolbarButton>
      <ToolbarButton
        label={m.material_zoom_out()}
        onClick={() => board.current?.zoom(1 / 1.5)}
        type="button"
      >
        <Icon name="zoomOut" />
      </ToolbarButton>
      <ToolbarButton
        label={m.question_ui_graph_fit()}
        onClick={() => board.current?.fit()}
        type="button"
      >
        <Icon name="fitToScreen" />
      </ToolbarButton>
      <ToolbarButton
        label={m.material_fullscreen()}
        onClick={() => {
          if (board.current)
            setPreview({ open: true, svg: board.current.exportSvg() });
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
        className="relative mx-auto max-h-[calc(88dvh-15rem)] overflow-hidden bg-white"
        ref={wrapper}
        style={{
          aspectRatio: scale ? undefined : `${width} / ${height}`,
          height: scale ? height * scale : undefined,
          width: scale ? width * scale : '100%',
        }}
      >
        <div
          className="origin-top-left touch-none"
          ref={stage}
          style={{ height, transform: `scale(${scale || 1})`, width }}
        />
        {/* MediaFrame's toolbar, always shown, unless the dialog's heading
            row holds it. */}
        {!toolbarTarget && tools}
      </div>
      {toolbarTarget && createPortal(tools, toolbarTarget)}
      {error && (
        <p className="mt-2 text-sm text-solid-error" role="alert">
          {error}
        </p>
      )}
      {/* What Save would export, full screen like a note figure. */}
      {preview && (
        <FigurePreview
          block={{ ...value, image: { svg: preview.svg } }}
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
  type: GraphElement['type'];
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
  type: GraphElement['type'];
  style: RowStyle;
}) {
  const dash = style.dash ? '3.5 3' : undefined;
  const shade = style.shade ? 0.18 : 0;
  const paths: Record<GraphElement['type'], React.ReactNode> = {
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
