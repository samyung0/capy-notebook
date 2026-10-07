import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { z } from 'zod';
import type { WorkspaceSummary } from '../../src/api/types';
import { PublicNav } from '../../src/components/app/PublicHeader';
import { Button } from '../../src/components/ui/Button';
import { IconButton } from '../../src/components/ui/IconButton';
import { m } from '../../src/i18n';
import { fileIconName } from '../../src/lib/fileIcons';
import { iconUrl } from '../../src/lib/icon-catalog';
import { SummaryFailure } from '../../src/summary/SummaryFailure';

export type SummaryLocale = 'en' | 'zh';
const file = z.object({
  addedAt: z.iso.datetime({ offset: true }),
  name: z.string(),
  sizeBytes: z.number(),
});
export const summarySchema = z.object({
  author: z.string(),
  authorAvatarUrl: z.string().optional(),
  chapters: z.array(z.object({ files: z.array(file), name: z.string() })),
  description: z.string(),
  files: z.array(file),
  iconId: z.string().regex(/^[a-z]+-[0-9]+$/),
  name: z.string(),
  privacy: z.enum(['public', 'link']),
  tags: z.array(z.string()),
});

export function localeFor(request: Request): SummaryLocale {
  const requested = new URL(request.url).searchParams.get('lang');
  if (requested === 'en' || requested === 'zh') return requested;
  return request.headers
    .get('Accept-Language')
    ?.split(',')[0]
    ?.trim()
    .toLowerCase()
    .startsWith('zh')
    ? 'zh'
    : 'en';
}

export function escapeHTML(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "'": '&#39;', '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' })[
        character
      ]!
  );
}
const jsonForHTML = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
const fileIcon = (name: string) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" stroke-width="1.3"><use data-file-icon="${escapeHTML(name)}"></use></svg>`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The header's sign-in and sign-up, the same for every visitor. The theme
 * toggle needs the browser, so this holds a static one of the same size until
 * the island renders the live nav. */
function publicNav(locale: SummaryLocale): string {
  const themeToggle = createElement(IconButton, {
    icon: 'moon',
    label: m.public_theme_dark({}, { locale }),
    variant: 'ghost-hover',
  });
  return `<div id="summary-nav" data-locale="${locale}">${renderToString(createElement(PublicNav, { locale, themeToggle }))}</div>`;
}

