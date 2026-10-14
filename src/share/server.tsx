import { convertLatexToMarkup } from 'mathlive/ssr';
import { renderToString } from 'react-dom/server';
import type { AnonymousNote } from '@/api/types';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { MaterialValue } from '@/features/materials/document';
import { quizMeta } from '@/features/quizzes/QuizPage';
import { m } from '@/i18n';
// @ts-expect-error generated at build time by the Paraglide Vite plugin
import { overwriteGetLocale } from '@/i18n/paraglide/runtime';
import { jsonForHTML } from '@/lib/html';
import { seoHead, snippet } from '@/lib/seoHead';
import { SharedFlashcards } from './SharedFlashcards';
import {
  NoteBlocks,
  plainText,
  SharedNote,
  withoutRepeatedTitle,
} from './SharedNote';
import { SharedQuiz } from './SharedQuiz';
import { StudyPage, type StudyState } from './StudyPage';
import { SHARE_STATE_ID, type ShareState } from './state';

/* The site Worker's renderer for `/share/*` (workers/site/handler.ts), built by
   Vite as its own bundle (`vite build --ssr`) so the page components keep
   their browser imports. Quizzes and flashcard sets render the tree the
   browser hydrates (StudyPage); notes render to HTML for good, apart from
   their islands. Workspace summaries and the error pages render from the same
   bundle, which the Worker imports only when it renders a page. */

export {
  renderFailure,
  renderSummary,
  summarySchema,
} from '@/summary/render';

declare const __CAPY_IMAGE_POLICY__: string;
/** The image-source policy every rendered page is sent with, report-only,
 * as the app's own pages are (vite-image-policy.ts). */
export const IMAGE_POLICY = __CAPY_IMAGE_POLICY__;

/** The API's read for one share link. */
export type SharePage =
  | StudyState
  | { kind: 'notes'; note: AnonymousNote; token: string };

// Public pages are English only, and a Worker has no browser to ask.
overwriteGetLocale(() => 'en');

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

/** About how many bytes of a note's block JSON render before the page is
 * first sent (the first screen or more), and then per streamed slice. */
const SLICE_BYTES = { first: 24 * 1024, rest: 128 * 1024 };

/** Holds the place of the blocks that stream after the first slice. */
const REST_ID = 'capy-share-rest';

/** Top-level blocks in runs of about `first`, then `rest` bytes of JSON. */
function slices(value: MaterialValue, { first, rest }: typeof SLICE_BYTES) {
  const runs: MaterialValue[] = [[]];
  let size = 0;
  for (const block of value) {
    if (size >= (runs.length === 1 ? first : rest)) {
      runs.push([]);
      size = 0;
    }
    runs.at(-1)?.push(block);
    size += JSON.stringify(block).length;
  }
  return runs;
}

/** A page in the order the Worker sends it: `first` (the head and the
 * note's first blocks), each of `rest` (later blocks, rendered when called)
 * and `last`. Joined, they are the whole page. Only a long note has a
 * `rest`. */
export type SharePagePieces = {
  first: string;
  last: string;
  rest: (() => string)[];
};

/** `page` in `template` (share.html), in pieces. Throws when a note's content
 * is not a material document. */
