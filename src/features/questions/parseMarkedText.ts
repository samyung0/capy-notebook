import { type MathTextToken, parseMathText } from './parseMathText';

/** Bold, italic and underline a question text marks, Discord style:
 * `**bold**`, `*italic*`, `__underline__`, nesting freely. */
export type Marks = { bold?: true; italic?: true; underline?: true };
export type MarkedToken = MathTextToken & Marks;

export const BOLD = 1;
export const ITALIC = 2;
export const UNDERLINE = 4;

/** A token's or editor leaf's marks as BOLD | ITALIC | UNDERLINE. */
export const markBits = (marks: Record<string, unknown>) =>
  (marks.bold ? BOLD : 0) |
  (marks.italic ? ITALIC : 0) |
  (marks.underline ? UNDERLINE : 0);

const marksOf = (bits: number): Marks => ({
  ...(bits & BOLD && { bold: true }),
  ...(bits & ITALIC && { italic: true }),
  ...(bits & UNDERLINE && { underline: true }),
});

/** A text character (escaped: written `\*` or `\_`, never a marker) or a
 * whole formula, which counts as one character of content. */
type Atom = { ch: string; escaped: boolean } | { token: MathTextToken };

type Run = {
  at: number;
  ch: string;
  length: number;
  left: number;
  canOpen: boolean;
  canClose: boolean;
  opens: number[];
  closes: number[];
};

const markerOf = (atom: Atom) =>
  'ch' in atom && !atom.escaped && (atom.ch === '*' || atom.ch === '_')
    ? atom.ch
    : '';

const SPACE = /\s/;
const MARKER_CHARS = /[*_]/;

const isSpace = (atom: Atom | undefined) =>
  !atom || ('ch' in atom && !atom.escaped && SPACE.test(atom.ch));

/** Text characters with their escapes: backslashes right before a marker
 * character pair up, `\\` a literal backslash and an odd one escaping it. */
function pushChars(value: string, atoms: Atom[]) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      atoms.push({ ch: value[i], escaped: false });
      continue;
    }
    let end = i;
    while (value[end] === '\\') end++;
    const next = value[end];
    const marker = next === '*' || next === '_';
    const literal = marker ? (end - i) >> 1 : end - i;
    for (let k = 0; k < literal; k++) atoms.push({ ch: '\\', escaped: false });
    if (marker && (end - i) % 2) {
      atoms.push({ ch: next, escaped: true });
      end++;
    }
    i = end - 1;
  }
}

/** Text and formulas with their marks. Only tight pairs mark: a run of one to
 * three `*` or exactly two `_` that touches its content (no space just inside),
 * so `2 * 3 * 4`, `______` blanks and anything inside `$…$` stay as written.
 * Unlike CommonMark's `_`, a `__` marks inside a word as `**` does (Epo
 * 2026-11-15), so `the__key__word` and Chinese text underline. A backslash escapes a marker
 * character, as `\$` escapes a dollar, and `\\` before one is a backslash. Pairing
 * follows CommonMark's delimiter rules, its rule of three included, so markers
 * written by the editor read back as they were set. */
export function parseMarkedText(source: string): MarkedToken[] {
  const tokens = parseMathText(source);
  if (!MARKER_CHARS.test(source)) return tokens;
  const atoms: Atom[] = [];
  for (const token of tokens) {
    if (token.type !== 'text') {
      atoms.push({ token });
      continue;
    }
    pushChars(token.value, atoms);
  }
  // Marker runs: a longer run of one character stays text.
  const runs: Run[] = [];
  for (let i = 0; i < atoms.length; ) {
    const ch = markerOf(atoms[i]);
    if (!ch) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < atoms.length && markerOf(atoms[end]) === ch) end++;
    const length = end - i;
    if (ch === '*' ? length <= 3 : length === 2)
      runs.push({
        at: i,
        canClose: !isSpace(atoms[i - 1]),
        canOpen: !isSpace(atoms[end]),
        ch,
        closes: [],
        left: length,
        length,
        opens: [],
      });
    i = end;
  }
  const openers: Run[] = [];
  for (const run of runs) {
    while (run.canClose && run.left > 0) {
      let j = openers.length - 1;
      for (; j >= 0; j--) {
        const opener = openers[j];
        if (opener.ch !== run.ch) continue;
        const sum = opener.length + run.length;
        const both =
          (opener.canOpen && opener.canClose) || (run.canOpen && run.canClose);
        if (
          !both ||
          sum % 3 !== 0 ||
          (opener.length % 3 === 0 && run.length % 3 === 0)
        )
          break;
      }
      if (j < 0) break;
      const opener = openers[j];
      const n = run.ch === '_' || (opener.left >= 2 && run.left >= 2) ? 2 : 1;
      const mark = n === 1 ? ITALIC : run.ch === '_' ? UNDERLINE : BOLD;
      opener.opens.push(mark);
      run.closes.push(mark);
      opener.left -= n;
      run.left -= n;
      // Openers between the pair stay text.
      openers.length = opener.left > 0 ? j + 1 : j;
    }
    if (run.canOpen && run.left > 0) openers.push(run);
  }
  const out: MarkedToken[] = [];
  // How many pairs of each mark (indexed by its bit) are open.
  const depth = [0, 0, 0, 0, 0];
  const bits = () =>
    (depth[BOLD] ? BOLD : 0) |
    (depth[ITALIC] ? ITALIC : 0) |
    (depth[UNDERLINE] ? UNDERLINE : 0);
  let lastBits = -1;
  const pushText = (text: string) => {
    const now = bits();
    const last = out.at(-1);
    if (last?.type === 'text' && lastBits === now) last.value += text;
    else out.push({ type: 'text', value: text, ...marksOf(now) });
    lastBits = now;
  };
  let r = 0;
  for (let i = 0; i < atoms.length; ) {
    const run = runs[r];
    if (run?.at === i) {
      for (const mark of run.closes) depth[mark]--;
      if (run.left) pushText(run.ch.repeat(run.left));
      for (const mark of run.opens) depth[mark]++;
      i += run.length;
      r++;
      continue;
    }
    const atom = atoms[i++];
    if ('ch' in atom) pushText(atom.ch);
    else {
      out.push({ ...atom.token, ...marksOf(bits()) });
      lastBits = -1;
    }
  }
  return out;
}

/** The text without its markers, formulas as written: for plain-text lists
 * and summaries. */
export const stripMarks = (source: string) =>
  MARKER_CHARS.test(source)
    ? parseMarkedText(source)
        .map(({ type, value }) =>
          type === 'text'
            ? value
            : type === 'inline'
              ? `$${value}$`
              : `$$${value}$$`
        )
        .join('')
    : source;
