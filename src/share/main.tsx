import { bindPublicChrome } from '@/components/app/publicChrome';
import { scrollToTocHeading } from '@/features/materials/scrollToTocHeading';
import {
  YOUTUBE_PLAYER_ALLOW,
  youtubeEmbedUrl,
} from '@/features/materials/youtubeUrl';
// @ts-expect-error generated at build time by the Paraglide Vite plugin
import { overwriteGetLocale } from '@/i18n/paraglide/runtime';
import { applyFullStyles } from '@/lib/fullStyles';
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
// Public pages are English only, as the server rendered them.
overwriteGetLocale(() => 'en');

bindPublicChrome();
// The page arrives with only the CSS its HTML uses; anything rendered here
// waits for the full stylesheets.
const styled = applyFullStyles();

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
  // Every island hydrates at load, so none changes size while the reader
  // scrolls past it.
  const islands = [...document.querySelectorAll<HTMLElement>('[data-island]')];
  if (islands.length)
    void Promise.all([import('./islands'), styled]).then(
      ([{ hydrateIslands }]) => hydrateIslands(state, islands)
    );
} else {
  void Promise.all([import('./hydrateStudy'), styled]).then(
    ([{ hydrateStudy }]) => hydrateStudy(state)
  );
}
