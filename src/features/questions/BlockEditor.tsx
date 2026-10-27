import { Collapsible } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as limits from '@/api/limits.generated';
import { CategoryChart } from '@/components/charts/CategoryChart';
import { PlotChart } from '@/components/charts/PlotChart';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input, type InputProps } from '@/components/ui/Input';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { IMAGE_ACCEPT } from '@/lib/fitImage';
import { textLength } from '@/lib/textLength';
import { Field, FieldInput, SelectField, StringList } from './editorFields';
import { GraphEditor } from './GraphEditor';
import { IssueIcon } from './IssueViews';
import { QuestionBlockView } from './QuestionView';
import { repairFigureBlock } from './repair';
import { IdleFormulaTools, TextEditor } from './TextEditor';
import {
  CHART_KINDS,
  type ChartBlock,
  type ChartKind,
  gapNumbers,
  type PlotBlock,
  type QuestionBlock,
} from './types';

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

function ChartEditor({
  block,
  onChange,
  descriptionMax,
}: {
  block: ChartBlock;
  onChange: (block: ChartBlock) => void;
  /** The description's bound: the bank's longer one or everyone else's. */
  descriptionMax: number;
}) {
  const single = block.kind === 'pie' || block.kind === 'stacked';
  // A merge of two editors' changes (Epo 2026-10-17) can leave values past
  // the labels or series past the cap: the table shows them with their
  // issue, readers the repaired chart.
  const rows = Math.max(
    block.labels.length,
    ...block.series.map((series) => series.values.length)
  );
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
  const setCell = <T,>(list: T[], at: number, value: T, empty: T) =>
    Array.from({ length: Math.max(list.length, at + 1) }, (_, i) =>
      i === at ? value : (list[i] ?? empty)
    );
  return (
    // Two columns only once the editor itself is wide enough for the table.
    <div className="@container min-w-0">
      <div className="grid min-w-0 @4xl:grid-cols-2 items-start gap-6">
        <div className="min-w-0 space-y-4">
          <SelectField
            className="w-44"
            label={m.question_ui_chart_type()}
            onChange={(kind) =>
              onChange(
                kind === 'pie' || kind === 'stacked'
                  ? // Parts of one whole: one series and no axes.
                    {
                      ...block,
                      kind,
                      series: block.series.slice(0, 1),
                      xTitle: undefined,
                      yTitle: undefined,
                    }
                  : { ...block, kind: kind as ChartKind }
              )
            }
            options={CHART_KINDS.map((kind) => ({
              label: chartLabels[kind](),
              value: kind,
            }))}
            value={block.kind}
          />
          <Field
            count={{
              max: limits.QUESTION_CHART_TITLE_MAX,
              value: textLength(block.title),
            }}
            label={m.question_ui_title()}
          >
            <FieldInput
              maxLength={limits.QUESTION_CHART_TITLE_MAX}
              onChange={(event) =>
                onChange({ ...block, title: event.target.value })
              }
              value={block.title}
            />
          </Field>
          {!single && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(['xTitle', 'yTitle'] as const).map((key) => (
                <Field
                  count={{
                    max: limits.QUESTION_CHART_TITLE_MAX,
                    value: textLength(block[key]),
                  }}
                  key={key}
                  label={
                    key === 'xTitle'
                      ? m.question_ui_x_axis()
                      : m.question_ui_y_axis()
                  }
                >
                  <FieldInput
                    maxLength={limits.QUESTION_CHART_TITLE_MAX}
                    onChange={(event) =>
                      onChange({ ...block, [key]: event.target.value })
                    }
                    value={block[key] ?? ''}
                  />
                </Field>
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
                      key={i}
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
                      <CellInput
                        aria-label={m.question_ui_series_name({
                          number: i + 1,
                        })}
                        maxLength={limits.QUESTION_CHART_SERIES_NAME_MAX}
                        onChange={(event) =>
                          onChange({
                            ...block,
                            series: block.series.map((item, j) =>
                              i === j
                                ? { ...item, name: event.target.value }
                                : item
                            ),
                          })
                        }
                        placeholder={m.question_ui_chart_series_placeholder()}
                        value={series.name}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rows }, (_, row) => (
                  <tr key={row}>
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
                        onClick={() =>
                          onChange({
                            ...block,
                            labels: block.labels.filter((_, i) => row !== i),
                            series: block.series.map((item) => ({
                              ...item,
                              values: item.values.filter((_, i) => row !== i),
                            })),
                          })
                        }
                      >
                        <Icon name="trash" />
                      </ToolbarButton>
                    </td>
                    <td className="min-w-20 border border-divider">
                      <CellInput
                        aria-label={m.question_ui_label_number({
                          number: row + 1,
                        })}
                        maxLength={limits.QUESTION_CHART_LABEL_MAX}
                        onChange={(event) =>
                          onChange({
                            ...block,
                            labels: setCell(
                              block.labels,
                              row,
                              event.target.value,
                              ''
                            ),
                          })
                        }
                        placeholder={m.question_ui_chart_label_placeholder()}
                        value={block.labels[row] ?? ''}
                      />
                    </td>
                    {block.series.map((series, column) => (
                      <td
                        className="min-w-20 border border-divider"
                        key={column}
                      >
                        <CellInput
                          aria-label={m.question_ui_series_row({
                            name: series.name,
                            number: row + 1,
                          })}
                          max={limits.QUESTION_CHART_VALUE_MAX}
                          // Parts of a whole are never negative (Epo 2026-10-14).
                          min={single ? 0 : -limits.QUESTION_CHART_VALUE_MAX}
                          onChange={(event) => {
                            // An empty cell is null and draws nothing; a value
                            // stops at the bounds as text stops at its length.
                            const typed = event.target.valueAsNumber;
                            const value = Number.isNaN(typed)
                              ? null
                              : Math.min(
                                  limits.QUESTION_CHART_VALUE_MAX,
                                  Math.max(
                                    single
                                      ? 0
                                      : -limits.QUESTION_CHART_VALUE_MAX,
                                    typed
                                  )
                                );
                            onChange({
                              ...block,
                              series: block.series.map((item, i) =>
                                column === i
                                  ? {
                                      ...item,
                                      values: setCell<number | null>(
                                        item.values,
                                        row,
                                        value,
                                        null
                                      ),
                                    }
                                  : item
                              ),
                            });
                          }}
                          placeholder={m.question_ui_chart_value_placeholder()}
                          type="number"
                          value={series.values[row] ?? ''}
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
                  onChange({
                    ...block,
                    labels: [...block.labels, ''],
                    series: block.series.map((item) => ({
                      ...item,
                      values: [...item.values, null],
                    })),
                  })
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
                    onChange({
                      ...block,
                      series: [
                        ...block.series,
                        { name: '', values: block.labels.map(() => null) },
                      ],
                    })
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
                  onClick={() =>
                    onChange({ ...block, series: block.series.slice(0, -1) })
                  }
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
                      onChange({
                        ...block,
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
}

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

export function BlockEditor({
  bank,
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
  block: QuestionBlock;
  /** Notes edit a plot; quizzes show it (the catalog's plot `edit.user`). */
  editPlot?: boolean;
  onChange: (block: QuestionBlock) => void;
  uploadAsset?: UploadQuestionAsset;
  onBusyChange?: (busy: boolean) => void;
  /** Graph rows that cannot be drawn; the dialog holds Save meanwhile. */
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
  const [cell, setCell] = useState<string | null>(null);
  // The text's blanks by id, in order, as the editor read them in; each
  // change carries every list along with its blank.
  const blankIds = useRef<string[] | null>(null);
  if (gaps && block.type === 'text')
    blankIds.current ??= gapNumbers([block]).map((_, i) => `g${i}`);
  // Where the click that opened the cell landed (none from the keyboard).
  const cellClick = useRef<{ x: number; y: number } | null>(null);
  const [cellTools, setCellTools] = useState<HTMLDivElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  // Closing the editor cancels a picked image still waiting to upload.
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => uploadAbort.current?.abort(), []);
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
        <Collapsible.Root>
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
          <Collapsible.Content className="max-w-sm pt-3">
            <Field
              count={{
                max: limits.QUESTION_METADATA_MAX,
                value: textLength(block.label),
              }}
              label={m.question_ui_paragraph_label()}
            >
              <FieldInput
                maxLength={limits.QUESTION_METADATA_MAX}
                onChange={(event) =>
                  onChange({ ...block, label: event.target.value || undefined })
                }
                value={block.label ?? ''}
              />
            </Field>
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
    );
  if (block.type === 'chart')
    return (
      <ChartEditor
        block={block}
        descriptionMax={descriptionMax}
        onChange={onChange}
      />
    );
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
        descriptionMax={descriptionMax}
        onChange={onChange}
        onInvalidChange={onInvalidChange}
        toolbarTarget={toolbarTarget}
        value={block}
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
  const columns = block.rows[0]?.length ?? 1;
  const updateCell = (row: number, column: number, text: string) =>
    onChange({
      ...block,
      rows: block.rows.map((cells, i) =>
        i === row
          ? cells.map((value, j) => (j === column ? text : value))
          : cells
      ),
    });
  // The chart's data table: a trash per row, Add row and column below, the
  // header row under Advanced. A cell's formula tools go to the block's
  // heading row, else a row of their own; they show disabled until a cell
  // opens, so opening one shifts nothing.
  const tools = toolbarTarget ?? cellTools;
  return (
    <div className="space-y-3">
      {!toolbarTarget && (
        <div className="flex items-center" ref={setCellTools} />
      )}
      {cell === null && tools && createPortal(<IdleFormulaTools />, tools)}
      <div className="overflow-x-auto">
        <table className="border-collapse text-sm">
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                <td className="w-0 whitespace-nowrap pr-1">
                  <ToolbarButton
                    disabled={block.rows.length <= 1}
                    label={m.question_ui_remove_row_number({ number: i + 1 })}
                    onClick={() => {
                      setCell(null);
                      onChange({
                        ...block,
                        rows: block.rows.filter((_, j) => i !== j),
                      });
                    }}
                  >
                    <Icon name="trash" />
                  </ToolbarButton>
                </td>
                {row.map((text, j) => {
                  const id = `${i}:${j}`;
                  // What an empty cell is for, until it holds text.
                  const placeholder =
                    block.header && i === 0
                      ? m.question_ui_table_heading_placeholder()
                      : m.question_ui_table_cell_placeholder();
                  return (
                    <td
                      className={cn(
                        'border border-divider p-0 align-top',
                        block.header &&
                          i === 0 &&
                          'bg-surface-hover-bg font-semibold'
                      )}
                      key={j}
                    >
                      {/* Columns grow with their text between these widths,
                          then wrap. */}
                      <div className="min-w-28 max-w-80 px-2 py-1.5">
                        {cell === id ? (
                          <TextEditor
                            caretAt={cellClick.current}
                            compact
                            maxLength={limits.QUESTION_TEXT_MAX}
                            onChange={(value) => updateCell(i, j, value)}
                            placeholder={placeholder}
                            toolbarTarget={tools}
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
                              cellClick.current = event.detail
                                ? { x: event.clientX, y: event.clientY }
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
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="-ml-4 flex flex-wrap gap-2">
        <Button
          disabled={block.rows.length >= limits.QUESTION_TABLE_ROWS_MAX}
          iconLeft="plus"
          onClick={() =>
            onChange({
              ...block,
              rows: [...block.rows, Array.from({ length: columns }, () => '')],
            })
          }
          size="sm"
          type="button"
          variant="ghost-hover"
        >
          {m.question_ui_add_row()}
        </Button>
        <Button
          disabled={columns >= limits.QUESTION_TABLE_COLUMNS_MAX}
          iconLeft="plus"
          onClick={() =>
            onChange({ ...block, rows: block.rows.map((row) => [...row, '']) })
          }
          size="sm"
          type="button"
          variant="ghost-hover"
        >
          {m.question_ui_add_column()}
        </Button>
        <Button
          disabled={columns <= 1}
          onClick={() => {
            setCell(null);
            onChange({
              ...block,
              rows: block.rows.map((row) => row.slice(0, -1)),
            });
          }}
          size="sm"
          type="button"
          variant="danger-light"
        >
          {m.question_ui_remove_last_column()}
        </Button>
      </div>
      <Collapsible.Root>
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
        <Collapsible.Content className="translate-x-0.5 pt-3">
          <SelectField
            className="w-44"
            label={m.question_ui_header_row()}
            onChange={(value) =>
              onChange({ ...block, header: value === 'shown' })
            }
            options={[
              { label: m.question_ui_graph_shown(), value: 'shown' },
              { label: m.question_ui_graph_hidden(), value: 'hidden' },
            ]}
            value={block.header ? 'shown' : 'hidden'}
          />
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );
}
