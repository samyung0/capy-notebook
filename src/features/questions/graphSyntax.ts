/* Desmos-style graph rows: text typed in the editor ↔ recipe elements.
 * Rows arrive as ASCII-math (MathLive's `ascii-math` output, or plain text)
 * and leave as LaTeX for the row's math field. Stored function terms stay
 * JessieCode with explicit `*`, which `validGraphTerm` checks. */
import * as limits from '@/api/limits.generated';
import { m } from '@/i18n';
import { sameJson } from '@/lib/sameJson';
import type { GraphElement } from './types';

type Node =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'tuple'; items: Node[] };

/** A row the editor cannot turn into an element; `message` is localized. */
export class RowError extends Error {}

const FUNCTIONS = new Set([
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sqrt',
  'abs',
  'exp',
  'log',
  'ln',
  'floor',
  'ceil',
  'pow',
  'min',
  'max',
]);
const COMMANDS = {
  angle: 3,
  arc: 3,
  circle: 2,
  line: 2,
  polygon: 0,
  sector: 3,
  segment: 2,
} as const;
type Command = keyof typeof COMMANDS;
const CONSTANTS = new Set(['pi', 'e']);
const SUBSCRIPT = /_(\w+)/;
const ENDS_IN_DIGIT = /\d$/;
const STARTS_NUMERIC = /^[\d.]/;
const FUNCTION_OF_X = /^[A-Za-z] \( x \)$/;
/** `P_1` → `P_{1}` for LaTeX. */
const subscript = (name: string) => name.replace(SUBSCRIPT, '_{$1}');
/** Longest first, so `asin` wins over `sin` when splitting `asinx`. */
const WORDS = [...FUNCTIONS, ...Object.keys(COMMANDS)].sort(
  (a, b) => b.length - a.length
);

// MathLive spells multi-letter operator names letter by letter ("s e g m e n t").
const SPACED = WORDS.filter((word) => word.length > 1).map(
  (word) => [new RegExp([...word].join('\\s*'), 'g'), word] as const
);

function normalize(source: string) {
  let text = source
    .replace(/[≤⩽]/g, '<=')
    .replace(/[≥⩾]/g, '>=')
    .replace(/[−–]/g, '-')
    .replace(/[·×⋅]/g, '*')
    .replace(/π/g, 'pi')
    .replace(/\\left|\\right/g, '');
  for (const [pattern, word] of SPACED) text = text.replace(pattern, word);
  return text;
}

type Token = { k: 'num' | 'name' | 'op'; v: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?|([A-Za-z]+(?:_(?:\(\w+\)|\w+))?)|(<=|>=|[-+*/^(),|{}=<>]))/y;
  let index = 0;
  const end = source.trimEnd().length;
  while (index < end) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new RowError(m.question_ui_graph_row_unreadable());
    index = pattern.lastIndex;
    if (match[1] !== undefined)
      tokens.push({
        k: 'num',
        v: match[2] === undefined ? match[1] : `${match[1]}e${match[2]}`,
      });
    else if (match[3] === undefined) tokens.push({ k: 'op', v: match[4] });
    else tokens.push(...splitName(match[3]));
  }
  return tokens;
}

/** `sinx` → sin x, `xy` → x y, `A_1` stays one name. */
function splitName(name: string): Token[] {
  if (name.includes('_')) {
    const [base, sub] = name.split('_');
    const named: Token = {
      k: 'name',
      v: `${base.slice(-1)}_${sub.replace(/[()]/g, '')}`,
    };
    return [...splitName(base.slice(0, -1)), named];
  }
  const out: Token[] = [];
  let rest = name;
  while (rest) {
    const word = WORDS.find((w) => rest.startsWith(w));
    const constant = rest.startsWith('pi') ? 'pi' : undefined;
    const take = word ?? constant ?? rest[0];
    out.push({ k: 'name', v: take });
    rest = rest.slice(take.length);
  }
  return out;
}

class Parser {
  private i = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(v?: string) {
    const token = this.tokens[this.i];
    return v === undefined ? token : token?.v === v ? token : undefined;
  }
  next() {
    const token = this.tokens[this.i++];
    if (!token) throw new RowError(m.question_ui_graph_row_unfinished());
    return token;
  }
  expect(v: string) {
    if (this.next().v !== v)
      throw new RowError(m.question_ui_graph_row_unreadable());
  }
  done() {
    return this.i >= this.tokens.length;
  }

