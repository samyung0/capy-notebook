import type { TElement, TText, Value } from 'platejs';
import {
  BOLD,
  ITALIC,
  type MarkedToken,
  markBits,
  parseMarkedText,
  UNDERLINE,
} from './parseMarkedText';
import { GAP_MARKER, gapText } from './types';

/** A gaps part's blank in the editor: numbered by its place, so it holds
 * only an id that keeps its accepted answers with it as blanks come and go. */
export const GAP_TYPE = 'gap';

const LEADING_BREAKS = /^\n+/;
const TRAILING_BREAKS = /\n+$/;
const SPACE_END = /\s$/;
const SPACE_START = /^\s/;

/** What joins two paragraphs a display formula stood between: nothing where
 * the seam has a space, else a line break, never a paragraph gap. */
export const seamGlue = (before: string, after: string) =>
  before && after && !SPACE_END.test(before) && !SPACE_START.test(after)
    ? '\n'
    : '';

const marksOf = ({ bold, italic, underline }: MarkedToken) => ({
  ...(bold && { bold }),
  ...(italic && { italic }),
  ...(underline && { underline }),
});

export function mathTextToValue(
  text: string,
  { gaps = false }: { gaps?: boolean } = {}
): Value {
  const nodes: TElement[] = [];
  let children: TElement['children'] = [{ text: '' }];
  let blanks = 0;
  const hasContent = () =>
    children.some(
      (node) =>
        'type' in node ||
        (typeof node.text === 'string' && node.text.length > 0)
    );
  const flush = () => {
    if (hasContent()) nodes.push({ children, type: 'p' });
    children = [{ text: '' }];
  };
  // Plain text, its "(n) ______" markers as blanks in a gaps part.
  const pushText = (value: string, marks: Partial<TText>) => {
    if (!gaps) {
      children.push({ text: value, ...marks });
      return;
    }
    let at = 0;
    for (const match of value.matchAll(GAP_MARKER)) {
      children.push(
        { text: value.slice(at, match.index), ...marks },
        { children: [{ text: '' }], id: `g${blanks++}`, type: GAP_TYPE },
        { text: '', ...marks }
      );
      at = match.index + match[0].length;
    }
    children.push({ text: value.slice(at), ...marks });
  };
  const tokens = parseMarkedText(text);
  for (const [at, token] of tokens.entries()) {
    const marks = marksOf(token);
    if (token.type === 'display') {
      if (hasContent()) flush();
      nodes.push({
        children: [{ text: '' }],
        texExpression: token.value,
        type: 'equation',
      });
    } else if (token.type === 'inline') {
      // A formula sits inside the marks the text on both its sides carries.
      children.push(
        { text: '', ...marks },
        {
          children: [{ text: '' }],
          texExpression: token.value,
          type: 'inline_equation',
        },
        { text: '', ...marks }
      );
    } else {
      // Line breaks against a display formula are its own line's, drawn
      // as no paragraph, as the closed text draws them.
      let value = token.value;
      if (tokens[at - 1]?.type === 'display')
        value = value.replace(LEADING_BREAKS, '');
      if (tokens[at + 1]?.type === 'display')
        value = value.replace(TRAILING_BREAKS, '');
      const paragraphs = value.split('\n\n');
      paragraphs.forEach((part, i) => {
        if (i) flush();
        pushText(part, marks);
      });
    }
  }
  if (hasContent()) flush();
  if (!nodes.length) nodes.push({ children: [{ text: '' }], type: 'p' });
  return nodes;
}

/** A paragraph's pieces: a character or a formula/blank written whole, with
 * the marks it sits in. */
type Piece = { text: string; bits: number; char: boolean };

const MARKERS: [number, string][] = [
  [BOLD, '**'],
  [ITALIC, '*'],
  [UNDERLINE, '__'],
];

const SPACE = /\s/;
const isSpace = (piece: Piece) => piece.char && SPACE.test(piece.text);

