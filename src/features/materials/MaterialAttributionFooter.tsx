import type { Provenance } from '@/api/types';
import { m } from '@/i18n';

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

/**
 * Credit for a material written from the shared knowledge library, or for a
 * bank question adapted from an openly licensed web page: one line per source,
 * plus the work's own licence when a source is ShareAlike.
 *
 * It renders outside the editable document and is not part of the Yjs state,
 * so the attribution survives every edit of the material itself.
 */
export function MaterialAttributionFooter({
  provenance,
}: {
  provenance: Provenance | undefined;
}) {
  if (!(provenance?.books.length || provenance?.web?.length)) return null;
  return (
    <footer className="border-divider border-t px-5 py-3 text-fg-muted text-xs">
      <p className="font-medium">{m.material_attribution_title()}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {provenance.books.map((book) => (
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
        {provenance.web?.map((page) => (
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
      {provenance.license && (
        <p className="mt-1">
          {m.material_attribution_license({ license: provenance.license })}
        </p>
      )}
    </footer>
  );
}
