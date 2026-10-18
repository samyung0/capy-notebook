# SPA bundle budget

Gates the production client build in CI (Epo 2026-10-18): how many bytes and
files a page loads before it renders, what each route adds, the largest chunk,
and modules that must never reach a page.

```sh
pnpm run build && pnpm bench:bundle      # or: node bench/bundle/scripts/budget.mjs [dist]
```

CI runs it in `frontend_check` right after `pnpm run build`; the table lands in
the step summary and any `OVER` row fails the job. That build has none of a
release's deploy settings: without a Sentry DSN, Sentry's setup and the lazy
Replay chunk drop out, so a deployed build's entry is about 26 KB larger than
the one CI measures.

## What it reads

The client build writes two files into `dist/.vite/`, which
`public/.assetsignore` keeps out of the deployed assets:

- `manifest.json` (`build.manifest`): each chunk's static imports and
  stylesheets;
- `chunk-modules.json` (the `chunk-modules` plugin in `vite.config.ts`): each
  JS chunk's modules as paths from the repository root, a package's as
  `node_modules/<name>/…`. A route Rollup merges into a shared chunk has no
  manifest entry of its own, so routes and never-in rules find their chunk
  here.

Every size is the file compressed with brotli at quality 11, in KB of 1024
bytes. A page's closure is its chunk and the chunks it imports statically,
transitively: what `index.html` modulepreloads, or what Vite preloads with a
lazy route.

## The budget file

All limits and rules live in [`budget.json`](budget.json), the one file to
edit when a change needs more room; move the limit in the same change that
needs it.

| Key | Checks |
| --- | --- |
| `entryJsKB` | brotli KB of `index.html`'s JS closure |
| `entryJsFiles` | files in that closure |
| `entryCssKB` | brotli KB of the stylesheets that closure loads |
| `officeRuntimeJsKB` | brotli KB of `office-runtime.html`'s JS closure |
| `routeJsKB` | per page in `src/routes/` (file name without `.tsx`): brotli KB its closure adds beyond the entry; `default` for the pages not named |
| `chunksUnder1KB` | JS chunks under 1 KB raw |
| `largestChunkKB` | the largest JS chunk, brotli KB |
| `never` | per target, module path prefixes its closure must not hold: `index.html` for the entry, or a module path (`src/routes/Dashboard.tsx`, `src/features/files/DocxView.tsx`) for the chunk holding it, beyond the entry |

The limits were set on 2026-10-18 from the build with the SPA load fixes,
plus a little headroom ([report](reports/2026-10-18-spa-fixes.md)).