  expression(): Node {
    let left = this.term();
    for (;;) {
      const op = this.peek('+') ?? this.peek('-');
      if (!op) return left;
      this.i++;
      left = { a: left, b: this.term(), op: op.v as '+' | '-', t: 'bin' };
    }
  }

  term(stopAtFunction = false): Node {
    let left = this.unary();
    for (;;) {
      const op = this.peek('*') ?? this.peek('/');
      if (op) {
        this.i++;
        left = { a: left, b: this.unary(), op: op.v as '*' | '/', t: 'bin' };
      } else if (this.startsFactor(stopAtFunction)) {
        left = { a: left, b: this.power(), op: '*', t: 'bin' };
      } else return left;
    }
  }

  /** Whether the next token begins a factor written right after another. */
  startsFactor(stopAtFunction: boolean) {
    const token = this.peek();
    if (!token) return false;
    if (token.k === 'num' || token.v === '(') return true;
    if (token.k !== 'name') return false;
    return !(stopAtFunction && FUNCTIONS.has(token.v));
  }

  unary(): Node {
    if (this.peek('-')) {
      this.i++;
      return { a: this.unary(), t: 'neg' };
    }
    if (this.peek('+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  power(): Node {
    const base = this.primary();
    if (!this.peek('^')) return base;
    this.i++;
    return { a: base, b: this.unary(), op: '^', t: 'bin' };
  }

  primary(): Node {
    const token = this.next();
    if (token.k === 'num') return { t: 'num', v: Number(token.v) };
    if (token.v === '(') {
      const items = [this.expression()];
      while (this.peek(',')) {
        this.i++;
        items.push(this.expression());
      }
      this.expect(')');
      return items.length === 1 ? items[0] : { items, t: 'tuple' };
    }
    if (token.v === '|') {
      const inner = this.expression();
      this.expect('|');
      return { args: [inner], fn: 'abs', t: 'call' };
    }
    if (token.k !== 'name')
      throw new RowError(
        this.done()
          ? m.question_ui_graph_row_unfinished()
          : m.question_ui_graph_row_unreadable()
      );
    if (FUNCTIONS.has(token.v) || token.v in COMMANDS)
      return this.call(token.v);
    return { t: 'name', v: token.v };
  }

  /** `sin(x)`, `sin x`, `sin 2x`, `cos^2 x` (the square of cos x). */
  call(fn: string): Node {
    let exponent: Node | undefined;
    if (this.peek('^') && FUNCTIONS.has(fn)) {
      this.i++;
      exponent = this.unary();
    }
    let args: Node[];
    if (this.peek('(')) {
      this.i++;
      args = [this.expression()];
      while (this.peek(',')) {
        this.i++;
        args.push(this.expression());
      }
      this.expect(')');
    } else if (FUNCTIONS.has(fn)) args = [this.term(true)];
    else throw new RowError(m.question_ui_graph_row_unfinished());
    const node: Node = { args, fn, t: 'call' };
    return exponent ? { a: node, b: exponent, op: '^', t: 'bin' } : node;
  }
}

function parse(source: string): Node {
  const parser = new Parser(tokenize(source));
  const node = parser.expression();
  if (!parser.done()) throw new RowError(m.question_ui_graph_row_unreadable());
  return node;
}

const precedence = (node: Node) =>
  node.t === 'bin'
    ? { '-': 1, '*': 2, '/': 2, '^': 4, '+': 1 }[node.op]
    : node.t === 'neg'
      ? 3
      : 5;

const ARITY: Partial<Record<string, number>> = {
  log: 2,
  max: 2,
  min: 2,
  pow: 2,
};

function checkArity(node: Extract<Node, { t: 'call' }>) {
  const most = ARITY[node.fn] ?? 1;
  const least = node.fn === 'log' ? 1 : most;
  if (node.args.length < least || node.args.length > most)
    throw new RowError(m.question_ui_graph_row_unreadable());
}

/** JessieCode with explicit operators. `runtime` spells the constants the
 * way JessieCode defines them (`PI`, `EULER`); stored terms keep `pi`/`e`. */
function jessie(node: Node, runtime = false): string {
  const wrap = (child: Node, min: number) => {
    const text = jessie(child, runtime);
    return precedence(child) < min ? `(${text})` : text;
  };
  switch (node.t) {
    case 'num':
      return String(node.v);
    case 'name':
      if (runtime && node.v === 'pi') return 'PI';
      if (runtime && node.v === 'e') return 'EULER';
      return node.v;
    case 'neg':
      return `-${wrap(node.a, 4)}`;
    case 'tuple':
      throw new RowError(m.question_ui_graph_row_unreadable());
    case 'call':
      checkArity(node);
      return `${node.fn}(${node.args.map((arg) => jessie(arg, runtime)).join(',')})`;
    case 'bin': {
      const p = precedence(node);
      if (node.op === '^') return `${wrap(node.a, 5)}^${wrap(node.b, 5)}`;
      // Right operands of - and / keep their parentheses at equal precedence.
      return `${wrap(node.a, p)}${node.op}${wrap(node.b, node.op === '-' || node.op === '/' ? p + 1 : p)}`;
    }
  }
}

function latex(node: Node): string {
  const wrap = (child: Node, min: number) => {
    const text = latex(child);
    // A number in scientific notation reads as a product.
    const level =
      child.t === 'num' && text.includes('\\cdot') ? 2 : precedence(child);
    return level < min ? `\\left(${text}\\right)` : text;
  };
  switch (node.t) {
    case 'num':
      return formatNumber(node.v);
    case 'name':
      if (node.v === 'pi') return '\\pi';
      return subscript(node.v);
    case 'neg':
      return `-${wrap(node.a, 4)}`;
    case 'tuple':
      return `\\left(${node.items.map(latex).join(',')}\\right)`;
    case 'call': {
      const [a, b] = node.args;
      if (node.fn === 'sqrt') return `\\sqrt{${latex(a)}}`;
      if (node.fn === 'abs') return `\\left|${latex(a)}\\right|`;
      if (node.fn === 'pow') return `${wrap(a, 5)}^{${latex(b)}}`;
      const name = ['floor', 'ceil'].includes(node.fn)
        ? `\\operatorname{${node.fn}}`
        : `\\${node.fn}`;
      return `${name}\\left(${node.args.map(latex).join(',')}\\right)`;
    }
    case 'bin': {
      const p = precedence(node);
      if (node.op === '/') return `\\frac{${latex(node.a)}}{${latex(node.b)}}`;
      if (node.op === '^') return `${wrap(node.a, 5)}^{${latex(node.b)}}`;
      if (node.op === '*') {
        const left = wrap(node.a, p);
        const right = wrap(node.b, p + 1);
        // Juxtapose like handwriting unless two numbers would run together.
        const numeric = ENDS_IN_DIGIT.test(left) && STARTS_NUMERIC.test(right);
        return numeric ? `${left}\\cdot ${right}` : `${left}${right}`;
      }
      return `${wrap(node.a, p)}${node.op}${wrap(node.b, node.op === '-' ? p + 1 : p)}`;
    }
  }
}

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** A number as GeoGebra displays it in text: `6.02 · 10²³` where JavaScript
 * would write e-notation. */
export function displayNumber(value: number) {
  const text = String(Number(value.toPrecision(12)));
  const [mantissa, exponent] = text.split('e');
  if (exponent === undefined) return text;
  const power = [...String(Number(exponent))]
    .map((char) => (char === '-' ? '⁻' : SUPERSCRIPTS[Number(char)]))
    .join('');
  return `${mantissa} · 10${power}`;
}

/** LaTeX for a number; where JavaScript would write e-notation, GeoGebra's
 * `m · 10ⁿ`, since a bare `e` reads as Euler's number. */
function formatNumber(value: number) {
  const text = String(Number(value.toPrecision(12)));
  const [mantissa, exponent] = text.split('e');
  return exponent === undefined
    ? text
    : `${mantissa}\\cdot 10^{${Number(exponent)}}`;
}

/** Names a term reads; `x` is the only variable of a function row. */
function names(node: Node, out = new Set<string>()) {
  if (node.t === 'name') out.add(node.v);
  if (node.t === 'neg') names(node.a, out);
  if (node.t === 'bin') {
    names(node.a, out);
    names(node.b, out);
  }
  if (node.t === 'call') for (const arg of node.args) names(arg, out);
  if (node.t === 'tuple') for (const item of node.items) names(item, out);
  return out;
}

function evaluate(node: Node): number {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'name':
      if (node.v === 'pi') return Math.PI;
      if (node.v === 'e') return Math.E;
      throw new RowError(m.question_ui_graph_row_needs_number());
    case 'neg':
      return -evaluate(node.a);
    case 'bin': {
      const a = evaluate(node.a);
      const b = evaluate(node.b);
      return node.op === '+'
        ? a + b
        : node.op === '-'
          ? a - b
          : node.op === '*'
            ? a * b
            : node.op === '/'
              ? a / b
              : a ** b;
    }
    case 'call': {
      checkArity(node);
      const args = node.args.map(evaluate);
      if (node.fn === 'ln') return Math.log(args[0]);
      if (node.fn === 'log')
        return Math.log(args[0]) / (args[1] ? Math.log(args[1]) : 1);
      const fn = Math[node.fn as 'sin'] as (...values: number[]) => number;
      return fn(...args);
    }
    case 'tuple':
      throw new RowError(m.question_ui_graph_row_needs_number());
  }
}

function number(node: Node) {
  const value = evaluate(node);
  if (!Number.isFinite(value))
    throw new RowError(m.question_ui_graph_row_needs_number());
  return Number(value.toPrecision(12));
}

function functionTerm(node: Node) {
  for (const name of names(node))
    if (name !== 'x' && !CONSTANTS.has(name))
      throw new RowError(m.question_ui_graph_row_undefined({ name }));
  return jessie(node);
}

/** A point's row name: one letter with an optional subscript (`A`, `P_1`). */
export const POINT_NAME = /^[A-Za-z](?:_[A-Za-z0-9]+)?$/;
const RESERVED = new Set(['x', 'y', 'e']);

/** What a row parses to, before the editor adds its id and style. */
export type ParsedRow =
  | { kind: 'point'; name?: string; coords: [number, number] }
  | { kind: 'function'; term: string; domain?: [number, number] }
  | { kind: 'command'; command: Command; points: string[]; radius?: number };

function splitTop(tokens: Token[], ops: string[]) {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].v;
    if (v === '(' || v === '{') depth++;
    if (v === ')' || v === '}') depth--;
    if (depth === 0 && ops.includes(v)) return i;
  }
  return -1;
}

