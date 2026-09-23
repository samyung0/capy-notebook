import { createContext, useContext } from 'react';
import { m } from '@/i18n';
import { chartKey, validChartData, validScatterData } from '../answer';
import type {
  ChartProps,
  PointProps,
  ScatterProps,
  SeriesProps,
} from '../schema';
import { CiteFooter, elements } from './Cite';

/**
 * SVG charts drawn from the model's numbers, themed through --chart-1..6.
 * Marks follow the data-viz rules: thin bars with rounded ends and a surface
 * gap, 2px lines with ringed markers, a legend whenever there are two or more
 * series, a native tooltip per mark, and the values as a table for inspection.
 */

const W = 320;
const H = 190;
const COLORS = 6;

export const InvalidChartContext = createContext<ReadonlySet<string>>(
  new Set()
);

const color = (index: number) => `var(--chart-${(index % COLORS) + 1})`;

const format = (value: number) =>
  Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Four clean ticks spanning [lo, hi], always including zero. */
function scale(values: number[]) {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const raw = span / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * power).find((k) => k >= raw) ?? raw;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step || step;
  if (
    !(Number.isFinite(step) && Number.isFinite(max) && Number.isFinite(min))
  ) {
    return { max: 1, min: 0, ticks: [0, 1] };
  }
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 2; tick += step) ticks.push(tick);
  return { max, min, ticks };
}

/** A bar growing from the baseline with a 4px rounded data end. */
function bar(x: number, y0: number, y1: number, width: number) {
  const top = Math.min(y0, y1);
  const height = Math.abs(y1 - y0);
  const r = Math.min(4, width / 2, height);
  if (y1 <= y0) {
    return `M${x},${y0} V${top + r} a${r},${r} 0 0 1 ${r},-${r} h${width - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${y0} Z`;
  }
  return `M${x},${y0} h${width} V${y1 - r} a${r},${r} 0 0 1 -${r},${r} h-${width - 2 * r} a${r},${r} 0 0 1 -${r},-${r} Z`;
}

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
                <td
                  className="px-1 py-0.5 tabular-nums first:font-semibold"
                  key={cellIndex}
                >
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

