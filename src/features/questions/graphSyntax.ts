/* Desmos-style graph rows: the LaTeX typed in a row's MathLive field ↔ recipe
 * elements. A formula row is stored as typed, as Desmos stores it (Epo
 * 2026-11-18, "the desmos one makes the most sense, store user input as is"),
 * and read here wherever it is drawn: `y=…`, `f(x)=…` or a bare expression in
 * x is a function of x, any other equation in x and y an implicit curve.
 * Points and commands are stored as elements and written back as LaTeX. The
 * reader is ours, not MathLive's, so previews draw without loading MathLive. */
import * as limits from '@/api/limits.generated';
import {
  type FreeMark,
  isFreeMark,
  type RowElement,
} from '@/features/graph/model';
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
/** A row still being typed (`y = 2x +`): it draws nothing and says nothing
 * until it reads (Epo 2026-11-18, "never show this"), as an empty row. */
class UnfinishedRow extends RowError {}

/** The functions a row may call, read as Desmos reads them (Epo 2026-11-18,
 * "the desmos one makes the most sense"): `log` is base 10 (`\log_{b}` base
 * b, `log(x, b)` too), `ln` natural; `root` is `\sqrt[n]{x}`, odd roots of
 * a negative number negative. */
const CALLS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  ceil: Math.ceil,
  cos: Math.cos,
  cosh: Math.cosh,
  cot: (a) => 1 / Math.tan(a),
  csc: (a) => 1 / Math.sin(a),
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: (a, b) => (b === undefined ? Math.log10(a) : Math.log(a) / Math.log(b)),
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  root: (a, n) =>
    a < 0 && Number.isInteger(n) && n % 2 !== 0
      ? -((-a) ** (1 / n))
      : a ** (1 / n),
  sec: (a) => 1 / Math.cos(a),
  sin: Math.sin,
  sinh: Math.sinh,
  sqrt: Math.sqrt,
  tan: Math.tan,
  tanh: Math.tanh,
};
/** `\sin^{-1}x` is arcsin x, as Desmos reads it. */
const INVERSES: Partial<Record<string, string>> = {
  cos: 'acos',
  sin: 'asin',
  tan: 'atan',
};
const FUNCTIONS = new Set(Object.keys(CALLS));
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
const FUNCTION_OF_X = /^[A-Za-z] \( x \)$/;
/** `P_1` → `P_{1}` for LaTeX. */
const subscript = (name: string) => name.replace(SUBSCRIPT, '_{$1}');
/** Longest first, so `asin` wins over `sin` when splitting `asinx`. */
const WORDS = [...FUNCTIONS, ...Object.keys(COMMANDS)].sort(
  (a, b) => b.length - a.length
);

type Token = { k: 'num' | 'name' | 'op'; v: string };
const op = (v: string): Token => ({ k: 'op', v });
const named = (v: string): Token => ({ k: 'name', v });
const paren = (tokens: Token[]) => [op('('), ...tokens, op(')')];

/** The commands MathLive writes that read as one token. */
const SYMBOLS: Record<string, Token> = {
  '{': op('{'),
  '}': op('}'),
  arccos: named('acos'),
  arcsin: named('asin'),
  arctan: named('atan'),
  ast: op('*'),
  cdot: op('*'),
  div: op('/'),
  exponentialE: named('e'),
  ge: op('>='),
  geq: op('>='),
  geqslant: op('>='),
  gt: op('>'),
  lbrace: op('{'),
  lbrack: op('('),
  le: op('<='),
  leq: op('<='),
  leqslant: op('<='),
  lparen: op('('),
  lt: op('<'),
  lvert: op('|'),
  mid: op('|'),
  pi: named('pi'),
  rbrace: op('}'),
  rbrack: op(')'),
  rparen: op(')'),
  rvert: op('|'),
  times: op('*'),
  vert: op('|'),
};
/** Spacing and sizing, which read as nothing. */
const SILENT = new Set([
  ' ',
  '!',
  ',',
  ':',
  ';',
  'Big',
  'Bigg',
  'Biggl',
  'Biggr',
  'Bigl',
  'Bigr',
  'big',
  'bigg',
  'biggl',
  'biggr',
  'bigl',
  'bigr',
  'displaystyle',
  'qquad',
  'quad',
]);
/** `\left` and `\right`, and MathLive's spacing-free `\mleft`/`\mright`. */
const OPENING = new Set(['left', 'mleft']);
const CLOSING = new Set(['right', 'mright']);
/** Commands whose argument reads as written: `\operatorname{floor}`. */
const UPRIGHT = new Set(['mathit', 'mathrm', 'operatorname', 'text']);
const PLAIN_OPS = new Set([...'+-*/(),|={}']);
const DIGIT = /[\d.]/;
const LETTER = /[A-Za-z]/;
const SPACE = /\s/;
const LETTERS = /[A-Za-z]+/y;
const NUMBER = /\d+(?:\.\d*)?|\.\d+/y;
const COMMAND_NAME = /[A-Za-z]+|[^A-Za-z]/y;
const WORD = /^\w+$/;