export function renderSummary(
  template: string,
  summary: WorkspaceSummary,
  id: string,
  sharePath: string,
  appOrigin: string,
  locale: SummaryLocale
): string {
  const options = { locale };
  const canonical = `${appOrigin}${sharePath}`;
  const openURL = `/workspaces/${id}`;
  const fileCount =
    summary.files.length +
    summary.chapters.reduce(
      (count, chapter) => count + chapter.files.length,
      0
    );
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const fileMeta = (entry: WorkspaceSummary['files'][number]) =>
    `${formatBytes(entry.sizeBytes)} · ${dateFormat.format(new Date(entry.addedAt))}`;
  const files = (entries: WorkspaceSummary['files']) =>
    `<ul class="summary-files">${entries.map((entry) => `<li>${fileIcon(fileIconName({ kind: 'unknown', name: entry.name }))}<span>${escapeHTML(entry.name)}</span><small>${escapeHTML(fileMeta(entry))}</small></li>`).join('')}</ul>`;
  const section = (name: string, entries: WorkspaceSummary['files']) =>
    `<section class="summary-chapter"><h2>${fileIcon('_folder_open')}<span>${escapeHTML(name)}</span></h2>${files(entries)}</section>`;
  const header = `<title>${escapeHTML(summary.name)} | Capy Notebook</title><meta name="description" content="${escapeHTML(summary.description || summary.name)}"><link rel="canonical" href="${escapeHTML(canonical)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHTML(summary.name)}"><meta property="og:description" content="${escapeHTML(summary.description || summary.name)}"><meta property="og:url" content="${escapeHTML(canonical)}"><meta property="og:site_name" content="Capy Notebook"><meta name="robots" content="${summary.privacy === 'link' ? 'noindex, nofollow' : 'index, follow'}"><script type="application/ld+json">${jsonForHTML({ '@context': 'https://schema.org', '@type': 'CreativeWork', description: summary.description, name: summary.name, url: canonical, ...(summary.author ? { author: { '@type': 'Person', name: summary.author } } : {}) })}</script>`;
  const openButton = renderToString(
    createElement(
      Button,
      {
        asChild: true,
        className: 'summary-open',
        iconRight: 'navigationForward',
        size: 'lg',
      },
      createElement('a', { href: openURL }, m.summary_open({}, options))
    )
  );
  // Menu's default ⋮ trigger; the island renders the live menu over it.
  const actionMenu = renderToString(
    createElement(IconButton, {
      className: 'p-2',
      icon: 'moreVertical',
      label: m.a11y_open_menu({}, { locale }),
      size: 'md',
      variant: 'ghost-hover',
    })
  );
  const body = `<div class="summary-shell"><header class="summary-header"><a class="summary-brand" href="/">Capy Notebook</a>${publicNav(locale)}</header><main class="summary-panel"><div class="summary-meta"><img class="summary-icon" src="${escapeHTML(iconUrl(summary.iconId))}" alt="" width="60" height="60"><div class="summary-title"><h1>${escapeHTML(summary.name)}</h1><div id="summary-actions" data-workspace-id="${escapeHTML(id)}" data-locale="${locale}">${actionMenu}</div></div>${summary.author ? `<p class="summary-byline">${summary.authorAvatarUrl ? `<img class="summary-avatar" src="${escapeHTML(summary.authorAvatarUrl)}" alt="" width="24" height="24">` : ''}${escapeHTML(summary.author)}</p>` : ''}${summary.description ? `<p class="summary-description">${escapeHTML(summary.description)}</p>` : ''}<ul class="summary-tags">${summary.tags.map((tag) => `<li># ${escapeHTML(tag)}</li>`).join('')}</ul>${openButton}</div><p class="summary-counts">${escapeHTML(m.workspace_card_meta({ chapters: String(summary.chapters.length), files: String(fileCount) }, options))}</p><div class="summary-outline">${summary.chapters.map((chapter) => section(chapter.name, chapter.files)).join('')}${summary.files.length ? `<div class="summary-chapter">${files(summary.files)}</div>` : ''}${!summary.chapters.length && !fileCount ? `<p class="summary-empty">${escapeHTML(m.summary_empty({}, options))}</p>` : ''}</div></main><footer class="summary-footer">Capy Notebook</footer></div>`;
  return template
    .replace('lang="en"', `lang="${locale}"`)
    .replace('<!--capy-summary-head-->', () => header)
    .replace('<!--capy-summary-body-->', () => body);
}

export function renderFailure(
  status: number,
  locale: SummaryLocale,
  template?: string
): string {
  const options = { locale };
  const unavailable = status === 404;
  if (template?.includes('<!--capy-summary-body-->')) {
    const title = unavailable
      ? m.error_not_found_page_title({}, options)
      : m.summary_error_title({}, options);
    return template
      .replace('lang="en"', `lang="${locale}"`)
      .replace(
        '<!--capy-summary-head-->',
        `<title>${escapeHTML(title)} | Capy Notebook</title><meta name="robots" content="noindex,nofollow">`
      )
      .replace(
        '<!--capy-summary-body-->',
        `<div class="summary-shell">${unavailable ? '' : `<header class="summary-header"><a class="summary-brand" href="/">Capy Notebook</a>${publicNav(locale)}</header>`}<main class="summary-panel" id="summary-error" data-status="${status}" data-locale="${locale}">${renderToString(createElement(SummaryFailure, { locale, status }))}</main></div>`
      );
  }
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHTML(unavailable ? m.error_not_found_page_title({}, options) : m.summary_error_title({}, options))} | Capy Notebook</title><body style="font:16px/1.6 system-ui;margin:12vh auto;padding:24px;max-width:580px">${unavailable ? '' : '<a href="/">Capy Notebook</a>'}<h1>${escapeHTML(unavailable ? m.error_not_found_page_title({}, options) : m.summary_error_title({}, options))}</h1><p>${escapeHTML(unavailable ? m.error_not_found_page_body({}, options) : m.summary_error_body({}, options))}</p>${unavailable ? '' : `<a href="">${escapeHTML(m.summary_retry({}, options))}</a>`}</body></html>`;
}
