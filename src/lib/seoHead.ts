import { escapeHTML, jsonForHTML } from '@/lib/html';

/* The head every public page carries (workspace summaries and /share/*):
   title, description, canonical, robots, Open Graph, a Twitter card and
   schema.org JSON-LD. No og:image yet: file thumbnails come later. */

/** Text cut at a word boundary to fit a search snippet. */
export function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

export function seoHead({
  author,
  canonical,
  description,
  indexable,
  jsonLd,
  modified,
  name,
}: {
  author?: string;
  canonical: string;
  description: string;
  /** Public items are indexed; link-shared ones are not. */
  indexable: boolean;
  /** The item's own schema.org fields; the shared ones are added here. */
  jsonLd: Record<string, unknown>;
  /** ISO time of the last change, when the item has one. */
  modified?: string;
  name: string;
}): string {
  const meta = (key: 'name' | 'property', id: string, content: string) =>
    `<meta ${key}="${id}" content="${escapeHTML(content)}">`;
  return [
    `<title>${escapeHTML(name)} | Capy Notebook</title>`,
    meta('name', 'description', description),
    `<link rel="canonical" href="${escapeHTML(canonical)}">`,
    meta('name', 'robots', indexable ? 'index, follow' : 'noindex, nofollow'),
    meta('property', 'og:type', modified ? 'article' : 'website'),
    meta('property', 'og:title', name),
    meta('property', 'og:description', description),
    meta('property', 'og:url', canonical),
    meta('property', 'og:site_name', 'Capy Notebook'),
    // Public pages are English only.
    meta('property', 'og:locale', 'en_US'),
    modified ? meta('property', 'article:modified_time', modified) : '',
    meta('name', 'twitter:card', 'summary'),
    meta('name', 'twitter:title', name),
    meta('name', 'twitter:description', description),
    `<script type="application/ld+json">${jsonForHTML({
      '@context': 'https://schema.org',
      ...jsonLd,
      description,
      name,
      url: canonical,
      ...(author ? { author: { '@type': 'Person', name: author } } : {}),
      ...(modified ? { dateModified: modified } : {}),
      isAccessibleForFree: true,
    })}</script>`,
  ].join('');
}
