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

/**
 * Credit for a material the chat agent wrote from the shared knowledge
 * library: one line per source book, plus the material's own licence when a
 * source is ShareAlike.
 *
 * It renders outside the editable document and is not part of the Yjs state,
 * so the attribution survives every edit of the material itself.
 */
export function MaterialAttributionFooter({
  provenance,
}: {
  provenance: Provenance | undefined;
}) {
  if (!provenance?.books.length) return null;
  return (
    <footer className="border-divider border-t px-5 py-3 text-fg-muted text-xs">
      <p className="font-medium">{m.material_attribution_title()}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {provenance.books.map((book) => {
          const licenseUrl = webUrl(book.licenseUrl);
          const sourceUrl = webUrl(book.sourceUrl);
          return (
            <li key={book.id}>
              {m.material_attribution_book({
                authors: book.authors.join(', ') || book.title,
                title: `${book.title} (${[
                  book.edition,
                  m.material_attribution_version({ version: book.version }),
                ]
                  .filter(Boolean)
                  .join(', ')})`,
              })}
              {book.license && (
                <>
                  {' · '}
                  {licenseUrl ? (
                    <a
                      className="underline"
                      href={licenseUrl}
                      rel="noreferrer license"
                      target="_blank"
                    >
                      {book.license}
                    </a>
                  ) : (
                    book.license
                  )}
                </>
              )}
              {sourceUrl && (
                <>
                  {' · '}
                  <a
                    className="underline"
                    href={sourceUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {m.material_attribution_source()}
                  </a>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {provenance.license && (
        <p className="mt-1">
          {m.material_attribution_license({ license: provenance.license })}
        </p>
      )}
    </footer>
  );
}
