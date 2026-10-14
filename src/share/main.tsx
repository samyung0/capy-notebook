import './jitless';
import { bindPublicChrome } from '@/components/app/publicChrome';
import { scrollToTocHeading } from '@/features/materials/scrollToTocHeading';
import {
  YOUTUBE_PLAYER_ALLOW,
  youtubeEmbedUrl,
} from '@/features/materials/youtubeUrl';
import { currentNoteFont, setNoteFont } from '@/features/notes/noteFont';
// @ts-expect-error generated at build time by the Paraglide Vite plugin
import { overwriteGetLocale } from '@/i18n/paraglide/runtime';
import { afterPaint } from '@/lib/afterPaint';
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
// Everything below waits for first paint, so no download competes with it.
const painted = afterPaint();
// The page arrives with only the CSS its HTML uses; anything rendered here
// waits for the full stylesheets.
const styled = painted.then(applyFullStyles);

// Analytics loads after the page, never ahead of it. Public pages carry no
// error reporting (Sentry stays in the app).
void painted.then(async () => {
  const { trackPageView } = await import('@/lib/analytics');
  trackPageView(
    `/share/${state.kind}/${
      { flashcards: '$flashcardSetId', notes: '$noteId', quizzes: '$quizId' }[
        state.kind
      ]
    }`
  );
});

if (state.kind === 'notes') {
  document.addEventListener('click', (event) => {
    const target = event.target as Element;
    const toc = target.closest<HTMLElement>('[data-toc-order]');
    if (toc) scrollToTocHeading(toc, Number(toc.dataset.tocOrder));
    if (target.closest('[data-note-font-toggle]'))
      setNoteFont(
        currentNoteFont(document.documentElement.dataset.style) === 'system'
          ? 'fustat'
          : 'system'
      );
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
    void painted.then(async () => {
      const [{ hydrateIslands }] = await Promise.all([
        import('./islands'),
        styled,
      ]);
      hydrateIslands(state, islands);
    });
} else {
  // Each kind downloads only its own page code.
  void painted.then(async () => {
    if (state.kind === 'quizzes') {
      const [{ hydrateQuiz }] = await Promise.all([
        import('./hydrateQuiz'),
        styled,
      ]);
      await hydrateQuiz(state);
    } else {
      const [{ hydrateFlashcards }] = await Promise.all([
        import('./hydrateFlashcards'),
        styled,
      ]);
      await hydrateFlashcards(state);
    }
  });
}