function Axes({
  ticks,
  y,
  left,
  right,
}: {
  ticks: number[];
  y: (value: number) => number;
  left: number;
  right: number;
}) {
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            className={tick === 0 ? 'stroke-line' : 'stroke-divider'}
            x1={left}
            x2={right}
            y1={y(tick)}
            y2={y(tick)}
          />
          <text
            className="fill-fg-muted text-[9px]"
            textAnchor="end"
            x={left - 4}
            y={y(tick) + 3}
          >
            {format(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

function CategoryChart({ props }: { props: ChartProps }) {
  const series = elements<SeriesProps>(props.series).map((node) => ({
    name: node.props.name,
    values: node.props.values,
  }));
  const labels = props.labels ?? [];
  const legend = series.map((s) => s.name);
  const values = {
    columns: ['', ...legend],
    rows: labels.map((label, index) => [
      label,
      ...series.map((s) => s.values[index]),
    ]),
  };
  const all = series.flatMap((s) => s.values);
  const frame = {
    illustrative: props.illustrative,
    legend,
    passages: props.passages,
    title: props.title,
    unit: props.unit,
    values,
  };
  if (!(labels.length && series.length)) return <Frame {...frame} />;

  if (props.kind === 'hbar') {
    const left = 92;
    const right = W - 12;
    const { min, max, ticks } = scale(all);
    const x = (value: number) =>
      left + ((value - min) / (max - min)) * (right - left);
    const rowHeight = 22 * series.length + 8;
    const height = labels.length * rowHeight + 20;
    const thickness = Math.min(20, 22 - 2);
    return (
      <Frame {...frame}>
        <svg className="w-full" role="img" viewBox={`0 0 ${W} ${height}`}>
          {ticks.map((tick) => (
            <line
              className={tick === 0 ? 'stroke-line' : 'stroke-divider'}
              key={tick}
              x1={x(tick)}
              x2={x(tick)}
              y1={4}
              y2={height - 16}
            />
          ))}
          {ticks.map((tick) => (
            <text
              className="fill-fg-muted text-[9px]"
              key={tick}
              textAnchor="middle"
              x={x(tick)}
              y={height - 4}
            >
              {format(tick)}
            </text>
          ))}
          {labels.map((label, row) => (
            <g key={row}>
              <text
                className="fill-fg-secondary text-[10px]"
                textAnchor="end"
                x={left - 6}
                y={row * rowHeight + 4 + rowHeight / 2}
              >
                {label}
              </text>
              {series.map((s, index) => {
                const value = s.values[row];
                const y = row * rowHeight + 8 + index * 22;
                const x0 = x(0);
                const x1 = x(value);
                const r = Math.min(4, Math.abs(x1 - x0) / 2, thickness / 2);
                const path =
                  value >= 0
                    ? `M${x0},${y} H${x1 - r} a${r},${r} 0 0 1 ${r},${r} v${thickness - 2 * r} a${r},${r} 0 0 1 -${r},${r} H${x0} Z`
                    : `M${x0},${y} H${x1 + r} a${r},${r} 0 0 0 -${r},${r} v${thickness - 2 * r} a${r},${r} 0 0 0 ${r},${r} H${x0} Z`;
                return (
                  <path d={path} fill={color(index)} key={index}>
                    <title>{`${s.name}: ${format(value)}`}</title>
                  </path>
                );
              })}
            </g>
          ))}
        </svg>
      </Frame>
    );
  }

  if (props.kind === 'pie' || props.kind === 'stacked') {
    const first = series[0];
    const total = first.values.reduce(
      (sum, value) => sum + Math.max(0, value),
      0
    );
    const slices = labels.map((label, index) => ({
      label,
      share: total ? Math.max(0, first.values[index]) / total : 0,
      value: first.values[index],
    }));
    const pieFrame = {
      ...frame,
      legend: labels,
      values: {
        columns: ['', first.name],
        rows: labels.map((label, index) => [label, first.values[index]]),
      },
    };
    if (props.kind === 'stacked') {
      let cursor = 0;
      return (
        <Frame {...pieFrame}>
          <svg className="w-full" role="img" viewBox={`0 0 ${W} 28`}>
            {slices.map((slice, index) => {
              const x = cursor * W;
              const width = Math.max(0, slice.share * W - 2);
              cursor += slice.share;
              return (
                <rect
                  fill={color(index)}
                  height={24}
                  key={index}
                  rx={index === 0 || index === slices.length - 1 ? 4 : 0}
                  width={width}
                  x={x}
                  y={2}
                >
                  <title>{`${slice.label}: ${format(slice.value)}`}</title>
                </rect>
              );
            })}
          </svg>
        </Frame>
      );
    }
    const cx = 80;
    const cy = 80;
    const r = 70;
    let angle = -Math.PI / 2;
    return (
      <Frame {...pieFrame}>
        <svg className="mx-auto w-40" role="img" viewBox="0 0 160 160">
          {slices.map((slice, index) => {
            const sweep = slice.share * 2 * Math.PI;
            const start = angle;
            angle += sweep;
            if (slice.share >= 0.9999) {
              return (
                <circle cx={cx} cy={cy} fill={color(index)} key={index} r={r}>
                  <title>{`${slice.label}: ${format(slice.value)}`}</title>
                </circle>
              );
            }
            const x0 = cx + r * Math.cos(start);
            const y0 = cy + r * Math.sin(start);
            const x1 = cx + r * Math.cos(angle);
            const y1 = cy + r * Math.sin(angle);
            const large = sweep > Math.PI ? 1 : 0;
            return (
              <path
                className="stroke-surface"
                d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`}
                fill={color(index)}
                key={index}
                strokeWidth={2}
              >
                <title>{`${slice.label}: ${format(slice.value)} (${Math.round(slice.share * 100)}%)`}</title>
              </path>
            );
          })}
        </svg>
      </Frame>
    );
  }

  const left = 36;
  const right = W - 12;
  const top = 8;
  const bottom = H - 24;
  const { min, max, ticks } = scale(all);
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const band = (right - left) / labels.length;
  const xCenter = (index: number) => left + band * (index + 0.5);
  const showLabels = labels.length <= 8;
  return (
    <Frame {...frame}>
      <svg className="w-full" role="img" viewBox={`0 0 ${W} ${H}`}>
        <Axes left={left} right={right} ticks={ticks} y={y} />
        {labels.map((label, index) =>
          showLabels || index % Math.ceil(labels.length / 8) === 0 ? (
            <text
              className="fill-fg-muted text-[9px]"
              key={index}
              textAnchor="middle"
              x={xCenter(index)}
              y={H - 8}
            >
              {label}
            </text>
          ) : null
        )}
        {props.kind === 'bar'
          ? labels.map((_, index) => {
              const width = Math.min(24, (band * 0.8) / series.length - 2);
              const groupWidth = series.length * (width + 2) - 2;
              return series.map((s, sIndex) => {
                const x =
                  xCenter(index) - groupWidth / 2 + sIndex * (width + 2);
                return (
                  <path
                    d={bar(x, y(0), y(s.values[index]), width)}
                    fill={color(sIndex)}
                    key={`${index}-${sIndex}`}
                  >
                    <title>{`${labels[index]} · ${s.name}: ${format(s.values[index])}`}</title>
                  </path>
                );
              });
            })
          : series.map((s, sIndex) => {
              const points = s.values.map(
                (value, index) => [xCenter(index), y(value)] as const
              );
              const line = points.map(([px, py]) => `${px},${py}`).join(' ');
              return (
                <g key={sIndex}>
                  {props.kind === 'area' ? (
                    <polygon
                      fill={color(sIndex)}
                      opacity={0.12}
                      points={`${left + band / 2},${y(0)} ${line} ${xCenter(points.length - 1)},${y(0)}`}
                    />
                  ) : null}
                  <polyline
                    fill="none"
                    points={line}
                    stroke={color(sIndex)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                  />
                  {points.map(([px, py], index) => (
                    <circle
                      className="stroke-surface"
                      cx={px}
                      cy={py}
                      fill={color(sIndex)}
                      key={index}
                      r={4}
                      strokeWidth={2}
                    >
                      <title>{`${labels[index]} · ${s.name}: ${format(s.values[index])}`}</title>
                    </circle>
                  ))}
                </g>
              );
            })}
      </svg>
    </Frame>
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
  if (invalid.has(chartKey(props, statementId)) || !validChartData(props))
    return null;
  return <CategoryChart props={props} />;
}

export function ScatterChart({
  props,
  statementId,
}: {
  props: ScatterProps;
  statementId?: string;
}) {
  const invalid = useContext(InvalidChartContext);
  if (invalid.has(chartKey(props, statementId)) || !validScatterData(props))
    return null;
  const points = elements<PointProps>(props.points).map((node) => ({
    label: node.props.label,
    x: node.props.x,
    y: node.props.y,
  }));
  const left = 40;
  const right = W - 12;
  const top = 8;
  const bottom = H - 26;
  const xs = scale(points.map((p) => p.x));
  const ys = scale(points.map((p) => p.y));
  const x = (value: number) =>
    left + ((value - xs.min) / (xs.max - xs.min)) * (right - left);
  const y = (value: number) =>
    bottom - ((value - ys.min) / (ys.max - ys.min)) * (bottom - top);
  return (
    <Frame
      illustrative={props.illustrative}
      legend={[]}
      passages={props.passages}
      title={props.title}
      unit={props.unit}
      values={{
        columns: ['', props.xLabel, props.yLabel],
        rows: points.map((p, index) => [
          p.label ?? String(index + 1),
          p.x,
          p.y,
        ]),
      }}
    >
      <svg className="w-full" role="img" viewBox={`0 0 ${W} ${H}`}>
        <Axes left={left} right={right} ticks={ys.ticks} y={y} />
        {xs.ticks.map((tick) => (
          <text
            className="fill-fg-muted text-[9px]"
            key={tick}
            textAnchor="middle"
            x={x(tick)}
            y={bottom + 12}
          >
            {format(tick)}
          </text>
        ))}
        <text
          className="fill-fg-muted text-[9px]"
          textAnchor="end"
          x={right}
          y={H - 2}
        >
          {props.xLabel}
        </text>
        <text className="fill-fg-muted text-[9px]" x={left} y={top - 1}>
          {props.yLabel}
        </text>
        {points.map((p, index) => (
          <circle
            className="stroke-surface"
            cx={x(p.x)}
            cy={y(p.y)}
            fill={color(0)}
            key={index}
            r={4}
            strokeWidth={2}
          >
            <title>{`${p.label ? `${p.label}: ` : ''}${format(p.x)}, ${format(p.y)}`}</title>
          </circle>
        ))}
      </svg>
    </Frame>
  );
}
