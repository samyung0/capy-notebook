import {
  type ElementNode,
  type LibraryJSONSchema,
  type ParseResult,
  parseExpression,
  split,
  tokenize,
  walkAST,
} from '@openuidev/lang-core';
import type { ChartProps, ScatterProps } from './schema';

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

export function validChartData(props: ChartProps): boolean {
  return (
    Array.isArray(props.labels) &&
    Array.isArray(props.series) &&
    props.labels.length > 0 &&
    props.series.length > 0 &&
    (!(props.kind === 'pie' || props.kind === 'stacked') ||
      props.series.length === 1) &&
    props.series.every(
      (node) =>
        isElement(node) &&
        node.typeName === 'Series' &&
        Array.isArray(node.props.values) &&
        node.props.values.length === props.labels.length &&
        node.props.values.every((value) => Number.isFinite(value))
    )
  );
}

export function validScatterData(props: ScatterProps): boolean {
  return (
    Array.isArray(props.points) &&
    props.points.length > 0 &&
    props.points.every(
      (node) =>
        isElement(node) &&
        node.typeName === 'Point' &&
        Number.isFinite(node.props.x) &&
        Number.isFinite(node.props.y)
    )
  );
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
        ['Chart', 'Series', 'ScatterChart', 'Point'].includes(error.component)
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
      (value.typeName === 'Chart' || value.typeName === 'ScatterChart') &&
      damaged(value, statement)
    ) {
      // Errors identify statements, so charts inline in one damaged statement
      // are withheld together; independent chart statements remain usable.
      invalidCharts.add(chartKey(value.props, value.statementId));
      return;
    }
    if (
      (value.typeName === 'Chart' &&
        !validChartData(value.props as unknown as ChartProps)) ||
      (value.typeName === 'ScatterChart' &&
        !validScatterData(value.props as unknown as ScatterProps))
    ) {
      invalidData = true;
      return;
    }
    for (const [name, prop] of Object.entries(value.props)) {
      if (['kind', 'passages', 'illustrative'].includes(name)) continue;
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
