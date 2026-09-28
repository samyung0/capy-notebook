import { MathPreview } from '@/features/materials/MathPreview';
import { cn } from '@/lib/cn';
import { parseMathText } from './parseMathText';

export { parseMathText } from './parseMathText';

// Punctuation that must not start a line after an inline formula.
const TRAILING_PUNCTUATION = /^[.,;:!?)\]’”。，、；：！？）]+/;

export function TextView({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const tokens = parseMathText(text);
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
            {token.value.slice(trailing[index - 1]?.length ?? 0)}
          </span>
        ) : (
          <span
            className={cn(
              trailing[index] && 'whitespace-nowrap',
              token.type === 'display' &&
                'my-3 block overflow-x-auto text-center'
            )}
            key={index}
          >
            <MathPreview
              displayMode={token.type === 'display'}
              tex={token.value}
            />
            {trailing[index]}
          </span>
        )
      )}
    </span>
  );
}
