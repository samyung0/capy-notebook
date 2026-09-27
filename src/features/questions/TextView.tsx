import { MathPreview } from '@/features/materials/MathPreview';
import { cn } from '@/lib/cn';
import { parseMathText } from './parseMathText';

export { parseMathText } from './parseMathText';

export function TextView({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {parseMathText(text).map((token, index) =>
        token.type === 'text' ? (
          <span key={index}>{token.value}</span>
        ) : (
          <span
            className={cn(
              token.type === 'display' &&
                'my-3 block overflow-x-auto text-center'
            )}
            key={index}
          >
            <MathPreview
              displayMode={token.type === 'display'}
              tex={token.value}
            />
          </span>
        )
      )}
    </span>
  );
}