const source = (tokens: Token[]) => tokens.map((token) => token.v).join(' ');

/** Parses one row; throws `RowError` with copy for the row's tooltip. */
export function parseRow(ascii: string): ParsedRow {
  let tokens = tokenize(normalize(ascii));
  // Brackets left open at the end close themselves, as in Desmos.
  const open =
    tokens.filter((token) => token.v === '(').length -
    tokens.filter((token) => token.v === ')').length;
  for (let i = 0; i < open; i++) tokens.push({ k: 'op', v: ')' });
  if (!tokens.length) throw new RowError(m.question_ui_graph_row_unfinished());
  // A trailing `{a <= x <= b}` restricts a function's domain.
  let domain: [number, number] | undefined;
  if (tokens.at(-1)?.v === '}') {
    const open = tokens.map((token) => token.v).lastIndexOf('{');
    if (open < 0) throw new RowError(m.question_ui_graph_row_unreadable());
    domain = parseDomain(tokens.slice(open + 1, -1));
    tokens = tokens.slice(0, open);
  }
  if (splitTop(tokens, ['<', '>', '<=', '>=']) >= 0)
    throw new RowError(m.question_ui_graph_row_not_yet());
  const equals = splitTop(tokens, ['=']);
  if (equals >= 0) {
    const left = tokens.slice(0, equals);
    const right = tokens.slice(equals + 1);
    if (!right.length) throw new RowError(m.question_ui_graph_row_unfinished());
    const lhs = source(left);
    if (lhs === 'y' || FUNCTION_OF_X.test(lhs))
      return functionRow(parse(source(right)), domain);
    if (left.length === 1 && POINT_NAME.test(lhs) && !RESERVED.has(lhs)) {
      const node = parse(source(right));
      if (node.t === 'tuple') return pointRow(node, lhs, domain);
    }
    throw new RowError(m.question_ui_graph_row_not_yet());
  }
  const node = parse(source(tokens));
  if (node.t === 'tuple') return pointRow(node, undefined, domain);
  if (node.t === 'call' && node.fn in COMMANDS) {
    if (domain) throw new RowError(m.question_ui_graph_row_unreadable());
    return commandRow(node.fn as Command, node.args);
  }
  // A bare expression in x is a function, as in Desmos.
  return functionRow(node, domain);
}