export function renderSharePagePieces({
  canonical,
  page,
  sliceBytes = SLICE_BYTES,
  template,
}: {
  canonical: string;
  page: SharePage;
  sliceBytes?: typeof SLICE_BYTES;
  template: string;
}): SharePagePieces {
  let body: string;
  // A placeholder block where the streamed blocks go, and how to render them.
  let streamed: { placeholder: string; rest: (() => string)[] } | undefined;
  let state: ShareState;
  let head: string;
  let extraHead = '';
  if (page.kind === 'notes') {
    const { note, token } = page;
    const document = withoutRepeatedTitle(note.content, note.name);
    if (!document) throw new Error('Shared note is not a material document');
    state = { embeds: note.embeds, kind: 'notes', token };
    head = seoHead({
      author: note.author.name,
      canonical,
      description:
        // Paragraphs read as a description; headings only when there are none.
        snippet(
          document.value
            .filter((node) => node.type === 'p')
            .map(plainText)
            .join(' ')
        ) ||
        snippet(document.value.map(plainText).join(' ')) ||
        m.share_seo_note({ author: note.author.name }),
      indexable: note.privacy === 'public',
      jsonLd: { '@type': 'Article', headline: note.name },
      modified: note.updatedAt,
      name: note.name,
    });
    const props = { mathMarkup, note, toc: document.value, token };
    // Only the blocks: what the editor root holds. Each slice is its own
    // render, so its React ids get their own prefix to stay unique.
    const blocks = (value: MaterialValue, slice: number) => {
      const html = renderToString(
        <TooltipProvider>
          <NoteBlocks document={{ ...document, value }} {...props} />
        </TooltipProvider>,
        { identifierPrefix: `s${slice}-` }
      );
      const root = 'data-slate-node="value">';
      return html.slice(
        html.indexOf(root) + root.length,
        html.lastIndexOf('</div></div>')
      );
    };
    const [firstRun, ...laterRuns] = slices(document.value, sliceBytes);
    const placeholder = {
      children: [{ text: '' }],
      id: REST_ID,
      type: 'p',
    } as MaterialValue[number];
    if (laterRuns.length)
      streamed = {
        placeholder: blocks([placeholder], 0),
        rest: laterRuns.map((run, index) => () => blocks(run, index + 1)),
      };
    body = renderToString(
      <TooltipProvider>
        <SharedNote
          document={{
            ...document,
            value: streamed ? [...firstRun, placeholder] : firstRun,
          }}
          {...props}
        />
      </TooltipProvider>
    );
    if (hasMath({ children: document.value }))
      extraHead =
        '<link rel="stylesheet" href="/mathlive/mathlive-static.css">';
  } else {
    state = page;
    const item = page.kind === 'quizzes' ? page.quiz : page.set;
    const author = item.author.name;
    head = seoHead({
      author,
      canonical,
      description:
        page.kind === 'quizzes'
          ? m.share_seo_quiz({ author, meta: quizMeta(page.quiz.questions) })
          : page.set.cards.length === 1
            ? m.share_seo_flashcards_one({ author })
            : m.share_seo_flashcards({ author, count: page.set.cards.length }),
      indexable: item.privacy === 'public',
      jsonLd:
        page.kind === 'quizzes'
          ? { '@type': 'Quiz' }
          : { '@type': 'LearningResource', learningResourceType: 'Flashcards' },
      modified: item.updatedAt,
      name: item.name,
    });
    body = renderToString(
      <StudyPage>
        {page.kind === 'quizzes' ? (
          <SharedQuiz quiz={page.quiz} token={page.token} />
        ) : (
          <SharedFlashcards set={page.set} token={page.token} />
        )}
      </StudyPage>
    );
  }
  const html = template
    .replace('<!--capy-share-head-->', () => head + extraHead)
    .replace(
      '<!--capy-share-body-->',
      () =>
        `<div id="root">${body}</div><script type="application/json" id="${SHARE_STATE_ID}">${jsonForHTML(state)}</script>`
    );
  if (!streamed) return { first: html, last: '', rest: [] };
  const at = html.indexOf(streamed.placeholder);
  return {
    first: html.slice(0, at),
    last: html.slice(at + streamed.placeholder.length),
    rest: streamed.rest,
  };
}

/** The whole page at once. */
export function renderSharePage(
  args: Parameters<typeof renderSharePagePieces>[0]
): string {
  const { first, last, rest } = renderSharePagePieces(args);
  return first + rest.map((render) => render()).join('') + last;
}

/** The template markers the Worker checks before rendering. */
export const SHARE_TEMPLATE_MARKERS = [
  '<!--capy-share-head-->',
  '<!--capy-share-body-->',
];
