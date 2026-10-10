import { memo, useId, useState } from 'react';
import type { Provenance, QuestionCredit } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** A licence or source reference is only a link when it is a web address; a
 * plain name such as "CC BY-SA 4.0" renders as text. */
function webUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** One credit line: who wrote it, then its licence and source as links when they are web addresses. */
function Credit({
  label,
  license,
  licenseUrl,
  sourceUrl,
}: {
  label: string;
  license?: string;
  licenseUrl?: string;
  sourceUrl?: string;
}) {
  const licenseLink = webUrl(licenseUrl);
  const sourceLink = webUrl(sourceUrl);
  return (
    <li>
      {label}
      {license && (
        <>
          {' · '}
          {licenseLink ? (
            <a
              className="underline"
              href={licenseLink}
              rel="noreferrer license"
              target="_blank"
            >
              {license}
            </a>
          ) : (
            license
          )}
        </>
      )}
      {sourceLink && (
        <>
          {' · '}
          <a
            className="underline"
            href={sourceLink}
            rel="noreferrer"
            target="_blank"
          >
            {m.material_attribution_source()}
          </a>
        </>
      )}
    </li>
  );
}

/** One line per book or web page a material or a question came from. */
function Credits({ books, web }: Pick<QuestionCredit, 'books' | 'web'>) {
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {books.map((book) => (
        <Credit
          key={book.id}
          label={m.material_attribution_book({
            authors: book.authors.join(', ') || book.title,
            title: `${book.title} (${[
              book.edition,
              m.material_attribution_version({ version: book.version }),
            ]
              .filter(Boolean)
              .join(', ')})`,
          })}
          license={book.license}
          licenseUrl={book.licenseUrl}
          sourceUrl={book.sourceUrl}
        />
      ))}
      {web?.map((page) => (
        <Credit
          key={page.url}
          label={m.material_attribution_book({
            authors: page.authors.join(', ') || page.publisher || page.title,
            title: `${page.title} (${[
              page.publisher,
              m.material_attribution_retrieved({ date: page.retrievedAt }),
            ]
              .filter(Boolean)
              .join(', ')})`,
          })}
          license={page.license}
          licenseUrl={page.licenseUrl}
          sourceUrl={page.url}
        />
      ))}
    </ul>
  );
}

/**
 * Credit for a material written from the shared knowledge library, or for a
 * bank question adapted from an openly licensed web page: one line per source,
 * plus the work's own licence when a source is ShareAlike.
 *
 * It renders outside the editable document and is not part of the Yjs state,
 * so the attribution survives every edit of the material itself.
 *
 * `inline` ends a document's own content (a note, a diagram), set apart by
 * space alone; `className` puts it in the document's reading column.
 * Otherwise it is a bordered strip closing a block (a bank question). Quizzes
 * and flashcard sets show `SourcesLine` instead.
 */
export function MaterialAttributionFooter({
  provenance,
  inline = false,
  className,
}: {
  provenance: Provenance | undefined;
  inline?: boolean;
  className?: string;
}) {
  if (!(provenance?.books.length || provenance?.web?.length)) return null;
  return (
    <footer
      className={cn(
        'text-fg-muted text-xs',
        inline ? 'mt-16 pb-4' : 'border-divider border-t px-5 py-3',
        className
      )}
    >
      <p className="font-medium">{m.material_attribution_title()}</p>
      <Credits books={provenance.books} web={provenance.web} />
      {provenance.license && (
        <p className="mt-1">
          {m.material_attribution_license({ license: provenance.license })}
        </p>
      )}
    </footer>
  );
}

/**
 * A quiz's or flashcard set's credits as one collapsed "Sources (n)" line that
 * expands: under the item where a note embeds it, and at the end of its own
 * pages (Epo 2026-10-11). A note's footer lists them too. Memoized on the
 * provenance record, which a re-read only replaces when it changed.
 */
export const SourcesLine = memo(function SourcesLine({
  provenance,
  className,
}: {
  provenance: Provenance | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const count =
    (provenance?.books.length ?? 0) + (provenance?.web?.length ?? 0);
  if (!(provenance && count)) return null;
  return (
    <div className={cn('text-fg-muted text-xs', className)}>
      <button
        aria-controls={id}
        aria-expanded={open}
        className="-ml-0.5 inline-flex cursor-pointer items-center gap-1 rounded-sm px-0.5 outline-none hover:text-fg-secondary focus-visible:ring-2 focus-visible:ring-focus"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
          name="chevronRight"
        />
        {m.material_attribution_sources({ count })}
      </button>
      <div className="mt-1 pl-4.5" hidden={!open} id={id}>
        <p className="font-medium">{m.material_attribution_title()}</p>
        <Credits books={provenance.books} web={provenance.web} />
        {provenance.license && (
          <p className="mt-1">
            {m.material_attribution_license({ license: provenance.license })}
          </p>
        )}
      </div>
    </div>
  );
});

/**
 * Credit for one question copied from the question bank, shown under it: its
 * passage and figures came from these sources. Kept in the quiz's provenance,
 * outside the editable document, so editing the quiz cannot remove it.
 */
export function QuestionCreditNote({
  credit,
}: {
  credit: QuestionCredit | undefined;
}) {
  if (!(credit?.books.length || credit?.web?.length)) return null;
  return (
    <div className="text-fg-muted text-xs">
      <p className="font-medium">{m.material_attribution_title()}</p>
      <Credits books={credit.books} web={credit.web} />
      {credit.license && (
        <p className="mt-1">
          {m.question_attribution_license({ license: credit.license })}
        </p>
      )}
    </div>
  );
}