function parseDomain(tokens: Token[]): [number, number] {
  const first = splitTop(tokens, ['<', '<=']);
  const rest = tokens.slice(first + 1);
  const second = splitTop(rest, ['<', '<=']);
  if (first < 0 || second < 0 || source(rest.slice(0, second)) !== 'x')
    throw new RowError(m.question_ui_graph_row_domain());
  const from = number(parse(source(tokens.slice(0, first))));
  const to = number(parse(source(rest.slice(second + 1))));
  if (from >= to)
    throw new RowError(m.question_ui_enter_a_valid_function_domain());
  return [from, to];
}

function functionRow(node: Node, domain?: [number, number]): ParsedRow {
  const term = functionTerm(node);
  if (term.length > limits.QUESTION_GRAPH_TERM_MAX)
    throw new RowError(m.question_ui_graph_row_too_long());
  return { domain, kind: 'function', term };
}

function pointRow(
  node: Extract<Node, { t: 'tuple' }>,
  name: string | undefined,
  domain: [number, number] | undefined
): ParsedRow {
  if (domain || node.items.length !== 2)
    throw new RowError(m.question_ui_graph_row_unreadable());
  if (name && [...name].length > limits.QUESTION_GRAPH_NAME_MAX)
    throw new RowError(m.question_ui_graph_row_name_too_long());
  return {
    coords: [number(node.items[0]), number(node.items[1])],
    kind: 'point',
    name,
  };
}

