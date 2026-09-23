import { createContext, useContext } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

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

/** Inline [k] markers after a block of prose. */
export function Cites({
  passages,
  className,
}: {
  passages?: number[];
  className?: string;
}) {
  const { numberOf, open } = useContext(CitationContext);
  const marks = [...new Set(passages ?? [])]
    .map((n) => ({ k: numberOf(n), n }))
    .filter((mark): mark is { k: number; n: number } => mark.k !== undefined);
  if (!marks.length) return null;
  return (
    <span className={cn('ml-1 inline-flex gap-0.5 align-[2px]', className)}>
      {marks.map(({ k, n }) => (
        <button
          className="rounded bg-tint-info px-1 font-semibold text-[10px] text-tint-info-fg leading-4 hover:brightness-97"
          key={n}
          onClick={() => open?.(n)}
          title={m.chat_source_number({ n: k })}
          type="button"
        >
          {k}
        </button>
      ))}
    </span>
  );
}

/** Sources under a table or chart, with per-row attribution when rows cite
 * their own passages. */
export function CiteFooter({
  passages,
  rows,
  note,
}: {
  passages?: number[];
  rows?: { index: number; passages?: number[] }[];
  note?: string;
}) {
  const cited = rows?.filter((row) => row.passages?.length) ?? [];
  if (!(passages?.length || cited.length || note)) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
      {note ? <span>{note}</span> : null}
      {passages?.length ? (
        <span>
          {m.chat_sources()}
          <Cites passages={passages} />
        </span>
      ) : null}
      {cited.map((row) => (
        <span key={row.index}>
          {m.chat_table_row({ n: row.index + 1 })}
          <Cites passages={row.passages} />
        </span>
      ))}
    </div>
  );
}
