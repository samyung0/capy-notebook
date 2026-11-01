import {
  CategoryChart,
  type ChartFrameProps,
  ChartLegend,
  format,
} from '@/components/charts/CategoryChart';
import { PlotChart } from '@/components/charts/PlotChart';
import { Icon } from '@/components/ui/Icon';
import type { ChartBlock, PlotBlock } from '@/features/questions/types';
import { m } from '@/i18n';
import { CiteFooter } from './Cite';

/**
 * SVG charts drawn from the model's numbers, themed through --chart-1..6.
 * Marks follow the data-viz rules: thin bars with rounded ends and a surface
 * gap, 2px lines with ringed markers, the shared legend, a native tooltip
 * per mark, and the values as a table for inspection.
 */

/** A shared block with what chat adds: its sources and the illustrative
 * mark. */
interface FigureProps<Block> {
  block: Block;
  illustrative: boolean;
  passages?: number[];
}
export type ChartProps = FigureProps<ChartBlock>;
export type PlotProps = FigureProps<PlotBlock>;

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
        <div className="mt-2">
          <ChartLegend names={legend} />
        </div>
      </div>
      <Values columns={values.columns} rows={values.rows} />
      <CiteFooter
        note={illustrative ? m.chat_chart_illustrative() : undefined}
        passages={passages}
      />
    </figure>
  );
}

export function Chart({ props }: { props: ChartProps }) {
  const { block, illustrative, passages } = props;
  return (
    <CategoryChart
      authored={false}
      data={{ ...block, illustrative, passages }}
      frame={Frame}
    />
  );
}

/** The shared plot block's renderer in the chat frame (values table, sources,
 * illustrative note). */
export function Plot({ props }: { props: PlotProps }) {
  const { block, illustrative, passages } = props;
  return (
    <PlotChart data={{ ...block, illustrative, passages }} frame={Frame} />
  );
}
