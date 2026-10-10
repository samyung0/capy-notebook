import type { Provenance, ProvenanceBook } from '@/api/types';

/* A note footer's credits as the app computes them (Epo 2026-10-11): the
   note's own sources, then those of each embed its document references, with
   the licence line over all of them. It mirrors Go's WithEmbedSources and
   FooterLicence (server/internal/store/provenance.go); both read the parity
   table server/internal/store/testdata/footer_union_parity.json. */

type ProvenanceWeb = NonNullable<Provenance['web']>[number];

const VERSION = /[0-9]+(\.[0-9]+)?/;
const SEPARATORS = /[ \t\-_]+/;

/** Upper case, every run of space, tab, `-` and `_` one space, none at the
 * ends: `CC-BY-SA-4.0` and `CC BY-SA 4.0 ` are the same licence. */
function normalizeLicense(license: string) {
  return license.toUpperCase().split(SEPARATORS).filter(Boolean).join(' ');
}

/** The copyleft family of a normalized licence, or '' when it is not copyleft;
 * NonCommercial ShareAlike first, a family of its own. */
function licenseFamily(normalized: string) {
  if (
    normalized.includes('BY NC SA') ||
    normalized.includes('NONCOMMERCIAL SHAREALIKE')
  )
    return 'CC BY-NC-SA';
  if (normalized.includes('BY SA') || normalized.includes('SHAREALIKE'))
    return 'CC BY-SA';
  if (
    normalized.includes('GFDL') ||
    normalized.includes('GNU FREE DOCUMENTATION LICENSE')
  )
    return 'GFDL';
  if (
    normalized.includes('ODBL') ||
    normalized.includes('OPEN DATABASE LICENSE')
  )
    return 'ODbL';
  return '';
}

function licenseVersion(normalized: string) {
  const match = VERSION.exec(normalized);
  return match ? Number.parseFloat(match[0]) : 0;
}

/** The licence a work from these sources carries: '' unless one is copyleft,
 * then the newest version of that family as its source wrote it (a tie keeps
 * the first wording); null when two families meet, which has no single
 * licence. */
export function familyLicence(licenses: string[]): string | null {
  let family = '';
  let chosen = '';
  let newest = 0;
  for (const license of licenses) {
    const normalized = normalizeLicense(license);
    const current = licenseFamily(normalized);
    if (!current) continue;
    if (!family) {
      family = current;
      chosen = license;
      newest = licenseVersion(normalized);
    } else if (current !== family) return null;
    else if (licenseVersion(normalized) > newest) {
      chosen = license;
      newest = licenseVersion(normalized);
    }
  }
  return chosen;
}

/** A note footer's credits: its own record plus every source of its embeds
 * (their copied bank questions' too, by question id), each book by id and page
 * by URL once, the note's own first; the licence line over all of them, or
 * none when two copyleft families meet. With no embeds it is the note's own
 * record as stored. */
export function noteFooterProvenance(
  own: Provenance | undefined,
  embeds: Provenance[]
): Provenance | undefined {
  if (embeds.length === 0) return own;
  const books: ProvenanceBook[] = [];
  const web: ProvenanceWeb[] = [];
  const add = (b: ProvenanceBook[], w: Provenance['web']) => {
    for (const book of b)
      if (!books.some((x) => x.id === book.id)) books.push(book);
    for (const page of w ?? [])
      if (!web.some((x) => x.url === page.url)) web.push(page);
  };
  for (const record of own ? [own, ...embeds] : embeds) {
    add(record.books, record.web);
    for (const id of Object.keys(record.questions ?? {}).sort()) {
      const credit = record.questions?.[id];
      if (credit) add(credit.books, credit.web);
    }
  }
  if (!own && books.length === 0 && web.length === 0) return;
  const license = familyLicence([
    ...books.map((book) => book.license ?? ''),
    ...web.map((page) => page.license),
  ]);
  return {
    books,
    ...(web.length > 0 ? { web } : {}),
    ...(license ? { license } : {}),
    ...(own?.questions ? { questions: own.questions } : {}),
  };
}
