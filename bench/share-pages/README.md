# Shared pages

Measures the signed-out pages the site Worker renders, on the deployed UAT
site: `/w/{id}` workspace summaries and `/share/{quizzes,flashcards,notes}/{token}`.
Numbers from a laptop against a local Worker differ too much from the real
edge to be useful, so this family only measures UAT.

```sh
pnpm bench:share-pages
```

It needs `UAT_TARGET_AUTHORIZED=true`, `UAT_ALLOWED_HOSTS`, `UAT_APP_URL`,
`UAT_OWNER_EMAIL` and UAT's `CLERK_SECRET_KEY`. The `share_pages` job of the
`Performance` workflow supplies them from the `uat` environment.

## What a run does

1. Signs in the fixed UAT owner with a Clerk sign-in ticket and deletes
   leftovers of earlier runs (everything named `Perf share page …`).
2. Creates, through the API, a link-shared workspace with four store-only
   files in two chapters (`e2e/fixtures/files/basic/`), a quiz
   (`fixtures/quiz.json`), a flashcard set (`fixtures/cards.json`) and a
   standalone note: the every-block note
   (`server/internal/materialdoc/testdata/every-block-note.json`) without its
   uploaded assets and material links, plus a second copy that also leaves
   out the blocks only the browser can draw (Mermaid diagrams and interactive
   HTML frames), so their layout shift shows apart from the rest. Nothing is
   parsed, embedded or sent to a model.
3. Waits until each item's public API answers 200. It never requests the
   page itself, so the first page request is a real miss.
4. Inlined CSS check (fails the run): the Worker inlines only the rules a
   page's HTML uses (`workers/site/usedCss.ts`). Each page is loaded with only
   those rules and with the full stylesheets instead, page scripts blocked,
   in light and dark, 412 px and 1366 px wide; every element's and
   pseudo-element's computed style and the full-page screenshots must match
   (`scripts/styles.ts`). When the screenshots differ, both pages are loaded
   twice more: the inlined page passes if it ever matches a full render; if
   the full page's own renders vary, the difference is the rasteriser's and
   is reported as noise (pixel count, place, element); otherwise the run
   fails. Both screenshots are saved either way. A page served from before the Worker cut its CSS is
   cut by the bench with the same code, so the check can run before a deploy.
5. Caching checks (these fail the run): each page answers
   `public, s-maxage=300, max-age=0, must-revalidate` with no `Set-Cookie` and
   no `Vary` (other than `Accept-Encoding`); a second visitor with other
   cookies, language and user agent gets the same bytes with
   `CF-Cache-Status: HIT`, and so does `HEAD`; a forged link gets the 404 page,
   `no-store`, and is not served from the cache.
6. Lighthouse 13 with simulated throttling, `SHARE_PERF_RUNS` times (3 by
   default) per page, profile and edge state, in a Chromium separate from the
   signed-in one. Profiles: **desktop** (40 ms RTT, 10 Mbps, full-speed CPU),
   closer to most visitors, and **mobile** (slow 4G, 4x slower CPU), the
   worst case. Edge states:
   - **uncached**: the URL with a unique `?perf=…`. Workers Cache keys on the
     query string, so the Worker renders the page from the API.
   - **cached**: the clean URL, served from Workers Cache.
7. Deletes what it created.

Reported per page, profile and edge state (the median of the runs): the
document's TTFB, simulated FCP and LCP (and the unthrottled ones the runner
observed, in the JSON), CLS (load only, before any scroll) with the
shifting elements, TBT, transfer bytes by
type, request count and the performance score, and whether a second visitor
hit the cache, and the inlined CSS's size and comparison. Results land in the gitignored `.results/`: `share-pages.json`,
`summary.md` (the job summary) and, for the median-LCP run of each page,
profile and state, the HTML report, the full Lighthouse result (`.lhr.json`) and the
DevTools trace (`.trace.json`, opens in the Performance panel).

Lighthouse budgets are report-only until a developer signs them off from a
few runs' numbers.
