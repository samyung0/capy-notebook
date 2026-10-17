import type { ComponentType, ReactNode } from 'react';
import type { ChartBlock } from '@/features/questions/types';
import { EMPTY_VALUE } from './emptyValue';

export type ChartData = Omit<ChartBlock, 'type'> & {
  illustrative?: boolean;
  passages?: number[];
};
export type ChartFrameProps = {
  title: string;
  unit?: string;
  illustrative?: boolean;
  passages?: number[];
  legend: string[];
  values: { columns: string[]; rows: (string | number)[][] };
  children?: ReactNode;
};
// Question charts sit at about the width of graph figures, title centred.
export function QuestionChartFrame({
  title,
  unit,
  legend,
  children,
}: ChartFrameProps) {
  return (
    <figure className="mx-auto my-3 w-full min-w-0 max-w-md">
      <figcaption className="wrap-anywhere mb-2 text-center font-semibold">
        {title}
        {unit && <span className="ml-2 font-normal text-fg-muted">{unit}</span>}
      </figcaption>
      <div className="overflow-x-auto">{children}</div>
      <ChartLegend names={legend} />
    </figure>
  );
}
const H = 190;
const COLORS = 6;

export const color = (index: number) => `var(--chart-${(index % COLORS) + 1})`;

export const format = (value: number) =>
  Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** A series' runs of consecutive values, empty cells breaking a line. */
function runs(values: (number | null)[]) {
  const out: [number, number][][] = [];
  let run: [number, number][] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length) out.push(run);
      run = [];
    } else run.push([index, value]);
  });
  if (run.length) out.push(run);
  return out;
}

// CJK, Hangul and full-width forms take a whole em; Latin about half.
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** Estimated SVG text width; close enough to keep labels inside their slot,
 * and the same on the server, where nothing can be measured. */
const textWidth = (text: string, size: number) => {
  let ems = 0;
  for (const char of text) ems += WIDE.test(char) ? 1 : 0.56;
  return ems * size;
};
const SPACES = /\s+/;

/** Up to `maxLines` lines within `width`: whole words where they fit, a word
 * wider than the line (or a run of CJK) broken between letters, the last
 * line cut with an ellipsis when the label still does not fit. */
function fitLabel(label: string, width: number, size: number, maxLines = 3) {
  const lines: string[] = [];
  let line = '';
  for (const word of label.split(SPACES).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    for (const char of word) {
      if (line && textWidth(line + char, size) > width) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] += '…';
  }
  const last = lines.length - 1;
  while (
    last >= 0 &&
    [...lines[last]].length > 1 &&
    textWidth(lines[last], size) > width
  )
    lines[last] = `${[...lines[last]].slice(0, -2).join('').trimEnd()}…`;
  return lines;
}

/** An axis title drawn in the chart's own SVG, so it scales with the tick
 * and category labels and stays one step larger than them. */
function AxisTitle({
  text,
  width,
  ...position
}: {
  text: string;
  width: number;
  x: number;
  y: number;
  textAnchor: 'start' | 'middle';
}) {
  return (
    <text className="fill-fg-muted text-[10px]" {...position}>
      <title>{text}</title>
      {fitLabel(text, width, 10, 1)[0]}
    </text>
  );
}
// Above the plot: room for the top title. Below: from the lowest axis text's
// baseline to the bottom title's, then its descent.
const TOP_TITLE = 16;
const BOTTOM_TITLE_GAP = 20;
const DESCENT = 4;

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

/** Series names under the chart; a lone series shows only when named. */
export function ChartLegend({ names }: { names: string[] }) {
  if (names.length < 2 && !names[0]?.trim()) return null;
  return (
    <div className="mt-1 flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-[11px] text-fg-secondary">
      {names.map((name, index) => (
        <span
          className="wrap-anywhere inline-flex min-w-0 items-center gap-1"
          key={`${index}-${name}`}
        >
          <span
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ background: color(index) }}
          />
          {name}
        </span>
      ))}
    </div>
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