/** Tokens of a row's LaTeX: the subset MathLive writes (fractions, roots,
 * powers, subscripted names, `\left…\right` brackets, `\cdot`, named
 * functions, `\le` and braces) and the plain text it reads the same as
 * (`sin(x)`, `x^(2)`, `*`). A bare `{…}` is a restriction's braces. */
function tokenize(source: string): Token[] {
  const s = source
    .replace(/[≤⩽]/g, '\\le ')
    .replace(/[≥⩾]/g, '\\ge ')
    .replace(/[−–]/g, '-')
    .replace(/[·×⋅]/g, '*')
    .replace(/π/g, '\\pi ');
  let i = 0;
  const unreadable = () => new RowError(m.question_ui_graph_row_unreadable());
  const space = () => {
    while (i < s.length && SPACE.test(s[i])) i++;
  };
  const read = (pattern: RegExp) => {
    pattern.lastIndex = i;
    const found = pattern.exec(s);
    if (!found) throw unreadable();
    i = pattern.lastIndex;
    return found[0];
  };
  /** Tokens up to `close`, which is passed. */
  const until = (close: string): Token[] => {
    const out: Token[] = [];
    for (;;) {
      space();
      if (i >= s.length) throw new UnfinishedRow();
      if (s[i] === close) {
        i++;
        return out;
      }
      out.push(...atom(false));
    }
  };
  /** A command's argument: a braced group, or one letter, number or command. */
  const argument = (): Token[] => {
    space();
    if (s[i] === '{') {
      i++;
      return until('}');
    }
    return atom(true);
  };
  const command = (name: string): Token[] => {
    if (name === 'placeholder') throw new UnfinishedRow();
    if (SILENT.has(name)) return [];
    if (OPENING.has(name) || CLOSING.has(name)) {
      space();
      if (s[i] === '.') {
        i++;
        return [];
      }
      const delimiter = atom(true);
      // `\left| … \right|` is unambiguous, unlike a bare bar.
      if (delimiter[0]?.v !== '|') return delimiter;
      return OPENING.has(name) ? [named('abs'), op('(')] : [op(')')];
    }
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const top = argument();
      return paren([...paren(top), op('/'), ...paren(argument())]);
    }
    if (name === 'sqrt') {
      space();
      if (s[i] !== '[') return [named('sqrt'), ...paren(argument())];
      i++;
      const index = until(']');
      return [named('root'), ...paren([...argument(), op(','), ...index])];
    }
    if (name === 'lfloor' || name === 'lceil')
      return [named(name.slice(1)), op('(')];
    if (name === 'rfloor' || name === 'rceil') return [op(')')];
    // `\log_{b}x` is ln x / ln b.
    if (name === 'log' && s[i] === '_') {
      i++;
      const base = argument();
      return [
        ...paren([{ k: 'num', v: '1' }, op('/'), named('ln'), ...paren(base)]),
        named('ln'),
      ];
    }
    if (UPRIGHT.has(name)) {
      // `\operatorname*{…}` reads as `\operatorname{…}`.
      if (s[i] === '*') i++;
      return argument();
    }
    const symbol = SYMBOLS[name];
    if (symbol) return [symbol];
    if (FUNCTIONS.has(name)) return [named(name)];
    // `\theta`: a name, which the row then says is not defined.
    if (LETTER.test(name)) return [named(name)];
    throw unreadable();
  };
  /** The next token or tokens; `single` reads one letter, as a command's
   * argument does. */
  const atom = (single: boolean): Token[] => {
    space();
    if (i >= s.length) throw new UnfinishedRow();
    const c = s[i];
    if (DIGIT.test(c)) {
      if (!(single && c !== '.')) return [{ k: 'num', v: read(NUMBER) }];
      i++;
      return [{ k: 'num', v: c }];
    }
    if (LETTER.test(c)) {
      if (single) {
        i++;
        return [named(c)];
      }
      const word = read(LETTERS);
      if (s[i] !== '_') return splitName(word);
      i++;
      const sub = argument()
        .map((token) => token.v)
        .join('');
      if (!WORD.test(sub)) throw unreadable();
      return splitName(`${word}_${sub}`);
    }
    i++;
    if (c === '\\') return command(read(COMMAND_NAME));
    if (c === '^') {
      space();
      // `x^(2)` as plain text writes it; else as LaTeX reads it, `x^23` x²·3.
      if (s[i] === '(') return [op('^')];
      return [op('^'), ...paren(argument())];
    }
    if (c === '[') return [op('(')];
    if (c === ']') return [op(')')];
    if (c === '<' || c === '>') {
      if (s[i] !== '=') return [op(c)];
      i++;
      return [op(`${c}=`)];
    }
    if (PLAIN_OPS.has(c)) return [op(c)];
    throw unreadable();
  };
  const tokens: Token[] = [];
  for (space(); i < s.length; space()) tokens.push(...atom(false));
  return tokens;
}

