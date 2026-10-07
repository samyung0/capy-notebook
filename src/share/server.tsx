import { convertLatexToMarkup } from 'mathlive/ssr';
import { renderToString } from 'react-dom/server';
import type { AnonymousNote } from '@/api/types';
import { TooltipProvider } from '@/components/ui/Tooltip';
// @ts-expect-error generated at build time by the Paraglide Vite plugin
import { overwriteGetLocale } from '@/i18n/paraglide/runtime';
import { escapeHTML, jsonForHTML } from '@/lib/html';
import { SharedNote, withoutRepeatedTitle } from './SharedNote';
import { StudyPage, type StudyState } from './StudyPage';
import { SHARE_STATE_ID, type ShareState } from './state';

/* The site Worker's renderer for `/share/*` (workers/site/handler.ts), built by
   Vite as its own bundle (`vite build --ssr`) so the page components keep
   their browser imports. Quizzes and flashcard sets render the tree the
   browser hydrates (StudyPage); notes render to HTML for good, apart from
   their islands. */

export type ShareLocale = 'en' | 'zh';
/** The API's read for one share link. */
export type SharePage =
  | StudyState
  | { kind: 'notes'; note: AnonymousNote; token: string };

// Rendering is synchronous, so one request's locale holds for its render.
let renderLocale: ShareLocale = 'en';
overwriteGetLocale(() => renderLocale);

/** MathLive's static layout, as the editor's read-only field draws it. */
const mathMarkup = (tex: string, displayMode: boolean) =>
  `<span class="text-[1.21em] leading-[1.2]">${convertLatexToMarkup(
    // MathLive 0.110 has no \dots; show \ldots, keeping the stored LaTeX.
    tex.replace(/\\dots(?![a-zA-Z])/g, '\\ldots'),
    { defaultMode: displayMode ? 'math' : 'inline-math' }
  )}</span>`;

const hasMath = (node: unknown): boolean =>
  typeof node === 'object' &&
  node !== null &&
  (('type' in node &&
    (node.type === 'equation' || node.type === 'inline_equation')) ||
    ('children' in node &&
      Array.isArray(node.children) &&
      node.children.some(hasMath)));

/** `page` in `template` (share.html). Throws when a note's content is not a
 * material document. */
export function renderSharePage({
  canonical,
  locale,
  page,
  template,
}: {
  canonical: string;
  locale: ShareLocale;
  page: SharePage;
  template: string;
}): string {
  renderLocale = locale;
  let body: string;
  let state: ShareState;
  let item: { name: string; privacy: string };
  let extraHead = '';
  if (page.kind === 'notes') {
    const { note, token } = page;
    const document = withoutRepeatedTitle(note.content, note.name);
    if (!document) throw new Error('Shared note is not a material document');
    item = note;
    state = { embeds: note.embeds, kind: 'notes', token };
    body = renderToString(
      <TooltipProvider>
        <SharedNote
          document={document}
          mathMarkup={mathMarkup}
          note={note}
          token={token}
        />
      </TooltipProvider>
    );
    if (hasMath({ children: document.value }))
      extraHead =
        '<link rel="stylesheet" href="/mathlive/mathlive-static.css"><link rel="stylesheet" href="/mathlive/mathlive-fonts.css">';
  } else {
    state = page;
    item = page.kind === 'quizzes' ? page.quiz : page.set;
    body = renderToString(<StudyPage state={page} />);
  }
  const title = `${escapeHTML(item.name)} | Capy Notebook`;
  const head = `<title>${title}</title><link rel="canonical" href="${escapeHTML(canonical)}"><meta property="og:type" content="article"><meta property="og:title" content="${escapeHTML(item.name)}"><meta property="og:url" content="${escapeHTML(canonical)}"><meta property="og:site_name" content="Capy Notebook"><meta name="robots" content="${item.privacy === 'link' ? 'noindex, nofollow' : 'index, follow'}">${extraHead}`;
  return template
    .replace('lang="en"', `lang="${locale}"`)
    .replace('<!--capy-share-head-->', () => head)
    .replace(
      '<!--capy-share-body-->',
      () =>
        `<div id="root">${body}</div><script type="application/json" id="${SHARE_STATE_ID}">${jsonForHTML(state)}</script>`
    );
}

/** The template markers the Worker checks before rendering. */
export const SHARE_TEMPLATE_MARKERS = [
  '<!--capy-share-head-->',
  '<!--capy-share-body-->',
];