function commandRow(command: Command, args: Node[]): ParsedRow {
  const count = COMMANDS[command];
  if (command === 'circle') {
    if (args.length !== 2 || args[0].t !== 'name')
      throw new RowError(m.question_ui_graph_row_circle());
    const radius = number(args[1]);
    if (radius <= 0)
      throw new RowError(m.question_ui_select_a_center_and_a_positive_radius());
    return { command, kind: 'command', points: [args[0].v], radius };
  }
  const points = args.map((arg) => {
    if (arg.t !== 'name' || !POINT_NAME.test(arg.v))
      throw new RowError(m.question_ui_graph_row_points({ command }));
    return arg.v;
  });
  if (count ? points.length !== count : points.length < 3)
    throw new RowError(m.question_ui_graph_row_points({ command }));
  return { command, kind: 'command', points };
}

/** The term as the board's JessieCode compiler reads it: explicit products and
 * JessieCode's own names for π and e (it leaves `pi` and `e` undefined). */
export function runtimeTerm(term: string) {
  try {
    return jessie(parse(normalize(term)), true);
  } catch {
    return term;
  }
}

/** LaTeX for a row's math field. `nameOf` gives each point id's row name. */
export function rowLatex(
  element: GraphElement,
  nameOf: (id: string) => string
): string {
  const points = (ids: string[]) =>
    `\\left(${ids.map(nameOf).map(subscript).join(',')}\\right)`;
  switch (element.type) {
    case 'functiongraph': {
      let body: string;
      try {
        body = latex(parse(normalize(element.term)));
      } catch {
        body = element.term;
      }
      const domain = element.domain
        ? `\\left\\lbrace ${formatNumber(element.domain[0])}\\le x\\le ${formatNumber(element.domain[1])}\\right\\rbrace`
        : '';
      return `y=${body}${domain}`;
    }
    case 'point':
      return pointLatex(nameOf(element.id) || undefined, element.coords);
    case 'circle':
      return `\\operatorname{circle}\\left(${nameOf(element.center)},${formatNumber(element.radius)}\\right)`;
    case 'arc':
    case 'sector':
      return `\\operatorname{${element.type}}${points([element.center, ...element.points])}`;
    case 'text':
      return '';
    default:
      return `\\operatorname{${element.type}}${points(element.points)}`;
  }
}

