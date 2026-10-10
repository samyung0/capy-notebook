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
4. Caching checks (these fail the run): each page answers
   `public, s-maxage=300, max-age=0, must-revalidate` with no `Set-Cookie` and
   no `Vary` (other than `Accept-Encoding`); a second visitor with other
   cookies, language and user agent gets the same bytes with
   `CF-Cache-Status: HIT`, and so does `HEAD`; a forged link gets the 404 page,
   `no-store`, and is not served from the cache.
5. Lighthouse 13 (mobile preset, simulated throttling), `SHARE_PERF_RUNS`
   times (3 by default) per page and edge state, in a Chromium separate from
   the signed-in one:
   - **cold**: the URL with a unique `?perf=…`. Workers Cache keys on the
     query string, so the Worker renders the page from the API.
   - **warm**: the clean URL, served from Workers Cache.
6. Deletes what it created.

Reported per page and edge state (the median of the runs): simulated and
observed (unthrottled) FCP and LCP, CLS (load only, before any scroll) with the
shifting elements, TBT, the document's server response time, transfer bytes by
type, request count and the performance score, and whether a second visitor
hit the cache. Results land in the gitignored `.results/`: `share-pages.json`,
`summary.md` (the job summary) and, for the median-LCP run of each page and
state, the HTML report, the full Lighthouse result (`.lhr.json`) and the
DevTools trace (`.trace.json`, opens in the Performance panel).

Lighthouse budgets are report-only until a developer signs them off from a
few runs' numbers.
