import { useIsStreaming } from '@openuidev/react-lang';
import { Mermaid } from '@/features/materials/Mermaid';
import { m } from '@/i18n';
import { useDebounced } from '@/lib/useDebounced';
import type { MermaidProps } from '../schema';
import { CiteFooter } from './Cite';

/** While the answer streams, the code is drawn once it stops growing, so a
 * half-written diagram neither re-renders on every chunk nor flashes errors. */
const SETTLE_MS = 400;

const ignore = () => undefined;

export function ChatMermaid({ props }: { props: MermaidProps }) {
  const streaming = useIsStreaming();
  const code = typeof props.code === 'string' ? props.code.trim() : '';
  const settled = useDebounced(code, SETTLE_MS);
  const drawn = streaming ? settled : code;
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="font-semibold text-[13.5px]">
        {props.title}
      </figcaption>
      {drawn ? (
        <Mermaid
          className="[&>svg]:max-h-[min(60vh,32rem)]"
          code={drawn}
          onError={streaming ? ignore : undefined}
        />
      ) : (
        <div className="grid h-40 place-items-center text-fg-muted">
          <span className="text-xs">{m.mermaid_rendering()}</span>
        </div>
      )}
      <CiteFooter passages={props.passages} />
    </figure>
  );
}
