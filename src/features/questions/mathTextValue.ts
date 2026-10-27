import type { TElement, Value } from 'platejs';
import { parseMathText } from './parseMathText';
import { GAP_MARKER, gapText } from './types';

/** A gaps part's blank in the editor: numbered by its place, so it holds
 * only an id that keeps its accepted answers with it as blanks come and go. */
export const GAP_TYPE = 'gap';

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
  const pushText = (value: string) => {
    if (!gaps) {
      children.push({ text: value });
      return;
    }
    let at = 0;
    for (const match of value.matchAll(GAP_MARKER)) {
      children.push(
        { text: value.slice(at, match.index) },
        { children: [{ text: '' }], id: `g${blanks++}`, type: GAP_TYPE },
        { text: '' }
      );
      at = match.index + match[0].length;
    }
    children.push({ text: value.slice(at) });
  };
  for (const token of parseMathText(text)) {
    if (token.type === 'display') {
      if (hasContent()) flush();
      nodes.push({
        children: [{ text: '' }],
        texExpression: token.value,
        type: 'equation',
      });
    } else if (token.type === 'inline') {
      children.push(
        {
          children: [{ text: '' }],
          texExpression: token.value,
          type: 'inline_equation',
        },
        { text: '' }
      );
    } else {
      const paragraphs = token.value.split('\n\n');
      paragraphs.forEach((part, i) => {
        if (i) flush();
        pushText(part);
      });
    }
  }
  if (hasContent()) flush();
  if (!nodes.length) nodes.push({ children: [{ text: '' }], type: 'p' });
  return nodes;
}

/** The text a value holds; its blanks numbered from `gapStart` in order. */
export function valueToMathText(value: Value, gapStart = 1): string {
  let number = gapStart;
  const read = (node: Value[number]['children'][number]): string => {
    if ('text' in node && typeof node.text === 'string')
      return node.text.replace(/\$/g, '\\$');
    if (node.type === 'inline_equation')
      return `$${String(node.texExpression ?? '')}$`;
    if (node.type === 'equation')
      return `$$${String(node.texExpression ?? '')}$$`;
    if (node.type === GAP_TYPE) return gapText(number++);
    return (node as TElement).children.map(read).join('');
  };
  return value.map(read).join('\n\n');
}

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
