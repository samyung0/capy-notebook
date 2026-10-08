import { Collapsible } from 'radix-ui';
import { useState } from 'react';
import * as limits from '@/api/limits.generated';
import { CategoryChart } from '@/components/charts/CategoryChart';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Toolbar, ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { IMAGE_ACCEPT } from '@/features/quizzes/quizImage';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { textLength } from '@/lib/textLength';
import { Field, SelectField } from './editorFields';
import { GraphEditor } from './GraphEditor';
import { QuestionBlockView } from './QuestionView';
import { TextEditor } from './TextEditor';
import type { ChartBlock, QuestionBlock } from './types';

/** Bank uploads return a public URL; quiz uploads return a workspace editor asset. */
export type UploadQuestionAsset = (
  file: File
) => Promise<{ url: string } | { assetId: string }>;

const chartLabels = {
  area: m.question_ui_area_chart,
  bar: m.question_ui_bar_chart,
  hbar: m.question_ui_horizontal_bar_chart,
  line: m.question_ui_line_chart,
  pie: m.question_ui_pie_chart,
  stacked: m.question_ui_stacked_chart,
};

function ChartEditor({
  block,
  onChange,
}: {
  block: ChartBlock;
  onChange: (block: ChartBlock) => void;
}) {
  const single = block.kind === 'pie' || block.kind === 'stacked';
  return (
    <div className="grid min-w-0 items-start gap-6 md:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <SelectField
          label={m.question_ui_chart_type()}
          onChange={(kind) =>
            onChange({
              ...block,
              kind: kind as ChartBlock['kind'],
              series:
                kind === 'pie' || kind === 'stacked'
                  ? block.series.slice(0, 1)
                  : block.series,
            })
          }
          options={(
            ['bar', 'hbar', 'line', 'area', 'pie', 'stacked'] as const
          ).map((kind) => ({ label: chartLabels[kind](), value: kind }))}
          value={block.kind}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['title', 'unit', 'xTitle', 'yTitle'] as const).map((key) => (
            <Field
              count={{
                max: limits.QUESTION_METADATA_MAX,
                value: textLength(block[key]),
              }}
              key={key}
              label={
                {
                  title: m.question_ui_title(),
                  unit: m.question_ui_unit(),
                  xTitle: m.question_ui_x_axis_title(),
                  yTitle: m.question_ui_y_axis_title(),
                }[key]
              }
            >
              <Input
                onChange={(event) =>
                  onChange({ ...block, [key]: event.target.value })
                }
                value={block[key] ?? ''}
              />
            </Field>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface-hover-bg">
              <tr>
                <th className="border border-divider p-2 text-left">
                  {m.question_ui_label()}
                </th>
                {block.series.map((series, i) => (
                  <th className="min-w-24 border border-divider" key={i}>
                    <Input
                      aria-label={m.question_ui_series_name({ number: i + 1 })}
                      className="py-1.5 text-sm"
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
                      value={series.name}
                      wrapperClassName="rounded-none border-0 bg-transparent px-2 focus-within:ring-1 focus-within:ring-action-accent focus-within:ring-inset"
                    />
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {block.labels.map((label, row) => (
                <tr key={row}>
                  <td className="min-w-24 border border-divider">
                    <Input
                      aria-label={m.question_ui_label_number({
                        number: row + 1,
                      })}
                      className="py-1.5 text-sm"
                      onChange={(event) =>
                        onChange({
                          ...block,
                          labels: block.labels.map((item, i) =>
                            i === row ? event.target.value : item
                          ),
                        })
                      }
                      value={label}
                      wrapperClassName="rounded-none border-0 bg-transparent px-2 focus-within:ring-1 focus-within:ring-action-accent focus-within:ring-inset"
                    />
                  </td>
                  {block.series.map((series, column) => (
                    <td className="border border-divider" key={column}>
                      <Input
                        aria-label={m.question_ui_series_row({
                          name: series.name,
                          number: row + 1,
                        })}
                        className="py-1.5 text-sm"
                        onChange={(event) =>
                          onChange({
                            ...block,
                            series: block.series.map((item, i) =>
                              column === i
                                ? {
                                    ...item,
                                    values: item.values.map((number, j) =>
                                      row === j
                                        ? event.target.valueAsNumber
                                        : number
                                    ),
                                  }
                                : item
                            ),
                          })
                        }
                        type="number"
                        value={
                          Number.isFinite(series.values[row])
                            ? series.values[row]
                            : ''
                        }
                        wrapperClassName="rounded-none border-0 bg-transparent px-2 focus-within:ring-1 focus-within:ring-action-accent focus-within:ring-inset"
                      />
                    </td>
                  ))}
                  <td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={block.labels.length >= 50}
            iconLeft="plus"
            onClick={() =>
              onChange({
                ...block,
                labels: [...block.labels, ''],
                series: block.series.map((item) => ({
                  ...item,
                  values: [...item.values, 0],
                })),
              })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {m.question_ui_add_row()}
          </Button>
          {!single && (
            <>
              <Button
                disabled={block.series.length >= 8}
                iconLeft="plus"
                onClick={() =>
                  onChange({
                    ...block,
                    series: [
                      ...block.series,
                      { name: '', values: block.labels.map(() => 0) },
                    ],
                  })
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                {m.question_ui_add_series()}
              </Button>
              <Button
                disabled={block.series.length <= 1}
                onClick={() =>
                  onChange({ ...block, series: block.series.slice(0, -1) })
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                {m.question_ui_remove_last_series()}
              </Button>
            </>
          )}
        </div>
        <Collapsible.Root>
          <Collapsible.Trigger asChild>
            <Button
              iconLeft="chevronDown"
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.question_ui_advanced()}
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content className="space-y-3 pt-3">
            <SelectField
              label={m.question_ui_gridlines()}
              onChange={(value) =>
                onChange({ ...block, gridlines: value as 'normal' | 'fine' })
              }
              options={[
                { label: m.question_ui_normal(), value: 'normal' },
                { label: m.question_ui_fine(), value: 'fine' },
              ]}
              value={block.gridlines ?? 'normal'}
            />
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
      <div className="min-w-0">
        <p className="t-label text-fg-muted">{m.question_ui_preview()}</p>
        {block.labels.length > 0 &&
          block.series.length > 0 &&
          block.series.every((series) =>
            series.values.every(Number.isFinite)
          ) && <CategoryChart data={block} />}
      </div>
    </div>
  );
}

export function BlockEditor({
  block,
  onChange,
  uploadAsset,
  onBusyChange,
}: {
  block: QuestionBlock;
  onChange: (block: QuestionBlock) => void;
  uploadAsset?: UploadQuestionAsset;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [cell, setCell] = useState<string | null>(null);
  const [cellTools, setCellTools] = useState<HTMLDivElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  if (block.type === 'text')
    return (
      <div className="space-y-3">
        <TextEditor
          onChange={(text) => onChange({ ...block, text })}
          value={block.text}
        />
        <div className="border-divider border-t pt-4">
          <p className="t-label mb-3 text-fg-muted">
            {m.question_ui_preview()}
          </p>
          <QuestionBlockView block={block} />
        </div>
        <Collapsible.Root>
          <Collapsible.Trigger asChild>
            <Button
              iconLeft="chevronDown"
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.question_ui_advanced()}
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content className="pt-3">
            <Field
              count={{
                max: limits.QUESTION_METADATA_MAX,
                value: textLength(block.label),
              }}
              label={m.question_ui_paragraph_label()}
            >
              <Input
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
    return <ChartEditor block={block} onChange={onChange} />;
  if (block.type === 'graph')
    return <GraphEditor onChange={onChange} value={block} />;
  if (block.type === 'image')
    return (
      <div className="space-y-4">
        <QuestionBlockView block={block} />
        <Field label={m.question_ui_replace()}>
          <input
            accept={IMAGE_ACCEPT}
            disabled={!uploadAsset || uploading}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file || !uploadAsset) return;
              setUploading(true);
              onBusyChange?.(true);
              setError('');
              const local = URL.createObjectURL(file);
              try {
                const image = new Image();
                image.src = local;
                await image.decode();
                onChange({
                  ...block,
                  height: image.naturalHeight,
                  image: await uploadAsset(file),
                  width: image.naturalWidth,
                });
              } catch (error) {
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
            max: limits.QUESTION_TEXT_MAX,
            value: textLength(block.description),
          }}
          label={m.question_ui_description()}
        >
          <Input
            onChange={(event) =>
              onChange({ ...block, description: event.target.value })
            }
            value={block.description}
          />
        </Field>
        <Field
          count={{
            max: limits.QUESTION_METADATA_MAX,
            value: textLength(block.attribution),
          }}
          label={m.question_ui_attribution()}
        >
          <Input
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
  return (
    <div className="space-y-3">
      <Toolbar
        aria-label={m.question_ui_table_tools()}
        className="scroll-fade-x min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="toolbar"
      >
        <ToolbarGroup>
          <ToolbarButton
            active={block.header}
            className="w-auto px-2"
            label={m.question_ui_header_row()}
            onClick={() => onChange({ ...block, header: !block.header })}
          >
            {m.question_ui_header_row()}
          </ToolbarButton>
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton
            disabled={block.rows.length >= 30}
            label={m.question_ui_add_row()}
            onClick={() =>
              onChange({
                ...block,
                rows: [
                  ...block.rows,
                  Array.from({ length: columns }, () => ''),
                ],
              })
            }
          >
            R+
          </ToolbarButton>
          <ToolbarButton
            disabled={block.rows.length <= 1}
            label={m.question_ui_remove_row()}
            onClick={() =>
              onChange({ ...block, rows: block.rows.slice(0, -1) })
            }
          >
            R−
          </ToolbarButton>
          <ToolbarButton
            disabled={columns >= 10}
            label={m.question_ui_add_column()}
            onClick={() =>
              onChange({
                ...block,
                rows: block.rows.map((row) => [...row, '']),
              })
            }
          >
            C+
          </ToolbarButton>
          <ToolbarButton
            disabled={columns <= 1}
            label={m.question_ui_remove_column()}
            onClick={() =>
              onChange({
                ...block,
                rows: block.rows.map((row) => row.slice(0, -1)),
              })
            }
          >
            C−
          </ToolbarButton>
        </ToolbarGroup>
        <div className="flex shrink-0 items-center" ref={setCellTools} />
      </Toolbar>
      <div className="overflow-x-auto">
        <table
          className="w-full table-fixed border-collapse"
          style={{ minWidth: columns * 112 }}
        >
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {row.map((text, j) => {
                  const id = `${i}:${j}`;
                  return (
                    <td
                      className={cn(
                        'border border-line p-2 align-top',
                        block.header &&
                          i === 0 &&
                          'bg-surface-hover-bg font-semibold'
                      )}
                      key={j}
                    >
                      {cell === id ? (
                        <TextEditor
                          compact
                          onChange={(value) => updateCell(i, j, value)}
                          toolbarTarget={cellTools}
                          value={text}
                        />
                      ) : (
                        <button
                          aria-label={m.question_ui_edit_cell({
                            column: j + 1,
                            row: i + 1,
                          })}
                          className="min-h-10 w-full text-left"
                          onClick={() => setCell(id)}
                          type="button"
                        >
                          <QuestionBlockView block={{ text, type: 'text' }} />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
