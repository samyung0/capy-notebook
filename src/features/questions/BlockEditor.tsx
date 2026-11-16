import { Collapsible } from 'radix-ui';
import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as limits from '@/api/limits.generated';
import { CategoryChart } from '@/components/charts/CategoryChart';
import { PlotChart } from '@/components/charts/PlotChart';
import { Button } from '@/components/ui/Button';
import { DropdownMenuSeparator } from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import { Input, type InputProps } from '@/components/ui/Input';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { BlockMenuItem, TableHandle } from '@/features/notes/blockMenu';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { IMAGE_ACCEPT } from '@/lib/fitImage';
import { textLength } from '@/lib/textLength';
import {
  CommitField,
  Field,
  FieldInput,
  SelectField,
  StringList,
} from './editorFields';
import { type FigureBinding, useBoundFigure } from './figureBinding';
import { GraphEditor } from './GraphEditor';
import { IssueIcon } from './IssueViews';
import { localFigureBinding } from './localFigureBinding';
import { QuestionBlockView } from './QuestionView';
import { repairFigureBlock } from './repair';
import { clickPoint, IdleFormulaTools, TextEditor } from './TextEditor';
import {
  CHART_KINDS,
  type ChartKind,
  gapNumbers,
  type PlotBlock,
  type QuestionBlock,
} from './types';
import { useCommitted } from './useCommitted';

/** Bank uploads return a public URL; quiz uploads return a workspace editor asset. */
/** `signal` cancels an upload the editor no longer wants (it closed). */
export type UploadQuestionAsset = (
  file: File,
  signal?: AbortSignal
) => Promise<{ url: string } | { assetId: string }>;

const chartLabels = {
  area: m.question_ui_area_chart,
  bar: m.question_ui_bar_chart,
  hbar: m.question_ui_horizontal_bar_chart,
  line: m.question_ui_line_chart,
  pie: m.question_ui_pie_chart,
  stacked: m.question_ui_stacked_chart,
} satisfies Record<ChartKind, () => string>;

/** A chart's editor (Epo 2026-11-16, live figures): it edits the chart where
 * `binding` holds it, each change written as it is made: a choice at once, a
 * typed title, name or value once left, a row or column added or removed with
 * its values. Rows and columns are keyed by their ids, so a co-editor's
 * change lands in place and a cell being typed in keeps its text. */
