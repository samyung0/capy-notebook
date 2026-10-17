import { createContext, useContext } from 'react';
import {
  CategoryChart,
  type ChartFrameProps,
  ChartLegend,
  format,
} from '@/components/charts/CategoryChart';
import { PlotChart } from '@/components/charts/PlotChart';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { chartBlock, chartKey, plotBlock } from '../answer';
import type { ChartProps, PlotProps } from '../schema';
import { CiteFooter } from './Cite';

/**
 * SVG charts drawn from the model's numbers, themed through --chart-1..6.
 * Marks follow the data-viz rules: thin bars with rounded ends and a surface
 * gap, 2px lines with ringed markers, the shared legend, a native tooltip
 * per mark, and the values as a table for inspection.
 */

export const InvalidChartContext = createContext<ReadonlySet<string>>(
  new Set()
);

function Values({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="group text-xs">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-fg-muted [&::-webkit-details-marker]:hidden">
        <Icon
          className="transition-transform group-open:rotate-90"
          name="chevronRight"
          size={11}
        />
        {m.chat_chart_values()}
      </summary>
      <table className="mt-1 w-full border-collapse">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                className="border-divider border-b px-1 py-0.5 text-left font-semibold"
                key={index}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td className="px-1 py-0.5 first:font-semibold" key={cellIndex}>
                  {typeof cell === 'number' ? format(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** The question frame's centred title, chart and legend, then the values
 * table and sources. */
function Frame({
  title,
  unit,
  illustrative,
  passages,
  legend,
  values,
  children,
}: ChartFrameProps) {
  return (
    <figure className="flex flex-col gap-1.5">
      <div className="mx-auto w-full max-w-[480px]">
        <figcaption className="wrap-anywhere mb-2 text-center font-semibold text-[13.5px]">
          {title}
          {unit ? (
            <span className="ml-1.5 font-normal text-fg-muted">{unit}</span>
          ) : null}
        </figcaption>
        {/* Charts scale with their box; past this their labels outgrow the text. */}
        {children}
        <ChartLegend names={legend} />
      </div>
      <Values columns={values.columns} rows={values.rows} />
      <CiteFooter
        note={
          illustrative
            ? m.chat_chart_illustrative()
            : passages?.length
              ? undefined
              : m.chat_chart_unsourced()
        }
        passages={passages}
      />
    </figure>
  );
}

export function Chart({
  props,
  statementId,
}: {
  props: ChartProps;
  statementId?: string;
}) {
  const invalid = useContext(InvalidChartContext);
  const block = invalid.has(chartKey(props, statementId))
    ? null
    : chartBlock(props);
  if (!block) return null;
  return (
    <CategoryChart
      authored={false}
      data={{
        ...block,
        illustrative: props.illustrative,
        passages: props.passages,
      }}
      frame={Frame}
    />
  );
}

/** The shared plot block's renderer in the chat frame (values table, sources,
 * illustrative note); props the block schema refuses draw nothing. */
export function Plot({
  props,
  statementId,
}: {
  props: PlotProps;
  statementId?: string;
}) {
  const invalid = useContext(InvalidChartContext);
  const block = invalid.has(chartKey(props, statementId))
    ? null
    : plotBlock(props);
  if (!block) return null;
  return (
    <PlotChart
      data={{
        ...block,
        illustrative: props.illustrative,
        passages: props.passages,
      }}
      frame={Frame}
    />
  );
}
