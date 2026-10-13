import {
  type ElementNode,
  type LibraryJSONSchema,
  type ParseResult,
  parseExpression,
  split,
  tokenize,
  walkAST,
} from '@openuidev/lang-core';
import type { ChartBlock, PlotBlock } from '@/features/questions/types';
import { questionBlockSchema } from '@/features/questions/validation';
import type {
  ChartProps,
  CurveProps,
  DiagramProps,
  InteractiveProps,
  PlotProps,
} from './schema';

const STATEMENT_HEAD = /^\s*[A-Za-z_]\w*\s*=/;
const ROOT_HEAD = /^[ \t]*root\s*=\s*Answer\s*\(/m;
const COMPONENT_HEAD = /^\s*(?:root\s*=|[A-Za-z_]\w*\s*=\s*[A-Z]\w*\s*\()/m;
const OPENING_FENCE = /`{3,}[\w-]*[ \t]*\r?\n\s*$/;

export const isLangAnswer = (content: string) =>
  STATEMENT_HEAD.test(content) || programStart(content) > 0;

export const programStart = (content: string) => content.search(ROOT_HEAD);

export function splitAnswer(content: string) {
  const start = programStart(content);
  if (start <= 0) return { prefix: '', program: content };
  const before = content.slice(0, start);
  // Keep the opening fence with the program: OpenUI strips its matching close.
  const offset = before.match(OPENING_FENCE)?.index ?? start;
  return {
    prefix: content.slice(0, offset).trim(),
    program: content.slice(offset),
  };
}

/** Equations can resemble statements; an actual component program is not Markdown. */
export const isProgramSyntax = (content: string) =>
  COMPONENT_HEAD.test(content);

function isElement(value: unknown): value is ElementNode {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'element' &&
    'props' in value &&
    !!value.props &&
    typeof value.props === 'object'
  );
}

/** Extra empty placeholders are harmless; extra text or values may be lost. */
export function ignoreEmptyExtras(
  result: ParseResult,
  source: string,
  schema: LibraryJSONSchema
) {
  if (!result.meta.errors.some((error) => error.code === 'excess-args'))
    return result;
  const empty = new Set<string>();
  const meaningful = new Set<string>();
  try {
    for (const statement of split(tokenize(source))) {
      walkAST(parseExpression(statement.tokens), (node) => {
        if (node.k !== 'Comp') return;
        const props = schema.$defs?.[node.name]?.properties;
        if (!props) return;
        const extra = node.args.slice(Object.keys(props).length);
        if (!extra.length) return;
        const harmless = extra.every(
          (arg) =>
            arg.k === 'Null' ||
            (arg.k === 'Str' && !arg.v.trim()) ||
            (arg.k === 'Arr' && !arg.els.length)
        );
        (harmless ? empty : meaningful).add(`${statement.id}:${node.name}`);
      });
    }
  } catch {
    return result;
  }
  return {
    ...result,
    meta: {
      ...result.meta,
      errors: result.meta.errors.filter((error) => {
        const key = `${error.statementId}:${error.component}`;
        return (
          error.code !== 'excess-args' || !empty.has(key) || meaningful.has(key)
        );
      }),
    },
  };
}

const nodes = (value: unknown) =>
  Array.isArray(value) ? value.filter(isElement) : [];

/** A Chart's props as the shared chart block, or null when the block schema
 * (one value per label, one series for pie and stacked, the chart limits)
 * refuses them. */
export function chartBlock(props: ChartProps): ChartBlock | null {
  const series = nodes(props.series);
  if (
    !Array.isArray(props.series) ||
    series.length !== props.series.length ||
    series.some((node) => node.typeName !== 'Series')
  )
    return null;
  const parsed = questionBlockSchema.safeParse({
    kind: props.kind,
    labels: props.labels,
    series: series.map(({ props: s }) => ({ name: s.name, values: s.values })),
    title: props.title,
    type: 'chart',
    ...(props.xTitle ? { xTitle: props.xTitle } : {}),
    ...(props.yTitle ? { yTitle: props.yTitle } : {}),
  });
  return parsed.success && parsed.data.type === 'chart' ? parsed.data : null;
}

/** A Plot's props as the shared plot block, or null when the block schema
 * (finite numbers, [x, y] pairs, the plot limits) refuses them. */
export function plotBlock(props: PlotProps): PlotBlock | null {
  const lines = nodes(props.lines).map(({ props: line }) => ({
    axis: line.axis,
    value: line.value,
    ...(line.label ? { label: line.label } : {}),
  }));
  const marks = nodes(props.marks).map(({ props: mark }) => ({
    label: mark.label ?? '',
    x: mark.x,
    y: mark.y,
  }));
  const parsed = questionBlockSchema.safeParse({
    kind: props.kind,
    series: nodes(props.series).map(({ props: curve }) => ({
      name: curve.name,
      points: curve.points,
    })),
    title: props.title,
    type: 'plot',
    xTitle: props.xTitle,
    yTitle: props.yTitle,
    ...(lines.length ? { lines } : {}),
    ...(marks.length ? { marks } : {}),
  });
  return parsed.success && parsed.data.type === 'plot' ? parsed.data : null;
}

export const chartKey = (props: unknown, statementId?: string) =>
  JSON.stringify([statementId, props]);

/** Local recovery must never shift or invent chart measurements. Parser array
 * recovery can drop a bad value before the React component receives it. */
export function inspectAnswer(result: ParseResult | null) {
  const errors = result?.meta.errors ?? [];
  const damagedStatements = new Set(
    errors
      .filter((error) =>
        ['Chart', 'Series', 'Point', 'Plot', 'Curve', 'RefLine'].includes(
          error.component
        )
      )
      .map((error) => error.statementId)
  );
  const invalidCharts = new Set<string>();
  const damaged = (value: unknown, owner?: string): boolean => {
    if (Array.isArray(value))
      return value.some((child) => damaged(child, owner));
    if (!isElement(value)) return false;
    const statement = value.statementId ?? owner;
    return (
      damagedStatements.has(statement) ||
      Object.values(value.props).some((prop) => damaged(prop, statement))
    );
  };
  let invalidData = false;
  const lines: string[] = [];
  const visit = (value: unknown, owner?: string) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, owner);
      return;
    }
    if (!isElement(value)) return;
    const statement = value.statementId ?? owner;
    if (
      ['Chart', 'Plot'].includes(value.typeName) &&
      damaged(value, statement)
    ) {
      // Errors identify statements, so charts inline in one damaged statement
      // are withheld together; independent chart statements remain usable.
      invalidCharts.add(chartKey(value.props, value.statementId));
      return;
    }
    if (
      (value.typeName === 'Chart' &&
        !chartBlock(value.props as unknown as ChartProps)) ||
      (value.typeName === 'Plot' &&
        !plotBlock(value.props as unknown as PlotProps))
    ) {
      invalidData = true;
      return;
    }
    if (value.typeName === 'Diagram') {
      const { title, code } = value.props as unknown as DiagramProps;
      if (typeof title === 'string' && title.trim()) lines.push(title);
      if (typeof code === 'string' && code.trim())
        lines.push(['```mermaid', code.trim(), '```'].join('\n'));
      return;
    }
    if (value.typeName === 'Curve') {
      const { name, points } = value.props as unknown as CurveProps;
      lines.push(
        `${name}: ${points.map(([x, y]) => `(${x}, ${y})`).join(' ')}`
      );
      return;
    }
    if (value.typeName === 'Interactive') {
      const { title } = value.props as unknown as InteractiveProps;
      if (typeof title === 'string' && title.trim()) lines.push(title);
      return;
    }
    for (const [name, prop] of Object.entries(value.props)) {
      if (['kind', 'passages', 'illustrative', 'axis'].includes(name)) continue;
      if (typeof prop === 'string' && prop.trim()) lines.push(prop);
      else if (typeof prop === 'number' && Number.isFinite(prop))
        lines.push(`${name}: ${prop}`);
      else if (
        Array.isArray(prop) &&
        prop.every(
          (item) => typeof item === 'string' || typeof item === 'number'
        )
      )
        lines.push(prop.join(' · '));
      else visit(prop, statement);
    }
  };
  visit(result?.root);
  return {
    gap:
      !result?.root ||
      !!result.meta.incomplete ||
      !!result.meta.unresolved.length ||
      errors.length > 0 ||
      invalidCharts.size > 0 ||
      invalidData ||
      !lines.some((line) => line.trim()),
    invalidCharts,
    text: lines.join('\n\n').trim(),
  };
}
