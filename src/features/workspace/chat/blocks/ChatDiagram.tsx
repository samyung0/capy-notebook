import { useIsStreaming } from '@openuidev/react-lang';
import { Mermaid } from '@/features/materials/Mermaid';
import { m } from '@/i18n';
import { useDebounced } from '@/lib/useDebounced';
import type { DiagramProps } from '../schema';
import { CiteFooter } from './Cite';

/** While the answer streams, the code is drawn once it stops growing, so a
 * half-written diagram neither re-renders on every chunk nor flashes errors. */
const SETTLE_MS = 400;

const ignore = () => undefined;

export function Diagram({ props }: { props: DiagramProps }) {
  const streaming = useIsStreaming();
  const code = typeof props.code === 'string' ? props.code.trim() : '';
  const settled = useDebounced(code, SETTLE_MS);
  const drawn = streaming ? settled : code;
  return (
    <figure className="my-3 rounded-card border border-line px-3 py-2.5">
      <figcaption className="mb-1.5 font-semibold text-xs">
        {props.title}
      </figcaption>
      {drawn ? (
        <Mermaid code={drawn} onError={streaming ? ignore : undefined} />
      ) : (
        <div className="grid h-40 place-items-center text-fg-muted">
          <span className="text-xs">{m.mermaid_rendering()}</span>
        </div>
      )}
      <CiteFooter passages={props.passages} />
    </figure>
  );
}
