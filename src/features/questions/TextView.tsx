import type { ReactNode } from 'react';
import { MathPreview } from '@/features/materials/MathPreview';
import { cn } from '@/lib/cn';
import {
  type MarkedToken,
  type Marks,
  parseMarkedText,
} from './parseMarkedText';
import { parseMathText } from './parseMathText';

export { parseMathText } from './parseMathText';

// Punctuation that must not start a line after an inline formula.
const TRAILING_PUNCTUATION = /^[.,;:!?)\]’”。，、；：！？）]+/;

const LEADING_BREAKS = /^\n+/;
const TRAILING_BREAKS = /\n+$/;

const marked = (marks: Marks | undefined, node: ReactNode) => {
  let out = node;
  if (marks?.bold) out = <strong>{out}</strong>;
  if (marks?.italic) out = <em>{out}</em>;
  if (marks?.underline) out = <u>{out}</u>;
  return out;
};

/** Question text with its formulas; `marks` also reads bold, italic and
 * underline markers, which only text blocks and table cells hold. */
export function TextView({
  text,
  className,
  marks = false,
}: {
  text: string;
  className?: string;
  marks?: boolean;
}) {
  const tokens: MarkedToken[] = (
    marks ? parseMarkedText(text) : parseMathText(text)
  ).map((token, index, all) => {
    // A display formula is its own block, as in the editor: the paragraph
    // breaks around it add no empty line.
    if (token.type !== 'text') return token;
    let value = token.value;
    if (all[index - 1]?.type === 'display')
      value = value.replace(LEADING_BREAKS, '');
    if (all[index + 1]?.type === 'display')
      value = value.replace(TRAILING_BREAKS, '');
    return { ...token, value };
  });
  // An inline formula takes the punctuation right after it into its own
  // no-wrap span, so the two always break as one unit.
  const trailing = tokens.map((token, index) => {
    const next = tokens[index + 1];
    return token.type === 'inline' && next?.type === 'text'
      ? (next.value.match(TRAILING_PUNCTUATION)?.[0] ?? '')
      : '';
  });
  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {tokens.map((token, index) =>
        token.type === 'text' ? (
          <span key={index}>
            {marked(token, token.value.slice(trailing[index - 1]?.length ?? 0))}
          </span>
        ) : (
          <span
            className={cn(
              trailing[index] && 'whitespace-nowrap',
              // The editor's formula box: 16px above and below.
              token.type === 'display' && 'block py-4 text-center'
            )}
            key={index}
          >
            {marked(
              token,
              <MathPreview
                displayMode={token.type === 'display'}
                tex={token.value}
              />
            )}
            {trailing[index] && marked(tokens[index + 1], trailing[index])}
          </span>
        )
      )}
    </span>
  );
}
