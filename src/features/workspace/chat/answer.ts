import { questionBlockSchema } from '@/features/questions/validation';
import type { ChartProps, PlotProps } from './blocks/ChatChart';
import { fenceJson } from './markdownSegments';

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object')
    : [];

const numbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) ? value.filter(Number.isInteger) : undefined;

/** A chart fence as the shared chart block with its sources, or null when
 * the block schema (one value per label, one series for pie and stacked, the
 * chart limits) refuses it. */
export function chartFigure(body: string): ChartProps | null {
  const value = fenceJson(body);
  if (!value) return null;
  const { kind, labels, passages, series, title, xTitle, yTitle } = value;
  const parsed = questionBlockSchema.safeParse({
    kind,
    labels: Array.isArray(labels) ? labels.map(String) : [],
    series: list(series).map(({ name, values }) => ({ name, values })),
    title: String(title ?? ''),
    type: 'chart',
    ...(xTitle ? { xTitle } : {}),
    ...(yTitle ? { yTitle } : {}),
  });
  return parsed.success && parsed.data.type === 'chart'
    ? {
        block: parsed.data,
        illustrative: value.illustrative === true,
        passages: numbers(passages),
      }
    : null;
}

/** A plot fence as the shared plot block with its sources, or null when the
 * block schema (finite numbers, [x, y] pairs, the plot limits) refuses it. */
export function plotFigure(body: string): PlotProps | null {
  const value = fenceJson(body);
  if (!value) return null;
  const { kind, passages, series, title, xTitle, yTitle } = value;
  const lines = list(value.lines).map(({ axis, label, value: at }) => ({
    axis,
    value: at,
    ...(label ? { label } : {}),
  }));
  const marks = list(value.marks).map(({ label, x, y }) => ({
    label: label ?? '',
    x,
    y,
  }));
  const parsed = questionBlockSchema.safeParse({
    kind,
    series: list(series).map(({ name, points }) => ({ name, points })),
    title: String(title ?? ''),
    type: 'plot',
    xTitle: String(xTitle ?? ''),
    yTitle: String(yTitle ?? ''),
    ...(lines.length ? { lines } : {}),
    ...(marks.length ? { marks } : {}),
  });
  return parsed.success && parsed.data.type === 'plot'
    ? {
        block: parsed.data,
        illustrative: value.illustrative === true,
        passages: numbers(passages),
      }
    : null;
}
