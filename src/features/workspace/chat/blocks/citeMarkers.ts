/**
 * `[#2]` / `[#2,5]` citation markers in chat Markdown (the Markdown answer
 * format, pipeline/pipeline/prompts/answer_markdown.txt) become
 * `<span data-cite="2,5">`, which Prose draws as raised source numbers. A
 * rehype plugin placed after Streamdown's own, so its sanitizer keeps the
 * attribute; code keeps its text.
 */

const MARKER = /\[#(\d+(?:\s*,\s*\d+)*)\]/g;
const LITERAL = new Set(['code', 'pre']);
/** Fenced and inline code, which keep their text, or a marker. */
const CODE_OR_MARKER =
  /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|[ \t]*\[#\d+(?:\s*,\s*\d+)*\]/g;

interface HastNode {
  children?: HastNode[];
  properties?: Record<string, string>;
  tagName?: string;
  type: string;
  value?: string;
}

function split(node: HastNode): HastNode[] {
  const text = node.value ?? '';
  const parts: HastNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    // The number stays on the last word's line, not after a breakable space.
    const before = text.slice(last, match.index).trimEnd();
    if (before) parts.push({ type: 'text', value: before });
    parts.push({
      children: [],
      properties: { dataCite: match[1].replace(/\s+/g, '') },
      tagName: 'span',
      type: 'element',
    });
    last = match.index + match[0].length;
  }
  if (!parts.length) return [node];
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

function visit(node: HastNode) {
  if (!node.children || LITERAL.has(node.tagName ?? '')) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return split(child);
    visit(child);
    return [child];
  });
}

export function citeMarkers() {
  return (tree: HastNode) => visit(tree);
}

/** The passages a `data-cite` attribute or a fence's `passages` names. */
export function citedPassages(value: string): number[] {
  return value.split(',').filter(Boolean).map(Number).filter(Number.isInteger);
}

/** Markdown source without its citation markers, for a copy. */
export function withoutMarkers(text: string) {
  return text.replace(CODE_OR_MARKER, (_, code?: string) => code ?? '');
}
