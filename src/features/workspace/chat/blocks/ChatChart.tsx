import { createContext, useContext } from 'react';
import {
  CategoryChart,
  color,
  format,
} from '@/components/charts/CategoryChart';
import { PlotChart } from '@/components/charts/PlotChart';
import { m } from '@/i18n';
import { chartBlock, chartKey, plotBlock } from '../answer';
import type { ChartProps, PlotProps } from '../schema';
import { CiteFooter } from './Cite';

/**
 * SVG charts drawn from the model's numbers, themed through --chart-1..6.
 * Marks follow the data-viz rules: thin bars with rounded ends and a surface
 * gap, 2px lines with ringed markers, a legend whenever there are two or more
 * series, a native tooltip per mark, and the values as a table for inspection.
 */

export const InvalidChartContext = createContext<ReadonlySet<string>>(
  new Set()
);

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-secondary">
      {names.map((name, index) => (
        <span
          className="inline-flex items-center gap-1"
          key={`${index}-${name}`}
        >
          <span
            className="inline-block size-2 rounded-full"
            style={{ background: color(index) }}
          />
          {name}
        </span>
      ))}
    </div>
  );
}

function Values({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-1 text-[11px]">
      <summary className="cursor-pointer text-fg-muted">
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

function Frame({
  title,
  unit,
  illustrative,
  passages,
  legend,
  values,
  children,
}: {
  title: string;
  unit?: string;
  illustrative?: boolean;
  passages?: number[];
  legend: string[];
  values: { columns: string[]; rows: (string | number)[][] };
  children?: React.ReactNode;
}) {
  return (
    <figure className="my-3 rounded-card border border-line px-3 py-2.5">
      <figcaption className="mb-1.5">
        <p className="font-semibold text-xs">{title}</p>
        {unit ? <p className="text-[11px] text-fg-muted">{unit}</p> : null}
      </figcaption>
      {children}
      <Legend names={legend} />
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