/** `sinx` → sin x, `xy` → x y, `A_1` stays one name. */
function splitName(name: string): Token[] {
  if (name.includes('_')) {
    const [base, sub] = name.split('_');
    return [...splitName(base.slice(0, -1)), named(`${base.slice(-1)}_${sub}`)];
  }
  const out: Token[] = [];
  let rest = name;
  while (rest) {
    const word = WORDS.find((w) => rest.startsWith(w));
    const constant = rest.startsWith('pi') ? 'pi' : undefined;
    const take = word ?? constant ?? rest[0];
    out.push(named(take));
    rest = rest.slice(take.length);
  }
  return out;
}

class Parser {
  private i = 0;
  /** Bars open round what is being read: inside one, a bar closes it. */
  private bars = 0;
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
    if (!token) throw new UnfinishedRow();
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
    // `2|x|`: a bar opens an absolute value unless one is open already.
    if (token.v === '|') return this.bars === 0;
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
      this.bars++;
      const inner = this.expression();
      this.expect('|');
      this.bars--;
      return { args: [inner], fn: 'abs', t: 'call' };
    }
    if (token.k !== 'name')
      throw this.done()
        ? new UnfinishedRow()
        : new RowError(m.question_ui_graph_row_unreadable());
    if (FUNCTIONS.has(token.v) || token.v in COMMANDS)
      return this.call(token.v);
    return { t: 'name', v: token.v };
  }

  /** `sin(x)`, `sin x`, `sin 2x`, `cos^2 x` (the square of cos x),
   * `sin^{-1} x` (arcsin x). */
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
    else throw new UnfinishedRow();
    const inverse = INVERSES[fn];
    if (
      inverse &&
      exponent?.t === 'neg' &&
      exponent.a.t === 'num' &&
      exponent.a.v === 1
    )
      return { args, fn: inverse, t: 'call' };
    const node: Node = { args, fn, t: 'call' };
    return exponent ? { a: node, b: exponent, op: '^', t: 'bin' } : node;
  }
}

function parse(tokens: Token[]): Node {
  const parser = new Parser(tokens);
  const node = parser.expression();
  if (!parser.done()) throw new RowError(m.question_ui_graph_row_unreadable());
  return node;
}

const ARITY: Partial<Record<string, number>> = {
  log: 2,
  max: 2,
  min: 2,
  pow: 2,
  root: 2,
};

