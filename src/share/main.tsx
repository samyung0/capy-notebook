import { bindPublicChrome } from '@/components/app/publicChrome';
import { scrollToTocHeading } from '@/features/materials/scrollToTocHeading';
import {
  YOUTUBE_PLAYER_ALLOW,
  youtubeEmbedUrl,
} from '@/features/materials/youtubeUrl';
// @ts-expect-error generated at build time by the Paraglide Vite plugin
import { overwriteGetLocale } from '@/i18n/paraglide/runtime';
import { SHARE_STATE_ID, type ShareState } from './state';
import '@/styles/tailwind.css';

/* Public `/share/*` pages. The site Worker renders them (src/share/server.tsx)
   and writes the data it used into `#share-state`; this script only brings
   the HTML to life. A quiz or flashcard set hydrates whole; a note stays HTML,
   with plain script for its contents and video buttons and React only for its
   islands. */

const state = JSON.parse(
  document.getElementById(SHARE_STATE_ID)?.textContent ?? 'null'
) as ShareState;
// The server rendered in the page's locale; hydrate in the same one.
const locale = document.documentElement.lang === 'zh' ? 'zh' : 'en';
overwriteGetLocale(() => locale);

bindPublicChrome();

// Analytics loads after the page, never ahead of it. Public pages carry no
// error reporting (Sentry stays in the app).
void import('@/lib/analytics').then(({ trackPageView }) =>
  trackPageView(
    `/share/${state.kind}/${
      { flashcards: '$flashcardSetId', notes: '$noteId', quizzes: '$quizId' }[
        state.kind
      ]
    }`
  )
);

if (state.kind === 'notes') {
  document.addEventListener('click', (event) => {
    const target = event.target as Element;
    const toc = target.closest<HTMLElement>('[data-toc-order]');
    if (toc) scrollToTocHeading(toc, Number(toc.dataset.tocOrder));
    // The poster stands in for the player until clicked (YouTubeEmbed.tsx).
    const poster = target.closest<HTMLElement>('[data-youtube-play]');
    if (poster?.dataset.youtubePlay) {
      const player = document.createElement('iframe');
      player.allow = YOUTUBE_PLAYER_ALLOW;
      player.allowFullscreen = true;
      player.className = 'size-full';
      player.src = youtubeEmbedUrl(poster.dataset.youtubePlay, true);
      player.title = 'YouTube';
      poster.replaceWith(player);
    }
  });
  const islands = [...document.querySelectorAll<HTMLElement>('[data-island]')];
  if (islands.length)
    void import('./islands').then(({ hydrateIslands }) =>
      hydrateIslands(state, islands)
    );
} else {
  void import('./hydrateStudy').then(({ hydrateStudy }) => hydrateStudy(state));
}
