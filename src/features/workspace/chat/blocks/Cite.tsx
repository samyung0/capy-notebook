import { createContext, Fragment, useContext, useMemo } from 'react';
import type { Citation } from '@/api/types';
import { m } from '@/i18n';

/**
 * Passage numbers in an answer are the model's own ([n] as shown in the tool
 * results). The answer's citation list carries each entry's `n`; its position
 * in that list is the number the reader sees, so the same answer renders
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

/** The lookup for an answer's citation list, for CitationContext. */
export function useCitationLookup(
  citations: Citation[] | undefined,
  onOpenCitation: ((citation: Citation) => void) | undefined
): CitationLookup {
  return useMemo(() => {
    const byPassage = new Map<number, number>();
    citations?.forEach((citation, index) => {
      if (citation.n !== undefined && !byPassage.has(citation.n)) {
        byPassage.set(citation.n, index);
      }
    });
    return {
      numberOf: (n) => {
        const index = byPassage.get(n);
        return index === undefined ? undefined : index + 1;
      },
      open: (n) => {
        const index = byPassage.get(n);
        const citation = index === undefined ? undefined : citations?.[index];
        if (citation) onOpenCitation?.(citation);
      },
    };
  }, [citations, onOpenCitation]);
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
