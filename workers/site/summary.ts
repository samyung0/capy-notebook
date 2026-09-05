import { z } from 'zod';
import type { WorkspaceSummary } from '../../src/api/types';
import { m } from '../../src/i18n';

export const workspaceID = /^ws_[A-Za-z0-9_-]{1,64}$/;
export type SummaryLocale = 'en' | 'zh';
const filename = z.string();
export const summarySchema = z.object({
  author: z.string(),
  chapters: z.array(z.object({ files: z.array(filename), name: z.string() })),
  color: z.enum([
    'green',
    'purple',
    'blue',
    'amber',
    'coral',
    'graphite',
    'transparent',
  ]),
  description: z.string(),
  files: z.array(filename),
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
const notebook =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h12v16H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM8 4v16M12 9h4M12 13h3"/></svg>';
const fileIcon =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9H4V2Zm5 0v4h3M6 9h4M6 11h3"/></svg>';

export function renderSummary(
  template: string,
  summary: WorkspaceSummary,
  id: string,
  appOrigin: string,
  locale: SummaryLocale
): string {
  const options = { locale };
  const canonical = `${appOrigin}/w/${id}`;
  const openURL = `/workspaces/${id}`;
  const signInURL = `/sign-in?${new URLSearchParams({ redirect_url: openURL })}`;
  const visibility =
    summary.privacy === 'public'
      ? m.summary_public({}, options)
      : m.summary_link({}, options);
  const fileCount =
    summary.files.length +
    summary.chapters.reduce(
      (count, chapter) => count + chapter.files.length,
      0
    );
  const files = (names: string[]) =>
    `<ul class="summary-files">${names.map((name) => `<li>${fileIcon}<span>${escapeHTML(name)}</span></li>`).join('')}</ul>`;
  const section = (name: string, names: string[]) =>
    `<section class="summary-chapter"><h2>${escapeHTML(name)}</h2>${files(names)}</section>`;
  const header = `<title>${escapeHTML(summary.name)} | Capy Notebook</title><meta name="description" content="${escapeHTML(summary.description || summary.name)}"><link rel="canonical" href="${escapeHTML(canonical)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHTML(summary.name)}"><meta property="og:description" content="${escapeHTML(summary.description || summary.name)}"><meta property="og:url" content="${escapeHTML(canonical)}"><meta property="og:site_name" content="Capy Notebook"><meta name="robots" content="${summary.privacy === 'link' ? 'noindex, nofollow' : 'index, follow'}"><script type="application/ld+json">${jsonForHTML({ '@context': 'https://schema.org', '@type': 'CreativeWork', description: summary.description, name: summary.name, url: canonical, ...(summary.author ? { author: { '@type': 'Person', name: summary.author } } : {}) })}</script>`;
  const body = `<div class="summary-shell"><header class="summary-header"><a class="summary-brand" href="/">${notebook}<span>Capy Notebook</span></a><div id="summary-auth" data-workspace-id="${id}" data-locale="${locale}"><nav class="summary-auth-fallback" aria-label="${escapeHTML(m.summary_profile({}, options))}"><a href="/explore">${escapeHTML(m.nav_explore({}, options))}</a><a href="${escapeHTML(signInURL)}">${escapeHTML(m.action_sign_in({}, options))}</a></nav></div></header><main class="summary-panel"><div class="summary-meta"><div class="summary-icon" data-color="${summary.color}">${notebook}</div><h1>${escapeHTML(summary.name)}</h1><p class="summary-byline">${summary.author ? `${escapeHTML(m.summary_shared_by({ author: summary.author }, options))} · ` : ''}${escapeHTML(visibility)}</p>${summary.description ? `<p class="summary-description">${escapeHTML(summary.description)}</p>` : ''}<ul class="summary-tags">${summary.tags.map((tag) => `<li># ${escapeHTML(tag)}</li>`).join('')}</ul><a class="summary-open" href="${openURL}">${escapeHTML(m.summary_open({}, options))}<span aria-hidden="true">↗</span></a></div><p class="summary-counts">${escapeHTML(m.workspace_card_meta({ chapters: String(summary.chapters.length), files: String(fileCount) }, options))}</p><div class="summary-outline">${summary.chapters.map((chapter) => section(chapter.name, chapter.files)).join('')}${summary.files.length ? section(m.summary_unfiled({}, options), summary.files) : ''}${!summary.chapters.length && !fileCount ? `<p class="summary-empty">${escapeHTML(m.summary_empty({}, options))}</p>` : ''}</div></main><footer class="summary-footer">Capy Notebook</footer></div>`;
  return template
    .replace('lang="en"', `lang="${locale}"`)
    .replace('<!--capy-summary-head-->', () => header)
    .replace('<!--capy-summary-body-->', () => body);
}

export function renderFailure(status: number, locale: SummaryLocale): string {
  const options = { locale };
  const unavailable = status === 404;
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHTML(unavailable ? m.summary_unavailable_title({}, options) : m.summary_error_title({}, options))} | Capy Notebook</title><body style="font:16px/1.6 system-ui;margin:12vh auto;padding:24px;max-width:580px"><a href="/">Capy Notebook</a><h1>${escapeHTML(unavailable ? m.summary_unavailable_title({}, options) : m.summary_error_title({}, options))}</h1><p>${escapeHTML(unavailable ? m.summary_unavailable_body({}, options) : m.summary_error_body({}, options))}</p>${unavailable ? '' : `<a href="">${escapeHTML(m.summary_retry({}, options))}</a>`}</body></html>`;
}