function checkArity(node: Extract<Node, { t: 'call' }>) {
  const most = ARITY[node.fn] ?? 1;
  const least = node.fn === 'log' ? 1 : most;
  if (node.args.length < least || node.args.length > most)
    throw new RowError(m.question_ui_graph_row_unreadable());
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

/** Names an expression reads. */
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

/** The first name an expression reads that is not one of `variables` or a
 * constant. */
const undefinedName = (node: Node, variables: string[]) =>
  [...names(node)].find(
    (name) => !(variables.includes(name) || CONSTANTS.has(name))
  );

type Evaluate = (x: number, y: number) => number;

/** An expression as a function of x and y. */
function compile(node: Node): Evaluate {
  switch (node.t) {
    case 'num': {
      const { v } = node;
      return () => v;
    }
    case 'name':
      if (node.v === 'x') return (x) => x;
      if (node.v === 'y') return (_, y) => y;
      if (node.v === 'pi') return () => Math.PI;
      if (node.v === 'e') return () => Math.E;
      throw new RowError(m.question_ui_graph_row_undefined({ name: node.v }));
    case 'neg': {
      const a = compile(node.a);
      return (x, y) => -a(x, y);
    }
    case 'bin': {
      const [a, b] = [compile(node.a), compile(node.b)];
      if (node.op === '+') return (x, y) => a(x, y) + b(x, y);
      if (node.op === '-') return (x, y) => a(x, y) - b(x, y);
      if (node.op === '*') return (x, y) => a(x, y) * b(x, y);
      if (node.op === '/') return (x, y) => a(x, y) / b(x, y);
      return (x, y) => a(x, y) ** b(x, y);
    }
    case 'call': {
      // A command such as line(x) reads as a call but isn't a function.
      const fn = CALLS[node.fn];
      if (!fn) throw new RowError(m.question_ui_graph_row_unreadable());
      checkArity(node);
      const [a, b] = node.args.map(compile);
      return b ? (x, y) => fn(a(x, y), b(x, y)) : (x, y) => fn(a(x, y));
    }
    case 'tuple':
      throw new RowError(m.question_ui_graph_row_unreadable());
  }
}

function number(node: Node) {
  if (node.t === 'tuple' || undefinedName(node, []))
    throw new RowError(m.question_ui_graph_row_needs_number());
  const value = compile(node)(0, 0);
  if (!Number.isFinite(value))
    throw new RowError(m.question_ui_graph_row_needs_number());
  return Number(value.toPrecision(12));
}

/** A point's row name: one letter with an optional subscript (`A`, `P_1`). */
const POINT_NAME = /^[A-Za-z](?:_[A-Za-z0-9]+)?$/;
const RESERVED = new Set(['x', 'y', 'e']);

/** What a row parses to, before the editor adds its id and style. A formula
 * row keeps its LaTeX as typed. */
export type ParsedRow =
  | { kind: 'point'; name?: string; coords: [number, number] }
  | { kind: 'expression'; latex: string }
  | { kind: 'command'; command: Command; points: string[]; radius?: number };

/** A formula row as it is drawn: a function of x, or an implicit curve where
 * `at(x, y)` (left side less right) is 0. A restriction limits x. */
export type Expression = { domain?: [number, number] } & (
  | { kind: 'function'; at: (x: number) => number }
  | { kind: 'equation'; at: Evaluate }
);

type Read =
  | Exclude<ParsedRow, { kind: 'expression' }>
  | ({ domain?: [number, number] } & (
      | { kind: 'function'; at: Evaluate }
      | { kind: 'equation'; at: Evaluate }
    ));

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

/** A function of x: the names it reads checked first, so `y = x + k` says k
 * is not defined. */
function functionOfX(node: Node, domain?: [number, number]): Read {
  const name = undefinedName(node, ['x']);
  if (name) throw new RowError(m.question_ui_graph_row_undefined({ name }));
  return { at: compile(node), domain, kind: 'function' };
}

/** Reads one row's LaTeX; throws `RowError` with copy for the row's tooltip.
 * `y = …` and `f(x) = …` in x alone, or a bare expression in x, are functions;
 * any other equation in x and y is an implicit curve (Epo 2026-11-18). */
function readLatex(latex: string): Read {
  let tokens = tokenize(latex);
  // Brackets left open at the end close themselves, as in Desmos.
  const open =
    tokens.filter((token) => token.v === '(').length -
    tokens.filter((token) => token.v === ')').length;
  for (let i = 0; i < open; i++) tokens.push(op(')'));
  if (!tokens.length) throw new UnfinishedRow();
  // A trailing `{a <= x <= b}` restricts x.
  let domain: [number, number] | undefined;
  if (tokens.at(-1)?.v === '}') {
    const open = tokens.map((token) => token.v).lastIndexOf('{');
    if (open < 0) throw new RowError(m.question_ui_graph_row_unreadable());
    domain = parseDomain(tokens.slice(open + 1, -1));
    tokens = tokens.slice(0, open);
    if (!tokens.length) throw new UnfinishedRow();
  }
  if (splitTop(tokens, ['<', '>', '<=', '>=']) >= 0)
    throw new RowError(m.question_ui_graph_row_not_yet());
  const equals = splitTop(tokens, ['=']);
  if (equals < 0) {
    const node = parse(tokens);
    if (node.t === 'tuple') return pointRow(node, undefined, domain);
    if (node.t === 'call' && node.fn in COMMANDS) {
      if (domain) throw new RowError(m.question_ui_graph_row_unreadable());
      return commandRow(node.fn as Command, node.args);
    }
    // A bare expression in x is a function, as in Desmos.
    return functionOfX(node, domain);
  }
  const left = tokens.slice(0, equals);
  const right = tokens.slice(equals + 1);
  if (!(left.length && right.length)) throw new UnfinishedRow();
  if (splitTop(right, ['=']) >= 0)
    throw new RowError(m.question_ui_graph_row_unreadable());
  const lhs = source(left);
  const value = parse(right);
  if (left.length === 1 && POINT_NAME.test(lhs) && !RESERVED.has(lhs)) {
    if (value.t === 'tuple') return pointRow(value, lhs, domain);
    throw new RowError(m.question_ui_graph_row_not_yet());
  }
  if (FUNCTION_OF_X.test(lhs) || (lhs === 'y' && !names(value).has('y')))
    return functionOfX(value, domain);
  const node: Node = { a: parse(left), b: value, op: '-', t: 'bin' };
  const name = undefinedName(node, ['x', 'y']);
  if (name) throw new RowError(m.question_ui_graph_row_undefined({ name }));
  return { at: compile(node), domain, kind: 'equation' };
}

/** Parses one row's LaTeX; throws `RowError` with copy for the row's tooltip. */
export function parseRow(latex: string): ParsedRow {
  const read = readLatex(latex);
  if (read.kind !== 'function' && read.kind !== 'equation') return read;
  if ([...latex].length > limits.QUESTION_GRAPH_EXPRESSION_MAX)
    throw new RowError(m.question_ui_graph_row_too_long());
  return { kind: 'expression', latex };
}

/** A stored formula row as every graph draws it. Throws `RowError` on LaTeX
 * that isn't one. */
export function readExpression(latex: string): Expression {
  const read = readLatex(latex);
  if (read.kind === 'equation') return read;
  if (read.kind !== 'function')
    throw new RowError(m.question_ui_graph_row_unreadable());
  const { at, domain } = read;
  return { at: (x) => at(x, 0), domain, kind: 'function' };
}

/** A restriction on x: `a < x < b`, or one side, `x > a` or `x \le b`, the
 * other open (as Desmos). Strict and not are drawn alike. */
function parseDomain(tokens: Token[]): [number, number] {
  const COMPARE = ['<', '<=', '>', '>='];
  const below = (v: string) => v[0] === '<';
  const first = splitTop(tokens, COMPARE);
  if (first < 0) throw new RowError(m.question_ui_graph_row_domain());
  const before = tokens.slice(0, first);
  const after = tokens.slice(first + 1);
  const less = below(tokens[first].v);
  const second = splitTop(after, COMPARE);
  if (second < 0) {
    if (source(before) === 'x') {
      const bound = number(parse(after));
      return less
        ? [Number.NEGATIVE_INFINITY, bound]
        : [bound, Number.POSITIVE_INFINITY];
    }
    if (source(after) === 'x') {
      const bound = number(parse(before));
      return less
        ? [bound, Number.POSITIVE_INFINITY]
        : [Number.NEGATIVE_INFINITY, bound];
    }
    throw new RowError(m.question_ui_graph_row_domain());
  }
  if (source(after.slice(0, second)) !== 'x' || below(after[second].v) !== less)
    throw new RowError(m.question_ui_graph_row_domain());
  const ends = [number(parse(before)), number(parse(after.slice(second + 1)))];
  const [from, to] = less ? ends : ends.reverse();
  if (from >= to)
    throw new RowError(m.question_ui_enter_a_valid_function_domain());
  return [from, to];
}

function pointRow(
  node: Extract<Node, { t: 'tuple' }>,
  name: string | undefined,
  domain: [number, number] | undefined
): Read {
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

function commandRow(command: Command, args: Node[]): Read {
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

/** LaTeX for a row's math field. `nameOf` gives each point id's row name. */
function rowLatex(element: RowElement, nameOf: (id: string) => string): string {
  const points = (ids: string[]) =>
    `\\left(${ids.map(nameOf).map(subscript).join(',')}\\right)`;
  switch (element.type) {
    case 'expression':
      return element.latex;
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
function pointLatex(name: string | undefined, [x, y]: [number, number]) {
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
  /** A segment's arrowhead, kept: no row writes one yet. */
  arrow?: boolean;
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
      /** Its text size, kept: no row sets one yet. */
      size?: number;
      hidden?: boolean;
    }
  | {
      /** A free mark (a stroke, curve, ellipse or formula), kept as it is in
       * its place: no row writes one yet. */
      kind: 'mark';
      key: string;
      element: FreeMark;
    };

const STYLE_KEYS: Record<RowElement['type'], (keyof RowStyle)[]> = {
  angle: ['hidden', 'label'],
  arc: ['dash', 'hidden'],
  circle: ['dash', 'hidden'],
  expression: ['dash', 'hidden'],
  line: ['dash', 'hidden'],
  point: ['hidden'],
  polygon: ['dash', 'shade', 'hidden'],
  sector: ['dash', 'shade', 'hidden'],
  segment: ['dash', 'ticks', 'arrow', 'hidden'],
  text: ['hidden'],
};

/** The style keys a row's element takes, for its style menu. */
export const styleKeys = (type: RowElement['type']) => STYLE_KEYS[type];

function styled<T extends RowElement>(element: T, style: RowStyle): T {
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
      ...(element.type === 'circle' ||
      element.type === 'arc' ||
      element.type === 'sector'
        ? [element.center]
        : []),
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
    if (isFreeMark(element)) return { element, key: element.id, kind: 'mark' };
    if (element.type === 'text')
      return {
        coords: element.coords,
        hidden: element.hidden,
        key: element.id,
        kind: 'label',
        size: element.size,
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
  element: Exclude<RowElement, { type: 'text' }>,
  nameOf: (id: string) => string
): ParsedRow {
  switch (element.type) {
    case 'point':
      return {
        coords: element.coords,
        kind: 'point',
        name: nameOf(element.id) || undefined,
      };
    case 'expression':
      return { kind: 'expression', latex: element.latex };
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

/** The rows following a figure's elements (Epo 2026-11-16, live figures): a
 * row whose element is unchanged stays as typed, and a row holding what the
 * figure does not have yet (`typing`) stays as it is, where the elements put
 * it or, lacking one, where it was; the rest come from the elements, and a
 * row whose element went goes. `built` is the rows' own elements by id. The
 * same rows when nothing changed. */
export function reconcileRows(
  rows: GraphRow[],
  elements: GraphElement[],
  built: ReadonlyMap<string, GraphElement>,
  typing: (key: string) => boolean
): GraphRow[] {
  const held = new Map(rows.map((row) => [row.key, row]));
  const ids = new Set(elements.map((element) => element.id));
  const next = rowsFromElements(elements).map((row, i) => {
    const local = held.get(row.key);
    return local &&
      (typing(row.key) || sameJson(built.get(row.key), elements[i]))
      ? local
      : row;
  });
  rows.forEach((row, at) => {
    if (!ids.has(row.key) && typing(row.key))
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
    if (row.kind === 'mark') {
      elements.push(row.element);
      continue;
    }
    if (row.kind === 'label') {
      if (!row.text.trim()) continue;
      elements.push({
        coords: row.coords,
        id: row.key,
        text: row.text,
        type: 'text',
        ...(row.size && { size: row.size }),
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
): RowElement {
  if (parsed.kind === 'point') {
    const label = style.label === undefined ? parsed.name : style.label;
    return {
      coords: parsed.coords,
      id,
      type: 'point',
      ...(label && { name: label }),
    };
  }
  if (parsed.kind === 'expression')
    return { id, latex: parsed.latex, type: 'expression' };
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

/** A row for an element a tool made or changed (Epo 2026-11-16, each editor
 * gains the other's tools): a point keeps its row's name and style, or a new
 * one the name the Point tool gave it; a label its row's hidden flag; a free
 * mark's row holds it as it is. */
function toolRow(element: GraphElement, row?: GraphRow): GraphRow {
  if (isFreeMark(element)) return { element, key: element.id, kind: 'mark' };
  if (element.type === 'text')
    return {
      coords: element.coords,
      key: element.id,
      kind: 'label',
      text: element.text,
      ...(element.size && { size: element.size }),
      ...(element.hidden && { hidden: true }),
    };
  if (element.type === 'point') {
    const expression = row?.kind === 'expression' ? row : undefined;
    const name = expression
      ? expression.parsed?.kind === 'point'
        ? expression.parsed.name
        : undefined
      : element.name;
    return {
      key: element.id,
      kind: 'expression',
      latex: pointLatex(name, element.coords),
      parsed: { coords: element.coords, kind: 'point', name },
      style: expression?.style ?? {},
    };
  }
  // Tools move a function or construction only by its points.
  if (row) return row;
  throw new Error(`No tool makes a ${element.type}`);
}

/** The rows after a tool changed the elements they give: `before` is what the
 * tool saw (the rows' elements) and `next` what it made of them. A row whose
 * element is the same object stays as typed, a changed one follows it, a new
 * element gets a row at the end and a gone one loses its row. Rows that give
 * no element (an error) stay. */
export function rowsAfterEdit(
  rows: GraphRow[],
  before: readonly GraphElement[],
  next: readonly GraphElement[]
): GraphRow[] {
  const was = new Map(before.map((element) => [element.id, element]));
  const now = new Map(next.map((element) => [element.id, element]));
  const out = rows.flatMap((row): GraphRow[] => {
    const element = now.get(row.key);
    if (!element) return was.has(row.key) ? [] : [row];
    return [element === was.get(row.key) ? row : toolRow(element, row)];
  });
  const keys = new Set(rows.map((row) => row.key));
  for (const element of next)
    if (!keys.has(element.id)) out.push(toolRow(element));
  return out;
}

const coordinate = (value: number) =>
  String(Number(value.toPrecision(12))).replace('-', '−');
const pairText = ([x, y]: [number, number]) =>
  `(${coordinate(x)}, ${coordinate(y)})`;

/** The points typed in a line's row: `(2, 1)`, with either minus. */
const typedPairs = (text: string): [number, number][] =>
  [
    ...text
      .replace(/[−–]/g, '-')
      .matchAll(/\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)/g),
  ].map((match) => [Number(match[1]), Number(match[2])]);

/** A free mark's row as both editors list it (Epo 2026-11-13, L2): a line or
 * vector from one point to the other, typed in place; a curve, ellipse or
 * formula, shaped on the graph, only by its kind's name (`typed` false). */
export function markRow(mark: FreeMark): { text: string; typed: boolean } {
  if (mark.type === 'polyline' && mark.coords.length === 2)
    return {
      text: m.drawing_board_plane_from_to({
        from: pairText(mark.coords[0]),
        to: pairText(mark.coords[1]),
      }),
      typed: true,
    };
  return {
    text:
      mark.type === 'curve'
        ? m.chrome_curve()
        : mark.type === 'ellipse'
          ? m.drawing_board_ellipse()
          : mark.type === 'formula'
            ? m.drawing_board_plane_formula()
            : mark.arrow
              ? m.drawing_board_vector()
              : m.drawing_board_line(),
    typed: false,
  };
}

/** A line's row typed in place: the line through its two typed points, or
 * null when the text does not hold two. */
export function typedLine(mark: FreeMark, text: string): FreeMark | null {
  const pairs = typedPairs(text);
  return mark.type === 'polyline' && pairs.length === 2
    ? { ...mark, coords: pairs }
    : null;
}

/** What a row's typing reads as: nothing while empty, else its parse or the
 * error its row shows. */
export function readRow(latex: string) {
  if (!latex.trim()) return { error: undefined, parsed: undefined };
  try {
    return { error: undefined, parsed: parseRow(latex) };
  } catch (error) {
    if (!(error instanceof RowError)) throw error;
    return {
      error: error instanceof UnfinishedRow ? undefined : error.message,
      parsed: undefined,
    };
  }
}

/** The icon (`TOOL_ICONS`) of a row that gives no element yet: its parse's. */
export function parsedKind(parsed: ParsedRow) {
  return parsed.kind === 'point'
    ? 'point'
    : parsed.kind === 'expression'
      ? 'function'
      : parsed.command === 'line'
        ? 'through'
        : parsed.command;
}