/** Marker characters typed as text: escaped only when they would read as
 * markers, so text as `2 * 3` or a `______` blank stays as written. */
const MARKER_CHARS = /[*_]/;

/** The text a value holds; its blanks numbered from `gapStart` in order. */
export function valueToMathText(value: Value, gapStart = 1): string {
  let number = gapStart;
  let marked = false;
  let markerChars = false;
  const collect = (
    children: Value[number]['children'],
    pieces: Piece[]
  ): Piece[] => {
    children.forEach((node, i) => {
      if ('text' in node && typeof node.text === 'string') {
        const bits = markBits(node);
        if (bits && node.text) marked = true;
        if (MARKER_CHARS.test(node.text)) markerChars = true;
        for (const text of node.text) pieces.push({ bits, char: true, text });
      } else if (node.type === 'inline_equation') {
        // An empty formula writes nothing: `$$` would read as text.
        if (!String(node.texExpression ?? '').trim()) return;
        // Inside the marks the text on both its sides carries.
        const [before, after] = [children[i - 1], children[i + 1]];
        const bits =
          before && after && 'text' in before && 'text' in after
            ? markBits(before) & markBits(after)
            : 0;
        if (bits) marked = true;
        pieces.push({
          bits,
          char: false,
          text: `$${String(node.texExpression ?? '')}$`,
        });
      } else if (node.type === GAP_TYPE)
        // A blank breaks marks, so a mark never spans one.
        pieces.push({ bits: 0, char: false, text: gapText(number++) });
      else collect((node as TElement).children, pieces);
    });
    return pieces;
  };
  const paragraphs: (Piece[] | string)[] = [];
  let joins = false;
  value.forEach((block, i) => {
    if (block.type === 'equation') {
      const tex = String(block.texExpression ?? '');
      if (tex.trim()) paragraphs.push(`$$${tex}$$`);
      // An empty formula writes nothing, and the text on its sides reads as
      // one paragraph, as taking the formula out joins them.
      else
        joins = Array.isArray(paragraphs.at(-1)) && value[i + 1]?.type === 'p';
      return;
    }
    const pieces = trimMarks(collect(block.children, []));
    const last = paragraphs.at(-1);
    if (joins && Array.isArray(last)) {
      const text = (list: Piece[]) => list.map((piece) => piece.text).join('');
      const glue = seamGlue(text(last), text(pieces));
      if (glue) last.push({ bits: 0, char: true, text: glue });
      last.push(...pieces);
    } else paragraphs.push(pieces);
    joins = false;
  });
  const write = (escapeMarkers: boolean) =>
    paragraphs
      .map((pieces) =>
        typeof pieces === 'string' ? pieces : writePieces(pieces, escapeMarkers)
      )
      .join('\n\n');
  const text = write(false);
  // Written as typed unless that reads back differently.
  if (!marked && !markerChars) return text;
  const readsBack = (written: string) =>
    signature(parseMarkedText(written)) === piecesSignature(paragraphs);
  if (readsBack(text)) return text;
  return write(true);
}

/** A mark leaves the spaces at its ends outside its markers. */
function trimMarks(pieces: Piece[]): Piece[] {
  for (const [mark] of MARKERS)
    for (let i = 0; i < pieces.length; ) {
      if (!(pieces[i].bits & mark)) {
        i++;
        continue;
      }
      let end = i;
      while (end < pieces.length && pieces[end].bits & mark) end++;
      let start = i;
      while (start < end && isSpace(pieces[start]))
        pieces[start++].bits &= ~mark;
      for (let j = end - 1; j >= start && isSpace(pieces[j]); j--)
        pieces[j].bits &= ~mark;
      i = end;
    }
  return pieces;
}

const markerOf = (mark: number) =>
  MARKERS.find(([bit]) => bit === mark)?.[1] ?? '';

/** A written unit: a typed character, a marker or a formula/blank whole. */
type Unit = { text: string; kind: 'char' | 'marker' | 'whole' };

