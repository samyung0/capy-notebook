import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { z } from 'zod';
import type { WorkspaceSummary } from '../../src/api/types';
import { PublicActionMenu } from '../../src/components/app/PublicActionMenu';
import { PublicNav } from '../../src/components/app/PublicHeader';
import { Button } from '../../src/components/ui/Button';
import { m } from '../../src/i18n';
import { fileIconName } from '../../src/lib/fileIcons';
import { escapeHTML } from '../../src/lib/html';
import { iconUrl } from '../../src/lib/icon-catalog';
import { seoHead } from '../../src/lib/seoHead';
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

const fileIcon = (name: string) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" stroke-width="1.3"><use data-file-icon="${escapeHTML(name)}"></use></svg>`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The header's theme button, sign-in and sign-up, the same for every
 * visitor; they work without React (publicChrome.ts). */
const publicNav = (locale: SummaryLocale) =>
  renderToString(createElement(PublicNav, { locale }));

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
  const counts = m.workspace_card_meta(
    {
      chapters: String(summary.chapters.length),
      files: String(fileCount),
    },
    options
  );
  const header = seoHead({
    author: summary.author || undefined,
    canonical,
    description:
      summary.description ||
      m.share_seo_workspace({ author: summary.author, meta: counts }, options),
    indexable: summary.privacy === 'public',
    jsonLd: { '@type': 'CreativeWork' },
    locale,
    name: summary.name,
  });
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
  const actionMenu = renderToString(
    createElement(PublicActionMenu, { id, kind: 'workspace', locale })
  );
  const body = `<div class="summary-shell"><header class="summary-header"><a class="summary-brand" href="/">Capy Notebook</a>${publicNav(locale)}</header><main class="summary-panel"><div class="summary-meta"><img class="summary-icon" src="${escapeHTML(iconUrl(summary.iconId))}" alt="" width="60" height="60"><div class="summary-title"><h1>${escapeHTML(summary.name)}</h1><div id="summary-actions" data-workspace-id="${escapeHTML(id)}">${actionMenu}</div></div>${summary.author ? `<p class="summary-byline">${summary.authorAvatarUrl ? `<img class="summary-avatar" src="${escapeHTML(summary.authorAvatarUrl)}" alt="" width="24" height="24">` : ''}${escapeHTML(summary.author)}</p>` : ''}${summary.description ? `<p class="summary-description">${escapeHTML(summary.description)}</p>` : ''}<ul class="summary-tags">${summary.tags.map((tag) => `<li># ${escapeHTML(tag)}</li>`).join('')}</ul>${openButton}</div><p class="summary-counts">${escapeHTML(counts)}</p><div class="summary-outline">${summary.chapters.map((chapter) => section(chapter.name, chapter.files)).join('')}${summary.files.length ? `<div class="summary-chapter">${files(summary.files)}</div>` : ''}${!summary.chapters.length && !fileCount ? `<p class="summary-empty">${escapeHTML(m.summary_empty({}, options))}</p>` : ''}</div></main><footer class="summary-footer">Capy Notebook</footer></div>`;
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
        `<div class="summary-shell">${unavailable ? '' : `<header class="summary-header"><a class="summary-brand" href="/">Capy Notebook</a>${publicNav(locale)}</header>`}<main class="summary-panel">${renderToString(createElement(SummaryFailure, { locale, status }))}</main></div>`
      );
  }
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHTML(unavailable ? m.error_not_found_page_title({}, options) : m.summary_error_title({}, options))} | Capy Notebook</title><body style="font:16px/1.6 system-ui;margin:12vh auto;padding:24px;max-width:580px">${unavailable ? '' : '<a href="/">Capy Notebook</a>'}<h1>${escapeHTML(unavailable ? m.error_not_found_page_title({}, options) : m.summary_error_title({}, options))}</h1><p>${escapeHTML(unavailable ? m.error_not_found_page_body({}, options) : m.summary_error_body({}, options))}</p>${unavailable ? '' : `<a href="">${escapeHTML(m.summary_retry({}, options))}</a>`}</body></html>`;
}