/** A point row, e.g. after the point is dragged on the board. */
export function pointLatex(name: string | undefined, [x, y]: [number, number]) {
  const coords = `\\left(${formatNumber(x)},${formatNumber(y)}\\right)`;
  return name ? `${subscript(name)}=${coords}` : coords;
}

/** Inline shortcuts so typed command names render upright, as functions do. */
export const COMMAND_SHORTCUTS = Object.fromEntries(
  Object.keys(COMMANDS).map((name) => [name, `\\operatorname{${name}}`])
);

/** Per-row look the typed text does not carry. `label` is a point's or an
 * angle's label; for points `undefined` means the row name and '' none. */
export type RowStyle = {
  dash?: boolean;
  ticks?: number;
  shade?: boolean;
  hidden?: boolean;
  label?: string;
};

export type GraphRow =
  | {
      kind: 'expression';
      key: string;
      latex: string;
      parsed?: ParsedRow;
      error?: string;
      style: RowStyle;
    }
  | {
      kind: 'label';
      key: string;
      text: string;
      coords: [number, number];
      hidden?: boolean;
    };

const STYLE_KEYS: Record<GraphElement['type'], (keyof RowStyle)[]> = {
  angle: ['hidden', 'label'],
  arc: ['dash', 'hidden'],
  circle: ['dash', 'hidden'],
  functiongraph: ['dash', 'hidden'],
  line: ['dash', 'hidden'],
  point: ['hidden'],
  polygon: ['dash', 'shade', 'hidden'],
  sector: ['dash', 'shade', 'hidden'],
  segment: ['dash', 'ticks', 'hidden'],
  text: ['hidden'],
};

/** The style keys a row's element takes, for its style menu. */
export const styleKeys = (type: GraphElement['type']) => STYLE_KEYS[type];

function styled<T extends GraphElement>(element: T, style: RowStyle): T {
  const out: Record<string, unknown> = { ...element };
  for (const key of STYLE_KEYS[element.type])
    if (key !== 'label' && style[key]) out[key] = style[key];
  if (element.type === 'angle' && style.label) out.label = style.label;
  return out as T;
}

/** Rows for a saved recipe. Points another element uses get a row name even
 * when their label is not one (`P_1`, label kept). */
export function rowsFromElements(elements: GraphElement[]): GraphRow[] {
  const used = new Set(
    elements.flatMap((element) => [
      ...('points' in element ? element.points : []),
      ...('center' in element ? [element.center] : []),
    ])
  );
  const rowNames = new Map<string, string>();
  const taken = new Set<string>();
  for (const element of elements)
    if (
      element.type === 'point' &&
      element.name &&
      POINT_NAME.test(element.name) &&
      !RESERVED.has(element.name) &&
      !taken.has(element.name)
    ) {
      rowNames.set(element.id, element.name);
      taken.add(element.name);
    }
  let next = 1;
  for (const element of elements)
    if (
      element.type === 'point' &&
      used.has(element.id) &&
      !rowNames.has(element.id)
    ) {
      while (taken.has(`P_${next}`)) next++;
      rowNames.set(element.id, `P_${next}`);
      taken.add(`P_${next}`);
    }
  const nameOf = (id: string) => rowNames.get(id) ?? '';
  return elements.map((element): GraphRow => {
    if (element.type === 'text')
      return {
        coords: element.coords,
        hidden: element.hidden,
        key: element.id,
        kind: 'label',
        text: element.text,
      };
    const style: RowStyle = {};
    for (const key of STYLE_KEYS[element.type])
      if (key !== 'label' && key in element)
        Object.assign(style, { [key]: element[key as keyof typeof element] });
    if (element.type === 'angle' && element.label) style.label = element.label;
    if (element.type === 'point') {
      const name = rowNames.get(element.id);
      if (element.name !== name) style.label = element.name ?? '';
    }
    return {
      key: element.id,
      kind: 'expression',
      latex: rowLatex(element, nameOf),
      parsed: parsedOf(element, nameOf),
      style,
    };
  });
}

