import type { TElement, Value } from 'platejs';
import { parseMathText } from './parseMathText';

export function mathTextToValue(text: string): Value {
  const nodes: TElement[] = [];
  let children: TElement['children'] = [{ text: '' }];
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
        children.push({ text: part });
      });
    }
  }
  if (hasContent()) flush();
  if (!nodes.length) nodes.push({ children: [{ text: '' }], type: 'p' });
  return nodes;
}

export function valueToMathText(value: Value): string {
  const read = (node: Value[number]['children'][number]): string => {
    if ('text' in node && typeof node.text === 'string')
      return node.text.replace(/\$/g, '\\$');
    if (node.type === 'inline_equation')
      return `$${String(node.texExpression ?? '')}$`;
    if (node.type === 'equation')
      return `$$${String(node.texExpression ?? '')}$$`;
    return (node as TElement).children.map(read).join('');
  };
  return value.map(read).join('\n\n');
}
