/**
 * `$…$` and `$$…$$` in chat prose, rendered with KaTeX (the export's renderer
 * and stylesheet). remark-math parses the math; `rehypeChatMath` turns each
 * formula into a `span[data-math]` that `MathSpan` draws, loading KaTeX on
 * the first formula. A formula KaTeX cannot read (half-streamed, or invalid)
 * shows its source.
 */

import { type ComponentProps, useEffect, useMemo, useState } from 'react';
import remarkMath from 'remark-math';
import type { MathPlugin } from 'streamdown';

type Katex = typeof import('katex').default;

let katex: Katex | undefined;
let loading: Promise<Katex> | undefined;
export function loadKatex() {
  loading ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([module]) => {
    katex = module.default;
    return katex;
  });
  return loading;
}

const ONE_LINE_DISPLAY = /^\$\$([^\n]+?)\$\$$/;
/** Fenced code, inline code and `$$` math, split out of the prose. */
const UNTOUCHED = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?(?:\$\$|$))/;
const LINE_START = /(?:^|\n)[ \t]*$/;
const LINE_END = /^[ \t]*(?:\n|$)/;
const NON_SPACE = /\S/;
const DIGIT = /\d/;
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * Single-dollar math follows Pandoc's rule, so prices stay text: an opening
 * `$` has a non-space right after it, its closing `$` a non-space right before
 * it and no digit right after it, both in one paragraph. Every other single
 * `$` is escaped. Code is left alone, and a `$$…$$` alone on its line becomes
 * the fenced form remark-math displays (on one line it would be inline).
 */
export function prepareMath(text: string): string {
  if (!text.includes('$')) return text;
  const parts = text.split(UNTOUCHED);
  return parts
    .map((part, index) => {
      if (!(index % 2)) return escapeSingles(part);
      const display = part.match(ONE_LINE_DISPLAY);
      const alone =
        LINE_START.test(parts[index - 1]) && LINE_END.test(parts[index + 1]);
      return display && alone ? `$$\n${display[1].trim()}\n$$` : part;
    })
    .join('');
}

function escapeSingles(part: string): string {
  const stray: number[] = [];
  let open = -1;
  for (let i = 0; i < part.length; i++) {
    if (part[i] === '\\') {
      i++;
      continue;
    }
    if (part[i] !== '$') continue;
    const before = part[i - 1] ?? '';
    const after = part[i + 1] ?? '';
    if (
      open >= 0 &&
      NON_SPACE.test(before) &&
      !DIGIT.test(after) &&
      !BLANK_LINE.test(part.slice(open, i))
    ) {
      open = -1;
      continue;
    }
    if (open >= 0) stray.push(open);
    open = NON_SPACE.test(after) ? i : -1;
    if (open < 0) stray.push(i);
  }
  if (open >= 0) stray.push(open);
  let out = part;
  for (const index of stray.sort((a, b) => b - a))
    out = `${out.slice(0, index)}\\${out.slice(index)}`;
  return out;
}

interface HastNode {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
}

const isMathCode = (node: HastNode) =>
  node.type === 'element' &&
  node.tagName === 'code' &&
  Array.isArray(node.properties?.className) &&
  node.properties.className.includes('language-math');

const textOf = (node: HastNode): string =>
  node.type === 'text'
    ? (node.value ?? '')
    : (node.children ?? []).map(textOf).join('');

/** remark-math leaves `code.language-math` (inline) and `pre > code` (display). */
function rehypeChatMath() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      node.children?.forEach((child, index, siblings) => {
        const code =
          child.tagName === 'pre'
            ? child.children?.find(isMathCode)
            : isMathCode(child)
              ? child
              : undefined;
        if (!code) {
          visit(child);
          return;
        }
        siblings[index] = {
          children: [{ type: 'text', value: textOf(code) }],
          properties: { dataMath: code === child ? 'inline' : 'display' },
          tagName: 'span',
          type: 'element',
        } as HastNode;
      });
    };
    visit(tree);
  };
}

export const chatMath: MathPlugin = {
  name: 'katex',
  rehypePlugin: rehypeChatMath,
  remarkPlugin: remarkMath,
  type: 'math',
};

function Formula({ display, tex }: { display: boolean; tex: string }) {
  const [ready, setReady] = useState(!!katex);
  useEffect(() => {
    if (!ready) loadKatex().then(() => setReady(true));
  }, [ready]);
  const html = useMemo(() => {
    if (!(ready && katex)) return null;
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        strict: 'ignore',
        throwOnError: true,
      });
    } catch {
      return null;
    }
  }, [display, ready, tex]);
  if (html === null)
    return (
      <code className="text-fg-muted">
        {display ? `$$${tex}$$` : `$${tex}$`}
      </code>
    );
  return display ? (
    <span
      className="scroll-fade-x relative block overflow-x-auto overflow-y-hidden"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <span dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** Streamdown's `span`: a formula from `rehypeChatMath`, else a plain span. */
export function MathSpan({
  node: _node,
  ...props
}: ComponentProps<'span'> & { node?: unknown; 'data-math'?: string }) {
  const mode = props['data-math'];
  if (mode !== 'inline' && mode !== 'display') return <span {...props} />;
  return (
    <Formula display={mode === 'display'} tex={String(props.children ?? '')} />
  );
}