export function CategoryChart({
  data: props,
  frame: Frame = QuestionChartFrame,
  authored = true,
}: {
  data: ChartData;
  frame?: ComponentType<ChartFrameProps>;
  authored?: boolean;
}) {
  const series = props.series;
  const chartScale = (values: number[]) => {
    const result = scale(values);
    if (props.gridlines !== 'fine') return result;
    return {
      ...result,
      ticks: result.ticks.flatMap((tick, i) =>
        i + 1 < result.ticks.length
          ? [tick, (tick + result.ticks[i + 1]) / 2]
          : [tick]
      ),
    };
  };
  const W = authored
    ? Math.max(320, props.labels.length * Math.max(28, series.length * 16))
    : 320;
  const labels = props.labels ?? [];
  const legend = series.map((s) => s.name);
  const values = {
    columns: ['', ...legend],
    rows: labels.map((label, index) => [
      label,
      ...series.map((s) => s.values[index] ?? EMPTY_VALUE),
    ]),
  };
  // Empty cells (null) draw nothing and leave the scale alone.
  const all = series.flatMap((s) => s.values.filter((v) => v !== null));
  const frame = {
    illustrative: props.illustrative,
    legend,
    passages: props.passages,
    title: props.title,
    values,
  };
  if (!(labels.length && series.length)) return <Frame {...frame} />;

  if (props.kind === 'hbar') {
    // Labels wrap to two lines (a row's height) within a quarter of the
    // chart; the column is as wide as the longest wrapped line.
    const labelLines = labels.map((label) =>
      fitLabel(label, W * 0.25 - 10, 9, 2)
    );
    const left = Math.max(
      40,
      ...labelLines.flat().map((line) => textWidth(line, 9) + 10)
    );
    const { min, max, ticks } = chartScale(all);
    // The last tick's number is centred on the edge, so half of it must fit.
    const right =
      W - Math.max(12, Math.ceil(textWidth(format(max), 9) / 2) + 2);
    const x = (value: number) =>
      left + ((value - min) / (max - min)) * (right - left);
    const rowHeight = 22 * series.length + 8;
    const height = labels.length * rowHeight + 20;
    const thickness = Math.min(20, 22 - 2);
    // Values run along the bottom here, so the value (y) axis title goes
    // there and the category (x) axis title on top.
    const top = props.xTitle ? TOP_TITLE : 0;
    const bottomTitle = height - 4 + BOTTOM_TITLE_GAP;
    return (
      <Frame {...frame}>
        <svg
          aria-label={props.description ?? props.title}
          className="w-full"
          role="img"
          style={authored ? { minWidth: W } : undefined}
          viewBox={`0 0 ${W} ${top + (props.yTitle ? bottomTitle + DESCENT : height)}`}
        >
          {props.xTitle && (
            <AxisTitle
              text={props.xTitle}
              textAnchor="start"
              width={W}
              x={0}
              y={10}
            />
          )}
          {props.yTitle && (
            <AxisTitle
              text={props.yTitle}
              textAnchor="middle"
              width={right - left}
              x={(left + right) / 2}
              y={top + bottomTitle}
            />
          )}
          <g transform={`translate(0 ${top})`}>
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
                <text className="fill-fg-muted text-[9px]" textAnchor="end">
                  <title>{label}</title>
                  {labelLines[row].map((line, i, lines) => (
                    <tspan
                      key={i}
                      x={left - 6}
                      y={
                        row * rowHeight +
                        4 +
                        rowHeight / 2 +
                        (i - (lines.length - 1) / 2) * 11
                      }
                    >
                      {line}
                    </tspan>
                  ))}
                </text>
                {series.map((s, index) => {
                  const value = s.values[row];
                  if (value === null) return null;
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
          </g>
        </svg>
      </Frame>
    );
  }

  if (props.kind === 'pie' || props.kind === 'stacked') {
    const first = series[0];
    // Empty cells are no slice; the rest share the total.
    const total = first.values.reduce<number>(
      (sum, value) => sum + Math.max(0, value ?? 0),
      0
    );
    const slices = labels.map((label, index) => {
      const value = first.values[index] ?? null;
      return {
        label,
        share: total && value !== null ? Math.max(0, value) / total : 0,
        value,
      };
    });
    const pieFrame = {
      ...frame,
      legend: labels,
      values: {
        columns: ['', first.name],
        rows: labels.map((label, index) => [
          label,
          first.values[index] ?? EMPTY_VALUE,
        ]),
      },
    };
    if (props.kind === 'stacked') {
      let cursor = 0;
      const last = slices.reduce(
        (found, slice, index) => (slice.share > 0 ? index : found),
        -1
      );
      return (
        <Frame {...pieFrame}>
          <svg
            aria-label={props.description ?? props.title}
            className="w-full"
            role="img"
            style={authored ? { minWidth: W } : undefined}
            viewBox={`0 0 ${W} 28`}
          >
            {slices.map((slice, index) => {
              if (slice.value === null) return null;
              const x = cursor * W;
              const width = Math.max(0, slice.share * W - 2);
              cursor += slice.share;
              // Only the data end, the far side of the last segment, is round.
              const r = index === last ? Math.min(4, width) : 0;
              return (
                <path
                  d={`M${x},2 h${width - r} a${r},${r} 0 0 1 ${r},${r} v${24 - 2 * r} a${r},${r} 0 0 1 -${r},${r} H${x} Z`}
                  fill={color(index)}
                  key={index}
                >
                  <title>{`${slice.label}: ${format(slice.value)}`}</title>
                </path>
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
        <svg
          aria-label={props.description ?? props.title}
          className="mx-auto w-40"
          role="img"
          viewBox="0 0 160 160"
        >
          {slices.map((slice, index) => {
            if (slice.value === null) return null;
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

  const { min, max, ticks } = chartScale(all);
  // The tick column is as wide as its widest number.
  const left = Math.max(
    36,
    ...ticks.map((tick) => Math.ceil(textWidth(format(tick), 9)) + 8)
  );
  const right = W - 12;
  const top = 8;
  const bottom = H - 24;
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const band = (right - left) / labels.length;
  const xCenter = (index: number) => left + band * (index + 0.5);
  const showLabels = authored || labels.length <= 8;
  const labelLines = labels.map((label) => fitLabel(label, band - 4, 9));
  const height =
    H + (Math.max(...labelLines.map((lines) => lines.length)) - 1) * 11;
  const offset = props.yTitle ? TOP_TITLE : 0;
  const bottomTitle = height - 8 + BOTTOM_TITLE_GAP;
  return (
    <Frame {...frame}>
      <svg
        aria-label={props.description ?? props.title}
        className="w-full"
        role="img"
        style={authored ? { minWidth: W } : undefined}
        viewBox={`0 0 ${W} ${offset + (props.xTitle ? bottomTitle + DESCENT : height)}`}
      >
        {props.yTitle && (
          <AxisTitle
            text={props.yTitle}
            textAnchor="start"
            width={W}
            x={0}
            y={10}
          />
        )}
        {props.xTitle && (
          <AxisTitle
            text={props.xTitle}
            textAnchor="middle"
            width={right - left}
            x={(left + right) / 2}
            y={offset + bottomTitle}
          />
        )}
        <g transform={`translate(0 ${offset})`}>
          <Axes left={left} right={right} ticks={ticks} y={y} />
          {labels.map((label, index) =>
            showLabels || index % Math.ceil(labels.length / 8) === 0 ? (
              <text
                className="fill-fg-muted text-[9px]"
                key={index}
                textAnchor="middle"
              >
                <title>{label}</title>
                {labelLines[index].map((line, i) => (
                  <tspan key={i} x={xCenter(index)} y={H - 8 + i * 11}>
                    {line}
                  </tspan>
                ))}
              </text>
            ) : null
          )}
          {props.kind === 'bar'
            ? labels.map((_, index) => {
                const width = Math.max(
                  0.5,
                  Math.min(24, (band * 0.8) / series.length - 2)
                );
                const groupWidth = series.length * (width + 2) - 2;
                return series.map((s, sIndex) => {
                  const value = s.values[index];
                  if (value === null) return null;
                  const x =
                    xCenter(index) - groupWidth / 2 + sIndex * (width + 2);
                  return (
                    <path
                      d={bar(x, y(0), y(value), width)}
                      fill={color(sIndex)}
                      key={`${index}-${sIndex}`}
                    >
                      <title>{`${labels[index]} · ${s.name}: ${format(value)}`}</title>
                    </path>
                  );
                });
              })
            : [
                // Every fill goes under every line so no area hides a line.
                // An empty cell breaks a line and its fill into runs.
                props.kind === 'area' &&
                  series.flatMap((s, sIndex) =>
                    runs(s.values).map((run) => {
                      const first = run[0][0];
                      const last = run.at(-1)?.[0] ?? first;
                      return (
                        <polygon
                          fill={color(sIndex)}
                          key={`fill-${sIndex}-${first}`}
                          opacity={series.length > 1 ? 0.22 : 0.3}
                          points={`${xCenter(first)},${y(0)} ${run.map(([index, value]) => `${xCenter(index)},${y(value)}`).join(' ')} ${xCenter(last)},${y(0)}`}
                        />
                      );
                    })
                  ),
                ...series.map((s, sIndex) => (
                  <g key={sIndex}>
                    {runs(s.values).map((run) => (
                      <g key={run[0][0]}>
                        <polyline
                          fill="none"
                          points={run
                            .map(
                              ([index, value]) =>
                                `${xCenter(index)},${y(value)}`
                            )
                            .join(' ')}
                          stroke={color(sIndex)}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                        />
                        {run.map(([index, value]) => (
                          <circle
                            className="stroke-surface"
                            cx={xCenter(index)}
                            cy={y(value)}
                            fill={color(sIndex)}
                            key={index}
                            r={4}
                            strokeWidth={2}
                          >
                            <title>{`${labels[index]} · ${s.name}: ${format(value)}`}</title>
                          </circle>
                        ))}
                      </g>
                    ))}
                  </g>
                )),
              ]}
        </g>
      </svg>
    </Frame>
  );
}
