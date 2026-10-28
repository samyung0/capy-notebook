import { createContext, Fragment, useContext } from 'react';
import { m } from '@/i18n';

/**
 * Passage numbers in an answer are the model's own ([n] as shown in the tool
 * results). The answer's citation list carries each entry's `n`; its position
 * in that list is the number the reader sees, so the same program renders
 * the same way live and from history.
 */
export interface CitationLookup {
  /** 1-based display number for a passage, or undefined when it was dropped. */
  numberOf: (n: number) => number | undefined;
  open?: (n: number) => void;
}

export const CitationContext = createContext<CitationLookup>({
  numberOf: () => undefined,
});

/** Element nodes as the OpenUI parser hands them to a container. */
export interface ElementNode<P = Record<string, unknown>> {
  partial: boolean;
  props: P;
  type: 'element';
  typeName: string;
}

export function elements<P>(value: unknown): ElementNode<P>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (node): node is ElementNode<P> =>
      !!node &&
      typeof node === 'object' &&
      (node as ElementNode).type === 'element'
  );
}

/** Raised source numbers (¹,²) at the end of the text they back. */
export function Cites({ passages }: { passages?: number[] }) {
  const { numberOf, open } = useContext(CitationContext);
  const marks = [...new Set(passages ?? [])]
    .map((n) => ({ k: numberOf(n), n }))
    .filter((mark): mark is { k: number; n: number } => mark.k !== undefined);
  if (!marks.length) return null;
  return (
    <sup
      className="ml-px whitespace-nowrap text-[10px] text-fg-muted leading-none"
      data-copy-skip
    >
      {marks.map(({ k, n }, index) => (
        <Fragment key={n}>
          {index ? ',' : null}
          <button
            className="hover:text-fg hover:underline"
            onClick={() => open?.(n)}
            title={m.chat_source_number({ n: k })}
            type="button"
          >
            {k}
          </button>
        </Fragment>
      ))}
    </sup>
  );
}

/** Sources under a table, chart or embed. */
export function CiteFooter({
  passages,
  note,
}: {
  passages?: number[];
  note?: string;
}) {
  if (!(passages?.length || note)) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted text-xs"
      data-copy-skip
    >
      {note ? <span>{note}</span> : null}
      {passages?.length ? (
        <span>
          {m.chat_sources()}
          <Cites passages={passages} />
        </span>
      ) : null}
    </div>
  );
}