function parsedOf(
  element: Exclude<GraphElement, { type: 'text' }>,
  nameOf: (id: string) => string
): ParsedRow {
  switch (element.type) {
    case 'point':
      return {
        coords: element.coords,
        kind: 'point',
        name: nameOf(element.id) || undefined,
      };
    case 'functiongraph':
      return { domain: element.domain, kind: 'function', term: element.term };
    case 'circle':
      return {
        command: 'circle',
        kind: 'command',
        points: [nameOf(element.center)],
        radius: element.radius,
      };
    case 'arc':
    case 'sector':
      return {
        command: element.type,
        kind: 'command',
        points: [element.center, ...element.points].map(nameOf),
      };
    default:
      return {
        command: element.type,
        kind: 'command',
        points: element.points.map(nameOf),
      };
  }
}

/** The rows for elements a peer's change rebased into the dialog's draft
 * (Epo 2026-10-17): a row whose element is unchanged stays as typed, a row
 * giving no element yet (unfinished, or not drawable) stays where it was, and
 * the rest come from the elements. The same rows when nothing changed. */
export function syncRows(
  rows: GraphRow[],
  elements: GraphElement[]
): GraphRow[] {
  const built = new Map(
    buildElements(rows).elements.map((element) => [element.id, element])
  );
  const ids = new Set(elements.map((element) => element.id));
  const next = rowsFromElements(elements).map((row, i) => {
    const held = rows.find((item) => item.key === row.key);
    return held && sameJson(built.get(row.key), elements[i]) ? held : row;
  });
  rows.forEach((row, at) => {
    if (!(built.has(row.key) || ids.has(row.key)))
      next.splice(Math.min(at, next.length), 0, row);
  });
  return next.length === rows.length && next.every((row, i) => row === rows[i])
    ? rows
    : next;
}

/** The recipe the rows describe, and the rows that cannot be drawn. */
export function buildElements(rows: GraphRow[]): {
  elements: GraphElement[];
  errors: Map<string, string>;
} {
  const errors = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'expression') continue;
    if (row.error) errors.set(row.key, row.error);
    const name = row.parsed?.kind === 'point' ? row.parsed.name : undefined;
    if (!name) continue;
    if (ids.has(name))
      errors.set(row.key, m.question_ui_graph_row_taken({ name }));
    else ids.set(name, row.key);
  }
  const elements: GraphElement[] = [];
  for (const row of rows) {
    if (row.kind === 'label') {
      if (!row.text.trim()) {
        errors.set(row.key, m.question_ui_graph_row_unfinished());
        continue;
      }
      elements.push({
        coords: row.coords,
        id: row.key,
        text: row.text,
        type: 'text',
        ...(row.hidden && { hidden: true }),
      });
      continue;
    }
    if (errors.has(row.key) || !row.parsed) continue;
    try {
      elements.push(
        styled(toElement(row.key, row.parsed, row.style, ids), row.style)
      );
    } catch (error) {
      if (!(error instanceof RowError)) throw error;
      errors.set(row.key, error.message);
    }
  }
  return { elements, errors };
}

function toElement(
  id: string,
  parsed: ParsedRow,
  style: RowStyle,
  ids: Map<string, string>
): GraphElement {
  if (parsed.kind === 'point') {
    const label = style.label === undefined ? parsed.name : style.label;
    return {
      coords: parsed.coords,
      id,
      type: 'point',
      ...(label && { name: label }),
    };
  }
  if (parsed.kind === 'function')
    return {
      id,
      term: parsed.term,
      type: 'functiongraph',
      ...(parsed.domain && { domain: parsed.domain }),
    };
  const points = parsed.points.map((name) => {
    const point = ids.get(name);
    if (!point) throw new RowError(m.question_ui_graph_row_undefined({ name }));
    return point;
  });
  if (new Set(points).size !== points.length)
    throw new RowError(m.question_ui_select_different_points());
  switch (parsed.command) {
    case 'circle':
      return {
        center: points[0],
        id,
        radius: parsed.radius ?? 1,
        type: 'circle',
      };
    case 'arc':
    case 'sector':
      return {
        center: points[0],
        id,
        points: [points[1], points[2]],
        type: parsed.command,
      };
    case 'angle':
      return { id, points: points as [string, string, string], type: 'angle' };
    case 'polygon':
      if (points.length > limits.QUESTION_GRAPH_POLYGON_MAX)
        throw new RowError(
          m.question_ui_graph_row_points({ command: 'polygon' })
        );
      return { id, points, type: 'polygon' };
    default:
      return { id, points: points as [string, string], type: parsed.command };
  }
}