const ChartEditor = memo(function ChartEditor({
  binding,
  descriptionMax,
}: {
  binding: FigureBinding;
  /** The description's bound: the bank's longer one or everyone else's. */
  descriptionMax: number;
}) {
  const { block, labels: rowIds, series: seriesIds } = useBoundFigure(binding);
  if (block.type !== 'chart') throw new Error('The chart editor needs a chart');
  const single = block.kind === 'pie' || block.kind === 'stacked';
  // A merge of two editors' changes (Epo 2026-10-17) can leave values past
  // the labels (a draft's) or series past the cap: the table shows them with
  // their issue, readers the repaired chart.
  // A pie or stacked chart a merge left with another series, a negative or
  // no positive value (Epo 2026-10-18): its first column says which.
  const first = block.series[0]?.values ?? [];
  const pieIssue = single
    ? first.some((n) => n !== null && n < 0)
      ? m.question_issue_pie_negative()
      : first.some((n) => n !== null && n > 0)
        ? undefined
        : m.question_issue_pie()
    : undefined;
  return (
    // Two columns only once the editor itself is wide enough for the table.
    <div className="@container min-w-0">
      <div className="grid min-w-0 @4xl:grid-cols-2 items-start gap-6">
        <div className="min-w-0 space-y-4">
          <SelectField
            className="w-44"
            label={m.question_ui_chart_type()}
            onChange={(next) => {
              const kind = next as ChartKind;
              if (kind !== 'pie' && kind !== 'stacked')
                return binding.setFields({ kind });
              // Parts of one whole: one series and no axes.
              binding.setFields({ kind, xTitle: undefined, yTitle: undefined });
              for (const id of seriesIds.slice(1))
                binding.removeChartItem('series', id);
            }}
            options={CHART_KINDS.map((kind) => ({
              label: chartLabels[kind](),
              value: kind,
            }))}
            value={block.kind}
          />
          <CommitField
            count={limits.QUESTION_CHART_TITLE_MAX}
            label={m.question_ui_title()}
            maxLength={limits.QUESTION_CHART_TITLE_MAX}
            onCommit={(title) => binding.setFields({ title })}
            value={block.title}
          />
          {!single && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(['xTitle', 'yTitle'] as const).map((key) => (
                <CommitField
                  count={limits.QUESTION_CHART_TITLE_MAX}
                  key={key}
                  label={
                    key === 'xTitle'
                      ? m.question_ui_x_axis()
                      : m.question_ui_y_axis()
                  }
                  maxLength={limits.QUESTION_CHART_TITLE_MAX}
                  onCommit={(text) =>
                    binding.setFields(
                      key === 'xTitle' ? { xTitle: text } : { yTitle: text }
                    )
                  }
                  value={block[key] ?? ''}
                />
              ))}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="w-0" />
                  <th className="border border-divider bg-surface-hover-bg p-2 text-left">
                    {m.question_ui_label()}
                  </th>
                  {block.series.map((series, i) => (
                    <th
                      className="min-w-20 border border-divider bg-surface-hover-bg"
                      key={seriesIds[i]}
                    >
                      {i >= limits.QUESTION_CHART_SERIES_MAX && (
                        <IssueIcon
                          messages={[
                            m.question_ui_chart_series_over({
                              max: limits.QUESTION_CHART_SERIES_MAX,
                            }),
                          ]}
                        />
                      )}
                      {single && i > 0 && (
                        <IssueIcon messages={[m.question_issue_pie_series()]} />
                      )}
                      {i === 0 && pieIssue && (
                        <IssueIcon messages={[pieIssue]} />
                      )}
                      <CommitCell
                        aria-label={m.question_ui_series_name({
                          number: i + 1,
                        })}
                        maxLength={limits.QUESTION_CHART_SERIES_NAME_MAX}
                        onCommit={(name) =>
                          binding.setChartName(seriesIds[i], name)
                        }
                        placeholder={m.question_ui_chart_series_placeholder()}
                        value={series.name}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowIds.map((label, row) => (
                  <tr key={label}>
                    <td className="w-0 whitespace-nowrap pr-1">
                      {row >= block.labels.length && (
                        <IssueIcon
                          messages={[m.question_validation_series_values()]}
                        />
                      )}
                      <ToolbarButton
                        label={m.question_ui_remove_row_number({
                          number: row + 1,
                        })}
                        onClick={() => binding.removeChartItem('labels', label)}
                      >
                        <Icon name="trash" />
                      </ToolbarButton>
                    </td>
                    <td className="min-w-20 border border-divider">
                      <CommitCell
                        aria-label={m.question_ui_label_number({
                          number: row + 1,
                        })}
                        maxLength={limits.QUESTION_CHART_LABEL_MAX}
                        onCommit={(name) => binding.setChartName(label, name)}
                        placeholder={m.question_ui_chart_label_placeholder()}
                        value={block.labels[row] ?? ''}
                      />
                    </td>
                    {block.series.map((series, column) => (
                      <td
                        className="min-w-20 border border-divider"
                        key={seriesIds[column]}
                      >
                        <CommitCell
                          aria-label={m.question_ui_series_row({
                            name: series.name,
                            number: row + 1,
                          })}
                          max={limits.QUESTION_CHART_VALUE_MAX}
                          // Parts of a whole are never negative (Epo 2026-10-14).
                          min={single ? 0 : -limits.QUESTION_CHART_VALUE_MAX}
                          onCommit={(text) => {
                            // An empty cell is null and draws nothing; a value
                            // stops at the bounds as text stops at its length.
                            const typed = Number(text);
                            binding.setChartCell(
                              seriesIds[column],
                              label,
                              !text.trim() || Number.isNaN(typed)
                                ? null
                                : Math.min(
                                    limits.QUESTION_CHART_VALUE_MAX,
                                    Math.max(
                                      single
                                        ? 0
                                        : -limits.QUESTION_CHART_VALUE_MAX,
                                      typed
                                    )
                                  )
                            );
                          }}
                          placeholder={m.question_ui_chart_value_placeholder()}
                          type="number"
                          value={String(series.values[row] ?? '')}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3">
            <div className="-ml-4 flex flex-wrap gap-2">
              <Button
                disabled={
                  block.labels.length >= limits.QUESTION_CHART_LABELS_MAX
                }
                iconLeft="plus"
                onClick={() =>
                  binding.addChartItem('labels', rowIds.length, '')
                }
                size="sm"
                type="button"
                variant="ghost-hover"
              >
                {m.question_ui_add_row()}
              </Button>
              {/* A pie or stacked chart offers a series only when it has
               * none, and a removal only when a merge left it more than one. */}
              {(!single || block.series.length === 0) && (
                <Button
                  disabled={
                    block.series.length >= limits.QUESTION_CHART_SERIES_MAX
                  }
                  iconLeft="plus"
                  onClick={() =>
                    binding.addChartItem('series', seriesIds.length, '')
                  }
                  size="sm"
                  type="button"
                  variant="ghost-hover"
                >
                  {m.question_ui_add_column()}
                </Button>
              )}
              {(!single || block.series.length > 1) && (
                <Button
                  disabled={block.series.length <= 1}
                  onClick={() => {
                    const last = seriesIds.at(-1);
                    if (last) binding.removeChartItem('series', last);
                  }}
                  size="sm"
                  type="button"
                  variant="danger-light"
                >
                  {m.question_ui_remove_last_column()}
                </Button>
              )}
            </div>
            {/* Opens on its own when the chart already has a description. */}
            <Collapsible.Root defaultOpen={Boolean(block.description)}>
              <Collapsible.Trigger asChild>
                <Button
                  className="-ml-4"
                  iconLeft="chevronDown"
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {m.question_ui_advanced()}
                </Button>
              </Collapsible.Trigger>
              {/* Nudged under the chevron's ink, which sits inside its box. */}
              <Collapsible.Content className="translate-x-0.5 space-y-3 pt-3">
                {/* Pie and stacked charts have no gridlines. */}
                {!single && (
                  <SelectField
                    className="w-44"
                    label={m.question_ui_gridlines()}
                    onChange={(value) =>
                      binding.setFields({
                        gridlines: value as 'normal' | 'fine',
                      })
                    }
                    options={[
                      { label: m.question_ui_normal(), value: 'normal' },
                      { label: m.question_ui_fine(), value: 'fine' },
                    ]}
                    value={block.gridlines ?? 'normal'}
                  />
                )}
                <CommitField
                  count={descriptionMax}
                  label={m.question_ui_description()}
                  maxLength={descriptionMax}
                  onCommit={(text) =>
                    binding.setFields({ description: text || undefined })
                  }
                  value={block.description ?? ''}
                />
              </Collapsible.Content>
            </Collapsible.Root>
          </div>
        </div>
        <div className="min-w-0">
          {block.labels.length > 0 &&
            block.series.length > 0 &&
            block.series.every((series) =>
              series.values.every((v) => v === null || Number.isFinite(v))
            ) && <CategoryChart data={repairFigureBlock(block)} />}
        </div>
      </div>
    </div>
  );
});

type PlotKind = NonNullable<PlotBlock['kind']>;

const plotLabels = {
  line: m.question_ui_plot_line,
  scatter: m.question_ui_plot_scatter,
} satisfies Record<PlotKind, () => string>;

/** A borderless input filling a table cell, as the chart's cells are; no
 * width of its own, so a 360px dialog fits the plot's tables. */
function CellInput(props: InputProps) {
  return (
    <Input
      className="w-0 py-1.5 text-sm"
      wrapperClassName="rounded-none border-0 bg-transparent px-2 focus-within:ring-1 focus-within:ring-action-accent focus-within:ring-inset"
      {...props}
    />
  );
}

/** A chart's typed cell: its own text while typed in, written once left
 * (`useCommitted`). */
function CommitCell({
  onCommit,
  value,
  ...props
}: Omit<InputProps, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  onCommit: (text: string) => void;
  value: string;
}) {
  const { input } = useCommitted(value, onCommit);
  return <CellInput {...props} {...input} />;
}

/** A number cell: an empty cell is NaN, which the plot's issues name, until
 * a number is typed. */
function NumberCell({
  value,
  onValue,
  ...props
}: Omit<InputProps, 'value' | 'onChange' | 'type'> & {
  value: number;
  onValue: (value: number) => void;
}) {
  return (
    <CellInput
      onChange={(event) => onValue(event.target.valueAsNumber)}
      type="number"
      value={Number.isNaN(value) ? '' : value}
      {...props}
    />
  );
}

/** A table row's remove button, in the cell before its inputs. */
function RemoveCell({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <td className="w-0 pr-1">
      <ToolbarButton disabled={disabled} label={label} onClick={onClick}>
        <Icon name="trash" />
      </ToolbarButton>
    </td>
  );
}

function HeaderCell({ children }: { children?: string }) {
  return (
    <th className="border border-divider bg-surface-hover-bg p-2 text-left">
      {children}
    </th>
  );
}

/** The add buttons under a plot table: the first one's plus sits centred on
 * the table's trash column. */
function AddRow({ children }: { children: ReactNode }) {
  return (
    <div className="-ml-2.5 flex flex-wrap gap-2 sm:-ml-2.25">{children}</div>
  );
}

/** Line or scatter series of [x, y] points, in the chart editor's frame:
 * fields and tables on the left, the plot on the right once it can be drawn.
 * Reference lines and labelled points sit under Advanced. Hook-free, so its
 * test calls it and drives the inputs' handlers. */
export function PlotEditor({
  block,
  onChange,
  descriptionMax,
}: {
  block: PlotBlock;
  onChange: (block: PlotBlock) => void;
  descriptionMax: number;
}) {
  const lines = block.lines ?? [];
  const marks = block.marks ?? [];
  const setSeries = (index: number, series: PlotBlock['series'][number]) =>
    onChange({
      ...block,
      series: block.series.map((item, i) => (i === index ? series : item)),
    });
  // An emptied list leaves the block, as an agent writes one without it.
  const setLines = (next: NonNullable<PlotBlock['lines']>) =>
    onChange({ ...block, lines: next.length ? next : undefined });
  const setMarks = (next: NonNullable<PlotBlock['marks']>) =>
    onChange({ ...block, marks: next.length ? next : undefined });
  // What a merge of two editors' changes can leave (Epo 2026-10-18): series
  // past the cap, a line's series of one point. Readers skip them.
  const line = block.kind !== 'scatter';
  const seriesIssues = (series: PlotBlock['series'][number], index: number) => [
    ...(index >= limits.QUESTION_PLOT_SERIES_MAX
      ? [
          m.question_ui_plot_series_over({
            max: limits.QUESTION_PLOT_SERIES_MAX,
          }),
        ]
      : []),
    ...(line && series.points.length < 2
      ? [m.question_issue_plot_points()]
      : []),
  ];
  const drawable = [
    ...block.series.flatMap((series) => series.points.flat()),
    ...lines.map((line) => line.value),
    ...marks.flatMap((mark) => [mark.x, mark.y]),
  ].every(Number.isFinite);
  return (
    <div className="@container min-w-0">
      <div className="grid min-w-0 @4xl:grid-cols-2 items-start gap-6">
        <div className="min-w-0 space-y-4">
          <SelectField
            className="w-44"
            label={m.question_ui_plot_type()}
            onChange={(kind) => onChange({ ...block, kind: kind as PlotKind })}
            options={(['line', 'scatter'] as const).map((kind) => ({
              label: plotLabels[kind](),
              value: kind,
            }))}
            value={block.kind ?? 'line'}
          />
          <Field
            count={{
              max: limits.QUESTION_PLOT_TITLE_MAX,
              value: textLength(block.title),
            }}
            label={m.question_ui_title()}
          >
            <FieldInput
              maxLength={limits.QUESTION_PLOT_TITLE_MAX}
              onChange={(event) =>
                onChange({ ...block, title: event.target.value })
              }
              value={block.title}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['xTitle', 'yTitle', 'unit'] as const).map((key) => (
              <Field
                count={{
                  max: limits.QUESTION_PLOT_TITLE_MAX,
                  value: textLength(block[key] ?? ''),
                }}
                key={key}
                label={
                  key === 'xTitle'
                    ? m.question_ui_x_axis()
                    : key === 'yTitle'
                      ? m.question_ui_y_axis()
                      : m.question_ui_unit()
                }
              >
                <FieldInput
                  maxLength={limits.QUESTION_PLOT_TITLE_MAX}
                  onChange={(event) =>
                    onChange({
                      ...block,
                      // The unit is optional; the axis titles are not.
                      [key]:
                        key === 'unit'
                          ? event.target.value || undefined
                          : event.target.value,
                    })
                  }
                  value={block[key] ?? ''}
                />
              </Field>
            ))}
          </div>
          <div className="space-y-2">
            {block.series.map((series, index) => (
              <div className="space-y-2" key={index}>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        <RemoveCell
                          disabled={block.series.length <= 1}
                          label={m.question_ui_remove_series({
                            number: index + 1,
                          })}
                          onClick={() =>
                            onChange({
                              ...block,
                              series: block.series.filter(
                                (_, i) => i !== index
                              ),
                            })
                          }
                        />
                        <th
                          className="border border-divider bg-surface-hover-bg"
                          colSpan={2}
                        >
                          <IssueIcon messages={seriesIssues(series, index)} />
                          <CellInput
                            aria-label={m.question_ui_series_name({
                              number: index + 1,
                            })}
                            maxLength={limits.QUESTION_PLOT_LABEL_MAX}
                            onChange={(event) =>
                              setSeries(index, {
                                ...series,
                                name: event.target.value,
                              })
                            }
                            placeholder={m.question_ui_series_name({
                              number: index + 1,
                            })}
                            value={series.name}
                          />
                        </th>
                      </tr>
                      <tr>
                        <th className="w-0" />
                        <HeaderCell>{m.question_ui_plot_x()}</HeaderCell>
                        <HeaderCell>{m.question_ui_plot_y()}</HeaderCell>
                      </tr>
                    </thead>
                    <tbody>
                      {series.points.map(([x, y], row) => {
                        const setPoint = (point: [number, number]) =>
                          setSeries(index, {
                            ...series,
                            points: series.points.map((item, i) =>
                              i === row ? point : item
                            ),
                          });
                        const at = { number: row + 1, series: index + 1 };
                        return (
                          <tr key={row}>
                            {/* A series keeps one point at least. */}
                            <RemoveCell
                              disabled={series.points.length <= 1}
                              label={m.question_ui_remove_point(at)}
                              onClick={() =>
                                setSeries(index, {
                                  ...series,
                                  points: series.points.filter(
                                    (_, i) => i !== row
                                  ),
                                })
                              }
                            />
                            <td className="min-w-24 border border-divider">
                              <NumberCell
                                aria-label={m.question_ui_plot_point_x(at)}
                                onValue={(value) => setPoint([value, y])}
                                value={x}
                              />
                            </td>
                            <td className="min-w-24 border border-divider">
                              <NumberCell
                                aria-label={m.question_ui_plot_point_y(at)}
                                onValue={(value) => setPoint([x, value])}
                                value={y}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <AddRow>
                  <Button
                    disabled={
                      series.points.length >= limits.QUESTION_PLOT_POINTS_MAX
                    }
                    iconLeft="plus"
                    onClick={() => {
                      // A new point copies the row above it (Epo 2026-10-17).
                      const [x, y] = series.points.at(-1) ?? [0, 0];
                      setSeries(index, {
                        ...series,
                        points: [...series.points, [x, y]],
                      });
                    }}
                    size="sm"
                    type="button"
                    variant="ghost-hover"
                  >
                    {m.question_ui_add_point()}
                  </Button>
                </AddRow>
              </div>
            ))}
            <AddRow>
              <Button
                disabled={
                  block.series.length >= limits.QUESTION_PLOT_SERIES_MAX
                }
                iconLeft="plus"
                onClick={() =>
                  onChange({
                    ...block,
                    series: [
                      ...block.series,
                      // A line starts with the two points it needs, a
                      // scatter with one (Epo 2026-10-17).
                      {
                        name: '',
                        points:
                          block.kind === 'scatter'
                            ? [[0, 0]]
                            : [
                                [0, 0],
                                [1, 1],
                              ],
                      },
                    ],
                  })
                }
                size="sm"
                type="button"
                variant="ghost-hover"
              >
                {m.question_ui_add_series()}
              </Button>
            </AddRow>
          </div>
          {/* Opens on its own when the plot already has any of these. */}
          <Collapsible.Root
            defaultOpen={Boolean(
              block.description || lines.length || marks.length
            )}
          >
            <Collapsible.Trigger asChild>
              <Button
                className="-ml-4"
                iconLeft="chevronDown"
                size="sm"
                type="button"
                variant="ghost"
              >
                {m.question_ui_advanced()}
              </Button>
            </Collapsible.Trigger>
            {/* Nudged under the chevron's ink, which sits inside its box. */}
            <Collapsible.Content className="translate-x-0.5 space-y-4 pt-3">
              <div className="space-y-2">
                <p className="t-label">{m.question_ui_reference_lines()}</p>
                {lines.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr>
                          <th className="w-0" />
                          <HeaderCell>
                            {m.question_ui_reference_line()}
                          </HeaderCell>
                          <HeaderCell>{m.question_ui_value()}</HeaderCell>
                          <HeaderCell>{m.question_ui_label()}</HeaderCell>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((line, row) => {
                          const setLine = (next: typeof line) =>
                            setLines(
                              lines.map((item, i) => (i === row ? next : item))
                            );
                          const at = { number: row + 1 };
                          return (
                            <tr key={row}>
                              <RemoveCell
                                label={m.question_ui_remove_reference_line(at)}
                                onClick={() =>
                                  setLines(lines.filter((_, i) => i !== row))
                                }
                              />
                              <td className="border border-divider px-2">
                                {line.axis === 'y'
                                  ? m.question_ui_reference_line_horizontal()
                                  : m.question_ui_reference_line_vertical()}
                              </td>
                              <td className="min-w-16 border border-divider">
                                <NumberCell
                                  aria-label={m.question_ui_reference_line_value(
                                    at
                                  )}
                                  onValue={(value) =>
                                    setLine({ ...line, value })
                                  }
                                  value={line.value}
                                />
                              </td>
                              <td className="min-w-24 border border-divider">
                                <CellInput
                                  aria-label={m.question_ui_reference_line_label(
                                    at
                                  )}
                                  maxLength={limits.QUESTION_PLOT_LABEL_MAX}
                                  onChange={(event) =>
                                    setLine({
                                      ...line,
                                      label: event.target.value || undefined,
                                    })
                                  }
                                  value={line.label ?? ''}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <AddRow>
                  {(['y', 'x'] as const).map((axis) => (
                    <Button
                      disabled={lines.length >= limits.QUESTION_PLOT_MARKS_MAX}
                      iconLeft="plus"
                      key={axis}
                      onClick={() =>
                        // At the last value on its axis (Epo 2026-10-17).
                        setLines([
                          ...lines,
                          {
                            axis,
                            value:
                              lines.filter((line) => line.axis === axis).at(-1)
                                ?.value ?? 0,
                          },
                        ])
                      }
                      size="sm"
                      type="button"
                      variant="ghost-hover"
                    >
                      {axis === 'y'
                        ? m.question_ui_add_horizontal_line()
                        : m.question_ui_add_vertical_line()}
                    </Button>
                  ))}
                </AddRow>
              </div>
              <div className="space-y-2">
                <p className="t-label">{m.question_ui_plot_marks()}</p>
                {marks.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr>
                          <th className="w-0" />
                          <HeaderCell>{m.question_ui_plot_x()}</HeaderCell>
                          <HeaderCell>{m.question_ui_plot_y()}</HeaderCell>
                          <HeaderCell>{m.question_ui_label()}</HeaderCell>
                        </tr>
                      </thead>
                      <tbody>
                        {marks.map((mark, row) => {
                          const setMark = (next: typeof mark) =>
                            setMarks(
                              marks.map((item, i) => (i === row ? next : item))
                            );
                          const at = { number: row + 1 };
                          return (
                            <tr key={row}>
                              <RemoveCell
                                label={m.question_ui_remove_plot_mark(at)}
                                onClick={() =>
                                  setMarks(marks.filter((_, i) => i !== row))
                                }
                              />
                              <td className="min-w-16 border border-divider">
                                <NumberCell
                                  aria-label={m.question_ui_plot_mark_x(at)}
                                  onValue={(x) => setMark({ ...mark, x })}
                                  value={mark.x}
                                />
                              </td>
                              <td className="min-w-16 border border-divider">
                                <NumberCell
                                  aria-label={m.question_ui_plot_mark_y(at)}
                                  onValue={(y) => setMark({ ...mark, y })}
                                  value={mark.y}
                                />
                              </td>
                              <td className="min-w-24 border border-divider">
                                <CellInput
                                  aria-label={m.question_ui_plot_mark_label(at)}
                                  maxLength={limits.QUESTION_PLOT_LABEL_MAX}
                                  onChange={(event) =>
                                    setMark({
                                      ...mark,
                                      label: event.target.value,
                                    })
                                  }
                                  value={mark.label}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <AddRow>
                  <Button
                    disabled={marks.length >= limits.QUESTION_PLOT_MARKS_MAX}
                    iconLeft="plus"
                    onClick={() => {
                      // At the last point's place (Epo 2026-10-17).
                      const { x, y } = marks.at(-1) ?? { x: 0, y: 0 };
                      setMarks([...marks, { label: '', x, y }]);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost-hover"
                  >
                    {m.question_ui_add_plot_mark()}
                  </Button>
                </AddRow>
              </div>
              <Field
                count={{
                  max: descriptionMax,
                  value: textLength(block.description ?? ''),
                }}
                label={m.question_ui_description()}
              >
                <FieldInput
                  maxLength={descriptionMax}
                  onChange={(event) =>
                    onChange({
                      ...block,
                      description: event.target.value || undefined,
                    })
                  }
                  value={block.description ?? ''}
                />
              </Field>
            </Collapsible.Content>
          </Collapsible.Root>
        </div>
        <div className="min-w-0">{drawable && <PlotChart data={block} />}</div>
      </div>
    </div>
  );
}

/** A chart or graph its caller holds as a block (a note dialog's draft until
 * its Save), bound as its editor edits it: each change goes to `onChange` at
 * once, and a block changed from elsewhere (a peer's edit rebased in) reaches
 * the editor. None for other blocks, or when the caller binds the figure. */
function useHeldFigure(
  block: QuestionBlock,
  onChange: (block: QuestionBlock) => void,
  bound: boolean
) {
  const latest = useRef(onChange);
  latest.current = onChange;
  const [held] = useState(() =>
    !bound && (block.type === 'chart' || block.type === 'graph')
      ? localFigureBinding(block, {
          remove: () => {
            throw new Error('A held figure is removed by its holder');
          },
          write: (next) => latest.current(next),
        })
      : null
  );
  useLayoutEffect(() => {
    if (held && (block.type === 'chart' || block.type === 'graph'))
      held.receive(block);
  }, [block, held]);
  return held;
}

export function BlockEditor({
  bank,
  binding,
  block,
  editPlot,
  onChange,
  uploadAsset,
  onBusyChange,
  onInvalidChange,
  textPlaceholder,
  toolbarTarget,
  gaps,
}: {
  /** A bank question: figure descriptions take the bank's longer bound. */
  bank?: boolean;
  /** Where a chart or graph lives, edited a change at a time; without one
   * its changes go to `onChange`. */
  binding?: FigureBinding;
  block: QuestionBlock;
  /** Notes edit a plot; quizzes show it (the catalog's plot `edit.user`). */
  editPlot?: boolean;
  onChange: (block: QuestionBlock) => void;
  uploadAsset?: UploadQuestionAsset;
  onBusyChange?: (busy: boolean) => void;
  /** Graph rows that cannot be drawn; a note dialog holds Save meanwhile. */
  onInvalidChange?: (invalid: boolean) => void;
  /** What an empty text block shows, by where it sits. */
  textPlaceholder?: string;
  /** The block's heading row: a graph's zoom tools and a table cell's
   * formula tools go there. */
  toolbarTarget?: HTMLElement | null;
  /** A gaps part's text block: the number of its first blank, its blanks'
   * accepted answers in order, and a change of either. */
  gaps?: {
    start: number;
    lists: string[][];
    onChange: (text: string, lists: string[][]) => void;
  };
}) {
  // The text's blanks by id, in order, as the editor read them in; each
  // change carries every list along with its blank.
  const blankIds = useRef<string[] | null>(null);
  if (gaps && block.type === 'text')
    blankIds.current ??= gapNumbers([block]).map((_, i) => `g${i}`);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  // Closing the editor cancels a picked image still waiting to upload.
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => uploadAbort.current?.abort(), []);
  const held = useHeldFigure(block, onChange, Boolean(binding));
  /** The chart or graph being edited: the caller's, else the held one. */
  const figure = () => {
    const bound = binding ?? held;
    if (!bound) throw new Error('A chart or graph editor without its figure');
    return bound;
  };
  const descriptionMax = bank
    ? limits.QUESTION_TEXT_MAX
    : limits.QUESTION_DESCRIPTION_MAX;
  if (block.type === 'text')
    return (
      <div className="space-y-3">
        <TextEditor
          gapStart={gaps?.start}
          maxLength={limits.QUESTION_TEXT_MAX}
          onChange={(text, ids) => {
            if (!gaps) return onChange({ ...block, text });
            const before = blankIds.current ?? [];
            const used = new Set<number>();
            const lists = ids.map((id) => {
              const at = before.indexOf(id);
              if (at < 0 || used.has(at)) return [''];
              used.add(at);
              return gaps.lists[at] ?? [''];
            });
            blankIds.current = ids;
            gaps.onChange(text, lists);
          }}
          placeholder={textPlaceholder}
          value={block.text}
        />
        {/* Each blank's accepted answers, under the text that holds it. */}
        {gaps?.lists.map((list, i) => (
          <StringList
            addLabel={m.question_ui_add_accepted_answer()}
            className="max-w-md"
            key={blankIds.current?.[i] ?? i}
            label={m.question_ui_gap({ number: gaps.start + i })}
            onChange={(values) =>
              gaps.onChange(
                block.text,
                gaps.lists.map((item, j) => (j === i ? values : item))
              )
            }
            values={list}
          />
        ))}
        <div className="pt-2">
          <p className="t-label mb-3 text-fg-muted">
            {m.question_ui_preview()}
          </p>
          <QuestionBlockView block={block} />
        </div>
      </div>
    );
  if (block.type === 'chart')
    return <ChartEditor binding={figure()} descriptionMax={descriptionMax} />;
  if (block.type === 'plot')
    return editPlot ? (
      <PlotEditor
        block={block}
        descriptionMax={descriptionMax}
        onChange={onChange}
      />
    ) : (
      <QuestionBlockView block={block} />
    );
  if (block.type === 'graph')
    return (
      <GraphEditor
        binding={figure()}
        descriptionMax={descriptionMax}
        onInvalidChange={onInvalidChange}
        toolbarTarget={toolbarTarget}
      />
    );
  if (block.type === 'image')
    return (
      <div className="space-y-4">
        {/* A preview, not the shown size: capped, from the left edge. */}
        <div className="[&_figure]:mx-0 [&_img]:max-h-80 [&_img]:w-auto">
          <QuestionBlockView block={block} />
        </div>
        <Field label={m.question_ui_image_file()}>
          <input
            accept={IMAGE_ACCEPT}
            disabled={!uploadAsset || uploading}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file || !uploadAsset) return;
              setUploading(true);
              onBusyChange?.(true);
              setError('');
              uploadAbort.current?.abort();
              const controller = new AbortController();
              uploadAbort.current = controller;
              const local = URL.createObjectURL(file);
              try {
                const image = new Image();
                image.src = local;
                await image.decode();
                onChange({
                  ...block,
                  height: image.naturalHeight,
                  image: await uploadAsset(file, controller.signal),
                  width: image.naturalWidth,
                });
              } catch (error) {
                if (!controller.signal.aborted)
                  setError(errorCopy(error, m.question_ui_upload_failed()));
              } finally {
                URL.revokeObjectURL(local);
                setUploading(false);
                onBusyChange?.(false);
              }
            }}
            type="file"
          />
        </Field>
        {uploading && <p role="status">{m.question_ui_uploading()}</p>}
        {error && (
          <p className="text-solid-error" role="alert">
            {error}
          </p>
        )}
        <Field
          count={{
            max: descriptionMax,
            value: textLength(block.description),
          }}
          label={m.question_ui_description()}
        >
          <FieldInput
            maxLength={descriptionMax}
            onChange={(event) =>
              onChange({ ...block, description: event.target.value })
            }
            value={block.description ?? ''}
          />
        </Field>
        <Field
          count={{
            max: limits.QUESTION_METADATA_MAX,
            value: textLength(block.attribution),
          }}
          label={m.question_ui_attribution()}
        >
          <FieldInput
            maxLength={limits.QUESTION_METADATA_MAX}
            onChange={(event) =>
              onChange({
                ...block,
                attribution: event.target.value || undefined,
              })
            }
            value={block.attribution ?? ''}
          />
        </Field>
      </div>
    );
  return (
    <TableBlockEditor
      block={block}
      onChange={onChange}
      toolbarTarget={toolbarTarget}
    />
  );
}

/**
 * A question's table block drawn as a note's table (Epo 2026-11-15, the Plate
 * table, mock T2): a row's pill at its left drags the row and opens Insert
 * above, Insert below and Delete; a column's pill over its first cell opens
 * Insert left, Insert right and Delete; + bars along the right edge and under
 * the last row add one at the end. Header row sits with the cell's formula
 * tools in the block's heading row (else a row of their own), as in the note's
 * table bar; the tools show disabled until a cell opens, so opening one shifts
 * nothing.
 */
function TableBlockEditor({
  block,
  onChange,
  toolbarTarget,
}: {
  block: Extract<QuestionBlock, { type: 'table' }>;
  onChange: (block: QuestionBlock) => void;
  toolbarTarget?: HTMLElement | null;
}) {
  const [cell, setCell] = useState<string | null>(null);
  // Where the click that opened the cell landed (none from the keyboard).
  const cellClick = useRef<(() => { x: number; y: number }) | null>(null);
  const [ownTools, setOwnTools] = useState<HTMLDivElement | null>(null);
  const [formulaTools, setFormulaTools] = useState<HTMLSpanElement | null>(
    null
  );
  // The column under the pointer, whose pill shows over its first cell.
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  // A row being dragged by its pill, and where it would go.
  const [drag, setDrag] = useState<{
    from: number;
    over: number;
    side: 'bottom' | 'top';
  } | null>(null);
  const columns = block.rows[0]?.length ?? 1;
  const rowsFull = block.rows.length >= limits.QUESTION_TABLE_ROWS_MAX;
  const columnsFull = columns >= limits.QUESTION_TABLE_COLUMNS_MAX;
  const updateCell = (row: number, column: number, text: string) =>
    onChange({
      ...block,
      rows: block.rows.map((cells, i) =>
        i === row
          ? cells.map((value, j) => (j === column ? text : value))
          : cells
      ),
    });
  // Rows and columns move under an open cell: it closes first.
  const change = (rows: string[][]) => {
    setCell(null);
    onChange({ ...block, rows });
  };
  const insertRow = (at: number) =>
    change([
      ...block.rows.slice(0, at),
      Array.from({ length: columns }, () => ''),
      ...block.rows.slice(at),
    ]);
  const insertColumn = (at: number) =>
    change(
      block.rows.map((row) => [...row.slice(0, at), '', ...row.slice(at)])
    );
  const moveRow = (from: number, to: number) => {
    const rows = [...block.rows];
    const [row] = rows.splice(from, 1);
    rows.splice(to > from ? to - 1 : to, 0, row);
    change(rows);
  };
  const tools = toolbarTarget ?? ownTools;
  const plusBar =
    'absolute flex items-center justify-center rounded-(--radius-toolbar-button) bg-surface-hover-bg text-fg-muted opacity-0 outline-none transition-opacity hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-action disabled:hidden group-focus-within/table:opacity-100 group-hover/table:opacity-100';
  return (
    <div>
      {!toolbarTarget && (
        <div className="flex items-center" ref={setOwnTools} />
      )}
      {tools &&
        createPortal(
          <>
            <span className="contents" ref={setFormulaTools} />
            {cell === null &&
              formulaTools &&
              createPortal(<IdleFormulaTools />, formulaTools)}
            <ToolbarGroup>
              <ToolbarButton
                active={!!block.header}
                className="w-auto gap-1.5 px-1.5"
                label={m.question_ui_header_row()}
                onClick={() => onChange({ ...block, header: !block.header })}
              >
                <EditorIcon name="table" />
                {m.question_ui_header_row()}
              </ToolbarButton>
            </ToolbarGroup>
          </>,
          tools
        )}
      {/* Room for the column pills above, the + bars right and below. */}
      <div className="overflow-x-auto pt-2 pr-5 pb-5">
        <div
          className="group/table relative w-fit"
          onMouseLeave={() => setHoveredColumn(null)}
          onMouseOver={(event) => {
            const column = (event.target as Element)
              .closest?.('[data-table-column]')
              ?.getAttribute('data-table-column');
            if (column != null) setHoveredColumn(Number(column));
          }}
        >
          <table className="border-collapse text-sm">
            <tbody>
              {block.rows.map((row, i) => (
                <tr
                  className={cn(
                    'group/row',
                    drag?.from === i && 'opacity-45',
                    drag?.over === i &&
                      drag.from !== i &&
                      (drag.side === 'top'
                        ? '[&>td]:border-t-2! [&>td]:border-t-action-accent!'
                        : '[&>td]:border-b-2! [&>td]:border-b-action-accent!')
                  )}
                  key={i}
                  onDragOver={(event) => {
                    if (!drag) return;
                    event.preventDefault();
                    const box = event.currentTarget.getBoundingClientRect();
                    const side =
                      event.clientY < box.top + box.height / 2
                        ? 'top'
                        : 'bottom';
                    if (drag.over !== i || drag.side !== side)
                      setDrag({ ...drag, over: i, side });
                  }}
                  onDrop={(event) => {
                    if (!drag) return;
                    event.preventDefault();
                    const to = drag.side === 'top' ? i : i + 1;
                    if (to !== drag.from && to !== drag.from + 1)
                      moveRow(drag.from, to);
                    setDrag(null);
                  }}
                >
                  <td className="relative w-2 min-w-2 max-w-2 select-none p-0">
                    {/* The row's pill: a drag moves the row, a press opens
                        its menu. */}
                    <TableHandle
                      className="top-1/2 left-0 h-7 w-4 -translate-y-1/2 cursor-grab active:cursor-grabbing group-focus-within/row:opacity-100 group-hover/row:opacity-100"
                      handleProps={{
                        draggable: true,
                        onDragEnd: () => setDrag(null),
                        onDragStart: (event) => {
                          event.dataTransfer.effectAllowed = 'move';
                          setDrag({ from: i, over: i, side: 'top' });
                        },
                      }}
                      icon="moreVertical"
                      label={m.editor_row()}
                      side="right"
                    >
                      <BlockMenuItem
                        disabled={rowsFull}
                        icon="arrowUp"
                        label={m.editor_insert_row_before()}
                        onSelect={() => insertRow(i)}
                      />
                      <BlockMenuItem
                        disabled={rowsFull}
                        icon="arrowDown"
                        label={m.editor_insert_row_after()}
                        onSelect={() => insertRow(i + 1)}
                      />
                      <DropdownMenuSeparator />
                      <BlockMenuItem
                        disabled={block.rows.length <= 1}
                        icon="trash"
                        label={m.editor_delete_row()}
                        onSelect={() =>
                          change(block.rows.filter((_, j) => j !== i))
                        }
                      />
                    </TableHandle>
                  </td>
                  {row.map((text, j) => {
                    const id = `${i}:${j}`;
                    const header = block.header && i === 0;
                    // What an empty cell is for, until it holds text.
                    const placeholder = header
                      ? m.question_ui_table_heading_placeholder()
                      : m.question_ui_table_cell_placeholder();
                    return (
                      <td
                        className={cn(
                          'relative border border-line p-0 align-top',
                          header && 'bg-surface-hover-bg font-semibold'
                        )}
                        data-table-column={j}
                        key={j}
                      >
                        {/* Columns grow with their text between these
                            widths, then wrap. */}
                        <div className="min-h-12 min-w-28 max-w-80 px-2 py-1.5 sm:px-3 sm:py-2">
                          {cell === id ? (
                            <TextEditor
                              caretAt={cellClick.current}
                              compact
                              maxLength={limits.QUESTION_TEXT_MAX}
                              onChange={(value) => updateCell(i, j, value)}
                              placeholder={placeholder}
                              toolbarTarget={formulaTools}
                              value={text}
                            />
                          ) : (
                            <button
                              aria-label={m.question_ui_edit_cell({
                                column: j + 1,
                                row: i + 1,
                              })}
                              className="min-h-8 w-full cursor-text text-left"
                              onClick={(event) => {
                                cellClick.current =
                                  event.detail &&
                                  event.currentTarget.parentElement
                                    ? clickPoint(
                                        event,
                                        event.currentTarget.parentElement
                                      )
                                    : null;
                                setCell(id);
                              }}
                              type="button"
                            >
                              {text.trim() ? (
                                <QuestionBlockView
                                  block={{ text, type: 'text' }}
                                />
                              ) : (
                                <p className="font-normal text-placeholder leading-relaxed">
                                  {placeholder}
                                </p>
                              )}
                            </button>
                          )}
                        </div>
                        {i === 0 && (
                          <TableHandle
                            className={cn(
                              '-top-2 left-1/2 h-4 w-7 -translate-x-1/2 group-focus-within/table:opacity-100',
                              hoveredColumn === j && 'opacity-100'
                            )}
                            icon="moreHorizontal"
                            label={m.editor_column()}
                            side="bottom"
                          >
                            <BlockMenuItem
                              disabled={columnsFull}
                              icon="arrowLeft"
                              label={m.editor_insert_col_before()}
                              onSelect={() => insertColumn(j)}
                            />
                            <BlockMenuItem
                              disabled={columnsFull}
                              icon="arrowRight"
                              label={m.editor_insert_col_after()}
                              onSelect={() => insertColumn(j + 1)}
                            />
                            <DropdownMenuSeparator />
                            <BlockMenuItem
                              disabled={columns <= 1}
                              icon="trash"
                              label={m.editor_delete_col()}
                              onSelect={() =>
                                change(
                                  block.rows.map((cells) =>
                                    cells.filter((_, k) => k !== j)
                                  )
                                )
                              }
                            />
                          </TableHandle>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <button
            aria-label={m.editor_insert_col_after()}
            className={cn(plusBar, 'top-0 bottom-0 left-full ml-1 w-4')}
            disabled={columnsFull}
            onClick={() => insertColumn(columns)}
            title={m.editor_insert_col_after()}
            type="button"
          >
            <EditorIcon className="size-3.5" name="plus" />
          </button>
          <button
            aria-label={m.editor_insert_row_after()}
            className={cn(plusBar, 'top-full right-0 left-2 mt-0.5 h-4')}
            disabled={rowsFull}
            onClick={() => insertRow(block.rows.length)}
            title={m.editor_insert_row_after()}
            type="button"
          >
            <EditorIcon className="size-3.5" name="plus" />
          </button>
        </div>
      </div>
    </div>
  );
}