function writePieces(pieces: Piece[], escapeMarkers: boolean): string {
  // Where a mark's run from a piece ends: the longer run opens outside.
  const runEnd = (at: number, mark: number) => {
    let end = at;
    while (end < pieces.length && pieces[end].bits & mark) end++;
    return end;
  };
  const units: Unit[] = [];
  const open: number[] = [];
  const marker = (mark: number) =>
    units.push({ kind: 'marker', text: markerOf(mark) });
  pieces.forEach((piece, i) => {
    const lowest = open.findIndex((mark) => !(piece.bits & mark));
    if (lowest >= 0) open.splice(lowest).reverse().forEach(marker);
    const opening = MARKERS.map(([mark]) => mark)
      .filter((mark) => piece.bits & mark && !open.includes(mark))
      .sort((a, b) => runEnd(i, b) - runEnd(i, a));
    for (const mark of opening) {
      marker(mark);
      open.push(mark);
    }
    units.push({ kind: piece.char ? 'char' : 'whole', text: piece.text });
  });
  open.reverse().forEach(marker);
  return writeUnits(units, escapeMarkers);
}

/** Typed characters escaped where they would read otherwise: a dollar always;
 * backslashes doubled right before a marker, dollar or escape; with
 * `escapeMarkers`, a `*` or `_` run that could pair (one to three `*`, two
 * `_`) or that touches a marker of its character, never longer runs as a
 * `______` blank. */
function writeUnits(units: Unit[], escapeMarkers: boolean): string {
  let out = '';
  for (let i = 0; i < units.length; i++) {
    const { kind, text } = units[i];
    if (kind !== 'char') {
      out += text;
      continue;
    }
    if (text === '$') {
      out += '\\$';
      continue;
    }
    if (text !== '\\' && text !== '*' && text !== '_') {
      out += text;
      continue;
    }
    let end = i + 1;
    while (units[end]?.kind === 'char' && units[end].text === text) end++;
    const length = end - i;
    const [before, after] = [units[i - 1], units[end]];
    if (text === '\\') {
      const next = after?.text[0];
      out += text.repeat(
        next === '*' || next === '_' || next === '$' ? length * 2 : length
      );
    } else {
      const touches = (unit: Unit | undefined) =>
        unit?.kind === 'marker' && unit.text[0] === text;
      const escaped =
        escapeMarkers &&
        ((text === '*' ? length <= 3 : length === 2) ||
          touches(before) ||
          touches(after));
      out += (escaped ? `\\${text}` : text).repeat(length);
    }
    i = end - 1;
  }
  return out;
}

/** Text and marks as one string, to compare what was written with what it
 * reads as. Formulas count by their place and marks only. */
const signature = (tokens: MarkedToken[]) =>
  tokens
    .map((token) => {
      const bits = String(markBits(token));
      if (token.type === 'inline') return `\u0001${bits}`;
      if (token.type === 'display') return '\u0002';
      return Array.from(token.value, (char) => char + bits).join('');
    })
    .join('');

const piecesSignature = (paragraphs: (Piece[] | string)[]) =>
  paragraphs
    .map((pieces) =>
      typeof pieces === 'string'
        ? '\u0002'
        : pieces
            .map((piece) =>
              piece.char
                ? piece.text + piece.bits
                : piece.text.startsWith('$')
                  ? `\u0001${piece.bits}`
                  : Array.from(piece.text, (char) => `${char}0`).join('')
            )
            .join('')
    )
    .join('\n0\n0');

/** The ids of a value's blanks, in reading order. */
export function gapIds(value: Value): string[] {
  const ids: string[] = [];
  const walk = (node: Value[number]['children'][number]) => {
    if ('text' in node) return;
    if (node.type === GAP_TYPE) ids.push(String(node.id));
    else (node as TElement).children.forEach(walk);
  };
  value.forEach(walk);
  return ids;
}
