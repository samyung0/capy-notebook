import * as limits from '@/api/limits.generated';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A live chart, plot or graph as its merges are read (Epo 2026-10-17,
 * 2026-10-18): two editors' changes to one figure merge entry by entry,
 * which can leave what neither wrote and the validators refuse; the type
 * wins on read and no merge is refused. Series and graph elements past their
 * cap keep the first ones in document order, a pie or stacked chart its
 * first series; a chart series' values are padded with empty cells (null) or
 * cut to its labels; a line plot's series with fewer than two points is
 * skipped (before the cap); a graph element naming a point that is gone is
 * skipped (only points are referenced, so one pass). A chart or plot left
 * without series, and a pie or stacked chart without a positive total, stay
 * and draw empty. A block needing none of it comes back as it is; anything
 * else stays for the validators. Readers draw the result; editors show the
 * block as held, with its issues. The collaboration server's
 * `repair_figure` is the same.
 */
export function repairFigureBlock<T>(block: T): T {
  if (!isRecord(block)) return block;
  const list = block.type === 'graph' ? 'elements' : 'series';
  const single = block.kind === 'pie' || block.kind === 'stacked';
  const cap =
    block.type === 'chart'
      ? single
        ? 1
        : limits.QUESTION_CHART_SERIES_MAX
      : block.type === 'plot'
        ? limits.QUESTION_PLOT_SERIES_MAX
        : block.type === 'graph'
          ? limits.QUESTION_GRAPH_ELEMENTS_MAX
          : undefined;
  const held = block[list];
  if (cap === undefined || !Array.isArray(held)) return block;
  const line = block.type === 'plot' && block.kind !== 'scatter';
  let entries: unknown[] = line
    ? held.filter(
        (series) =>
          !(isRecord(series) && Array.isArray(series.points)) ||
          series.points.length >= 2
      )
    : held;
  entries = entries.slice(0, cap);
  const labels = Array.isArray(block.labels) ? block.labels.length : undefined;
  if (block.type === 'chart' && labels !== undefined)
    entries = entries.map((series) =>
      isRecord(series) &&
      Array.isArray(series.values) &&
      series.values.length !== labels
        ? {
            ...series,
            values: Array.from(
              { length: labels },
              (_, i) => (series.values as unknown[])[i] ?? null
            ),
          }
        : series
    );
  if (block.type === 'graph') {
    const points = new Set(
      entries.flatMap((element) =>
        isRecord(element) &&
        element.type === 'point' &&
        typeof element.id === 'string'
          ? [element.id]
          : []
      )
    );
    entries = entries.filter(
      (element) =>
        !isRecord(element) ||
        [
          ...(Array.isArray(element.points) ? element.points : []),
          ...('center' in element ? [element.center] : []),
        ].every((id) => typeof id !== 'string' || points.has(id))
    );
  }
  const same =
    entries.length === held.length &&
    entries.every((entry, i) => entry === held[i]);
  return same ? block : ({ ...block, [list]: entries } as T);
}
