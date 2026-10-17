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
   (`fixtures/quiz.json`), a flashcard set (`fixtures/cards.json`, written
   through the set's live room as its editor does, since live rooms are the
   only writers of set content) and a
   standalone note: the every-block note
   (`server/internal/materialdoc/testdata/every-block-note.json`) without its
   uploaded assets and material links, plus a second copy that also leaves
   out the blocks only the browser can draw (Mermaid diagrams and interactive
   HTML frames), so their layout shift shows apart from the rest, and a
   near-limit note: the app's load-test note
   (`src/mocks/noteContent/loadTest.ts`, every kind of block padded to 95% of
   the 2 MB content limit), long enough that the Worker streams it (its
   blocks after the first screen arrive in slices, each with the rules it
   adds). Nothing is parsed, embedded or sent to a model.
3. Waits until each item's public API answers 200. It never requests the
   page itself, so the first page request is a real miss.
4. Inlined CSS check (fails the run): the Worker inlines only the rules a
   page's HTML uses (`workers/site/usedCss.ts`). Each page is loaded with only
   those rules and with the full stylesheets instead, page scripts blocked,
   in light and dark (the inline theme script still runs, so a dark color
   scheme gets the dark theme), 412 px and 1366 px wide; every element's and
   pseudo-element's computed style and the full-page screenshots must match
   (`scripts/styles.ts`). When the computed styles or the screenshots
   differ, both pages are loaded twice more: the inlined page passes if it
   ever matches a full render; if the full page's own renders vary, the
   difference is the rasteriser's or the layout's and is reported as noise
   (properties, or pixel count, place and element); otherwise the run
   fails. Both screenshots are saved either way. A page served from before the Worker cut its CSS is
   cut by the bench with the same code, so the check can run before a deploy.
5. Caching checks (these fail the run): each page answers
   `public, s-maxage=300, max-age=0, must-revalidate` with no `Set-Cookie` and
   no `Vary` (other than `Accept-Encoding`); a second visitor with other
   cookies, language and user agent gets the same bytes with
   `CF-Cache-Status: HIT`, and so does `HEAD`; a forged link gets the 404 page,
   `no-store`, and is not served from the cache.
6. Lighthouse 13, `SHARE_PERF_RUNS` counted runs (5 by default) per page,
   profile and edge state (desktop uncached and cached, mobile cached), in a
   Chromium separate from the signed-in one. Profiles:
   **desktop**, closer to most visitors: 40 ms RTT and 10 Mbps applied to
   the real requests (DevTools throttling), full-speed CPU, so the
   document's real server time is in FCP and LCP; and **mobile**, the worst
   case: a phone on slow 4G with a 4x slower CPU, simulated for steady
   numbers. Simulation estimates server time per origin and leaves it out of
   FCP and LCP, so mobile is measured cached only: an uncached mobile run
   added nothing but a second TTFB (dropped 2026-10-12). Edge states:
   - **uncached**: the URL with a unique `?perf=…`. Workers Cache keys on the
     query string and the Worker ignores it, so this is the clean page's full
     cold render (token check, API read, render, CSS cut). An entry cannot be
     dropped from outside (purging is only `ctx.cache.purge` inside the
     Worker, and a deploy resets them all), so a fresh key is how a miss is
     forced.
   - **cached**: the clean URL, requested just before each run so its
     five-minute entry is fresh.
   Each run records its own document's `CF-Cache-Status`; the summary marks a
   run the edge answered against the plan. Every run is a first visit
   (Lighthouse empties the browser cache).

   An uncached run counts only when a warm Worker isolate rendered it
   (`Server-Timing: isolate;desc="reused"`, from `workers/site/index.ts`).
   UAT's traffic is low enough that about half of all requests land on a
   new isolate, whose cold start adds a few hundred ms at random; with
   them in, a five-run median moved by about half a second between runs
   (2026-10-12). Uncached runs go on until `SHARE_PERF_RUNS` warm ones, up
   to four times that many; the cold ones are reported on their own row and
   in the JSON (`cold`), not budgeted.
7. Deletes what it created.

Reported per page, profile and edge state (the median of the counted runs,
and for uncached the new-isolate runs apart): the
document's TTFB, the Worker's own `Server-Timing` for an uncached render
(`api`, the API read, and `total`, until the page was built; a Worker's clock
moves only on I/O, so CPU work such as rendering is the rest of TTFB and shows
as CPU time in Workers Logs), simulated FCP and LCP (and the unthrottled ones the runner
observed, in the JSON), CLS (load only, before any scroll) with the
shifting elements, TBT, transfer bytes by
type, request count and the performance score, and whether a second visitor
hit the cache, and the inlined CSS's size and comparison. Results land in the gitignored `.results/`: `share-pages.json`,
`summary.md` (the job summary) and, for the median-LCP run of each page,
profile and state, the HTML report, the full Lighthouse result (`.lhr.json`) and the
DevTools trace (`.trace.json`, opens in the Performance panel).

The medians must stay within `BUDGETS` in the script (signed off 2026-10-11
from two runs: the worst median with some headroom), or the run fails:
paint times per profile and edge state, mobile blocking time and LCP and
the transfer size per page, CLS everywhere, and the uncached render's
Worker and API time. Blocking time scales with the runner's CPU (GitHub's
runners differ by about 1.6x), so its budgets come from the slower one.
