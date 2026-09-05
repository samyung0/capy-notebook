# Workspace summary page design
_Exported on 20/08/2026 at 22:31:41 GMT+8 from Cursor (3.16.17)_

---

**User**

i am thinking of a restructuring:
how to make a summary/description page for workspaces that is seo friendly? right now we jump directly into editing (workspace open), I want to make a page before that. use ISR if tanstack router supports it? Only expose endpoint that shows chapters and file names for link shared and public workspaces (for the summary page of workspaces). To retrieve file content/any other info, user must log in first (i.e. viewing/commenting/editing workspace which is on a different page than the summary must require user login to prevent abuse)
no existing data/server exist
just discuss, DO NOT implement yet

---

**Cursor**

I'll start from the product and routing docs, then look at how workspaces, sharing, and TanStack Router currently work so we can talk through an SEO-friendly summary page without implementing anything.

Next I’ll check sharing/auth rules, how workspace routes are wired, and whether the current deploy can actually do ISR or only SPA rendering.

The short version: **TanStack Router cannot do ISR.** A public summary page is the right product split, but it only helps SEO if the **first HTML response** already contains the outline — and that is a hosting/cache problem, not a router problem. The bigger change is authz: today a share URL is a full anonymous reader of files and materials.

## What you have today

The app is a **Vite SPA on Cloudflare Pages** with a **Go API**. `/share/workspaces/$workspaceId` is already “public” in the router, but it mounts the same `WorkspaceOpen` editor and prefetches workspace, chapters, files, and materials.

Anonymous access is not a thin outline. Auth middleware treats these as public **reads**:

- `/api/workspaces/`, `/api/files/`, `/api/materials/`, `/api/quizzes/`, `/api/decks/`, `/api/editor-assets/`, `/api/explore/`

`WorkspaceAccess` then allows any caller to read a `link` or `public` workspace. File download redirects to a **B2 presigned GET**. So a share URL is currently a CDN for the PDFs, not a landing page.

There is also no SEO surface at all: one `index.html` titled “Capy Notebook”, no sitemap/robots, UUID URLs, no workspace description, and Explore itself sits behind `AuthGate`.

That last point matters. Google cannot discover public workspaces through the app; it can only follow inbound `/share/workspaces/<uuid>` links, and even then it gets a JS editor shell.

## ISR and TanStack

**TanStack Router** is a client router. Loaders run in the browser after `index.html`. That is not ISR, SSG, or SSR.

**TanStack Start** (the full-stack layer on Router) can SSR, prerender, and cache server functions. It is the only way to get “ISR-ish” *inside* the TanStack stack. I would **not** adopt it for this:

- Plate/Yjs/Hocuspocus cannot usefully SSR. The editor stays a client island either way.
- Clerk + the current Pages/static + `api.abcd.com` topology is a real migration, not a flag.
- You only need HTML for a handful of public URLs, not the dashboard.

**Prerender at build** is useless here. Workspaces are user-generated and appear after deploy.

What people mean by ISR — serve a static snapshot, refresh in the background after a TTL — is **HTTP cache + revalidation**. On this stack that belongs in **Cloudflare in front of a public HTML URL**, not in the React router.

Practical equivalent:

1. Apex route like `/w/$slug` (and maybe keep `/share/workspaces/$id` as an unlisted alias).
2. Origin (Go, or a Pages Function that calls Go) returns **full HTML**: title, description, JSON-LD, chapter/file outline in the body, CTA.
3. Cloudflare Cache: `s-maxage=300, stale-while-revalidate=86400`.
4. **Purge** that URL when name, description, outline, or privacy changes. Privacy `public → private` without a purge is a leak.

The SPA can hydrate that page or just be a nice client for humans. Crawlers and Slack/iMessage unfurls never execute your bundle.

Do not put the outline only in a client `useQuery`. Google may eventually run JS; social crawlers will not, and you will ship a generic “Capy Notebook” card.

## Product split (this is the real design)

Treat **catalog** and **studio** as different products.

| Surface | Who | Auth | Indexed | What it shows |
|---|---|---|---|---|
| Summary `/w/$slug` | anyone with the URL | none | **only if `public`** | name, description, author, tags, chapter names, file/material **names** |
| Open `/workspaces/$id` | session | **required** | no | today’s editor, files, Yjs, chat |
| Link share `/s/$token` | anyone with the token | none for summary; login to open | **noindex** | same summary payload, not in sitemap |

Do **not** send owners through the summary from the dashboard. `WorkspaceCard` → `/workspaces/$id` stays. Summary is for Explore, pasted links, and crawlers.

Copying a share link should land on the **summary**, with “Open workspace” → Clerk → return to `/workspaces/$id`. That matches “page before editing” without punishing people who already live in the app.

**Link vs public is easy to get wrong.** If you ISR and sitemap both, unlisted links become search results. Same rule as YouTube unlisted:

- `public` → index, sitemap, Explore
- `link` → `noindex, nofollow`, cache OK (URL is the secret), never sitemap
- `private` → 404, even the summary

## Authz change (this inverts the current model)

Today: anonymous visitor of a shared workspace **can read files and materials**.

Proposed: anonymous visitor **cannot**. That is a breaking product change, not a new route. It kills “paste a link, classmate views the PDF with no account.” If that classroom flow matters, the login wall is the wrong trade. If abuse/bandwidth/scraping is the priority, it is the right one — say that explicitly in share-dialog copy (`share_link_hint` today implies the URL *is* access).

Concretely:

1. **New** unauthenticated `GET /api/public/workspaces/{idOrSlug}` (name it so it cannot be confused with the member GET). One round trip, nested outline, cacheable.
2. **Strip anonymous from `PublicReadPrefix`** for workspaces, files, materials, editor-assets, quizzes, decks — or keep prefixes but make every handler 401 when `userID == ""`. Prefix-only is how today’s hole exists.
3. Member `GET /api/workspaces/{id}`, `.../files`, `.../chapters`, blob download, collab tokens, chat: **session required**. `WorkspaceAccess` must stop treating empty user + `link/public` as a full reader.
4. Same hole exists on `/share/quizzes/$id` and `/share/decks/$id`. If you only lock workspaces, scrapers will use those.

Do **not** reuse `GET /api/workspaces/{id}` for the summary. That payload has `capabilities`, `shareRole`, `storageOwnerName`, `lastAccessedAt`. The public contract should be a different type so it cannot grow a `url` the way `File` already has.

Public body, roughly:

- `slug`, `name`, `description`, `author` (display name only), `tags`, `updatedAt`, `cloneCount`
- `chapters: [{ name, files: [{ name, kind }], materials: [{ name, type }] }]`
- **No** file ids, blob keys, presigned URLs, extracted `content`, member emails, chat, RAG text

Ids on a public JSON are not the leak if content routes require login; the leak is leftover anonymous `GET /api/files/{id}` still redirecting to B2. Close that first. Still omit ids anyway so the summary page cannot be turned into a scraper map.

**`rag_workspace_summaries` looks tempting for `<meta description>`. Do not use it.** It is derived from indexed file text, which is exactly what you are trying not to expose. Add an owner-written `workspaces.description` (and maybe an optional short `seo_title`). Thin pages of only filenames will not rank and can look like doorway pages.

Login is not enough against abuse. A free Clerk account still pulls presigned PDFs. You still want authenticated download rate limits (your existing IP limiter is the anonymous side). Bot detection is complementary, not a substitute for the API split.

## Schema (you can, since there is no live data)

Worth adding now, while you can squash `0001_init.sql`:

- `description text` (cap it; this is the SEO paragraph)
- `slug text not null unique` among **public** rows, or globally unique and stable when visibility flips
- `published_at` / `updated_at` for sitemap `lastmod` — do not use `last_accessed_at` (that is a private activity signal)

UUID URLs will not rank. Prefer `/w/organic-chemistry-101` over `/share/workspaces/018f…`.

Slug policy that avoids later pain:

- Generate from name on first publish to `public`; owner can edit
- **Do not** change the slug silently on rename (broken inbound links)
- On `public → private` or `public → link`, keep the row but 404 the public URL and purge cache; do not free the slug immediately (squatting / resurrection)
- Link-share should keep an unguessable id/token, not a pretty slug

Optional: `/u/{handle}/{slug}` if you care about author identity in SERPs. More collision machinery. A global `/w/{slug}` is enough to start.

Include **material titles** in the outline, not only files. “Chapter 2 · Lecture 5.pdf” is weak; “Chapter 2 · Midterm notes, Quiz 3” is the actual catalog. Still names only.

i18n: paraglide is client-side. For SEO pick one canonical language (probably English) plus `hreflang` if you later add translated descriptions. Do not ISR two thin copies of the same outline.

## Frontend routing

Keep TanStack Router. Add a **root-level** route (sibling of today’s `publicRoutes`, **not** under `AuthGate`):

- `/w/$slug` — summary
- `/share/workspaces/$workspaceId` — either 301 to `/w/$slug` when public, or the `noindex` summary for link shares

`/workspaces/$workspaceId` stays inside the auth shell and is the editor. `beforeLoad`: no session → redirect to sign-in with `redirect_url` back to the editor (or to the summary if you want a second hop; one hop is better).

That also fixes the layout-shift issue in `.todo` item 13 a bit: the summary can use a public chrome (header + CTA), and the editor can keep the no-sidenav studio layout. Two pages, two shells, instead of one component trying to be both marketing and IDE.

Explore cards should go to `/w/$slug`, not straight into the editor. Clone stays on the summary and already requires a session.

## What I would actually do (when you implement)

1. **API/authz first.** Dedicated public summary endpoint; anonymous content reads go to 401; e2e sharing tests rewritten around “summary without login, editor with login.”
2. **Slug + description** in the workspace table while you can still squash.
3. **Go HTML** for `GET /w/{slug}` on the apex (same origin rule pattern you already use for `/api`), with `Cache-Control` and purge on mutate. Pages Function is fine too; I would not introduce Start.
4. **Sitemap** only for `privacy=public`, plus `robots.txt`. Public Explore without Clerk if you want Google to find more than inbound links.
5. Then the React summary page for humans.

Skip Start, skip build-time prerender, skip putting RAG summaries in meta tags, skip indexing link shares.

The one decision you should lock before any of that: **is a share link still “the URL is the capability,” or is it a teaser that always demands an account?** Those are different products. SEO wants the teaser to be a real paragraph plus a stable pretty URL; anti-abuse wants the login wall. You can have both only for `public`, and only if the teaser is not the file bytes.

---

**User**

https://tanstack.com/start/latest/docs/framework/react/guide/isr  i linked the doc to the isr page, is something like workspace/summary -> static isr page, rest -> react spa possible? and yes workspaces are user generated and appear after deploy, but isnt isr logic to fetch some data and dynamically generate static html? can it fetch workspace data from db and dynamically generate the static workspace summaries page? (whether its a good idea or not I am not sure, given there could be thousands of workspace summaries pages)( do these static files live inside of the github repository and served by cdn?) 

---

**Cursor**

Good question, and my earlier framing of Start's ISR was too narrow — let me check the build setup so I can be accurate about what a migration would actually cost.

You're right and I was wrong on one point worth correcting: ISR in Start does generate pages on demand, so user-generated workspaces are not a problem. Build-time prerender is the optional half of that doc, not the mechanism.

## How it actually generates

Start is an SSR framework first. A route you never prerendered still gets server-rendered on request. The `headers()` Cache-Control in that doc then tells the CDN to keep the resulting HTML. So the lifecycle for `/w/organic-chem-101` is: first visitor hits a cache miss, the origin runs your loader against Postgres and renders real HTML, Cloudflare stores it under that URL, everyone after that gets the stored copy, and after `s-maxage` the next request re-renders. That is the "dynamically generate static HTML" you described. The `prerender.routes` config only matters for URLs you know at build time, which for you is the marketing pages, never workspaces.

The doc's own on-demand revalidation section is the other half you'd need, since a rename or a privacy change has to purge that URL rather than wait out the TTL.

## Where the HTML lives

Three separate places, and none of them is your repo:

| Thing | Lives in | Lifetime |
|---|---|---|
| Source | git | forever |
| Build-time prerendered HTML | `dist/` build output, gitignored, uploaded to the host | until next deploy |
| ISR-generated HTML | Cloudflare's edge cache, keyed by URL | until TTL, purge, or eviction |

Nothing is ever committed, and ISR pages aren't files at all — they're cache entries, per-datacenter, and Cloudflare can evict them whenever it wants. A page cached in Singapore isn't cached in Frankfurt; that colo just re-renders.

So thousands of workspaces costs you nothing in storage, because you only pay to render URLs someone actually requests. Cold workspaces nobody visits are never generated. The model you were worried about — every workspace becoming a file that has to exist somewhere — is the Hugo/Gatsby model where publishing a workspace requires a site rebuild. That's the genuine antipattern, and ISR exists to avoid exactly it.

The costs that are real: each cold miss is one SSR render plus your Postgres query, so the summary must be a single nested query; you need targeted purges on every mutation that changes the page; sitemaps cap at 50k URLs per file so you'd eventually need a sitemap index; and thousands of near-identical thin outline pages is a search-quality risk. That last one is the reason to be cautious, not infrastructure.

## Is the hybrid possible

Yes. Start supports selective SSR with an `ssr` option per route, so `/w/$slug` server-renders while the app routes ship as client-only shells. Architecturally it's exactly what you described.

The cost isn't the routing, it's that adopting Start touches most of your frontend infrastructure:

- You'd have a server at the apex instead of a static Pages upload, which collides with the runbook's Cloudflare rule that rewrites apex `/api/*` to `api.abcd.com`. Something has to arbitrate routing at the apex now.
- Start is built around `createFileRoute`. Your `router.tsx` is code-based `createRoute` with a hand-rolled `page()` helper and prefetch loaders — that route tree gets rewritten. Arguably you want that anyway given `.todo` item 13, but it's not a small diff.
- `@clerk/react` is client-side, so authed routes need `ssr: false` or Clerk's server helpers.
- Plate, Yjs, Excalidraw, react-pdf, and mermaid all have to stay client-only islands.
- Your MSW setup assumes the browser's service worker intercepts `/api`; SSR fetches happen server-side and bypass it entirely, so dev and E2E need rethinking.
- paraglide's strategy is `['localStorage', 'preferredLanguage', 'baseLocale']`. `localStorage` doesn't exist on the server, so SSR'd HTML renders base locale and flips on hydration. The public page needs a cookie or URL locale strategy.

That's a substantial migration to serve one public page.

## The cheaper route to identical SEO

The summary page is a content page, not an app page. It needs a title, description, author, tags, the chapter outline with file and material names, a CTA, and JSON-LD. It needs no Plate, no Yjs, no react-query, no Clerk. Rendering it with Go `html/template` off the same query that feeds the public JSON endpoint gets you byte-identical SEO value, and the Cloudflare Cache Rule plus purge-on-mutate gives you the same ISR semantics. Your SPA doesn't change at all.

If you go that way, don't also build a React version of the same page — make the Go page the only summary renderer and have Explore and share links do a full navigation to it. A hard navigation to a landing page is correct behavior anyway.

## Pitfalls that apply to either path

The one that will bite you hardest: **cached public HTML must be identical for every visitor.** No server-side reading of the Clerk cookie, no "welcome back". The moment you `Vary: Cookie` you have no cache. Personalize after hydration.

Also worth knowing before you design around the doc's examples: Cloudflare does not cache HTML by default for a proxied origin, so this needs an explicit Cache Rule marking the response eligible with Edge TTL from origin headers — a manual step that belongs in `deployment-runbook.md` alongside the existing origin rules. And verify Cloudflare honors `stale-while-revalidate` on your plan rather than assuming it; if it doesn't, TTL expiry is a genuine cold miss, which is fine at your traffic but changes the latency story.

Then the security one: with a long `stale-while-revalidate`, flipping a workspace from public to private leaves its outline being served for up to a day. Privacy changes must purge, never expire. Same for rename, description edits, outline changes, and deletion.

My recommendation is to skip the Start migration for now: ship the public JSON endpoint, the Go-rendered HTML, the Cache Rule, and purge-on-mutate. Revisit Start when you actually want SSR for a broader public surface — landing, pricing, a blog, public Explore — because at that point the migration pays for more than one route.

> **Which direction do you want to explore further before any implementation?**
> - Go-rendered summary HTML + Cloudflare cache rule, SPA untouched (Recommended)
> - Migrate frontend to TanStack Start and use real per-route ISR
> - Cloudflare Worker/Pages Function that fetches public JSON and templates HTML at the edge
> - Park the rendering question; design the public-vs-authed API split first

---

**User**

i have some questions on "each cold miss is one ssr render", but the doc says "Static Prerendering: Pages are generated at build time", and cache is refetced on invalidation (but page will still serve with stale date while new pages gets rendered and compiled right?) there will always be a static html file at all time to serve.
and pitfall of no user-customized data: yes, either I resort to client side data fetching or use next js partial prerendering (serve static html file, while cdn triggers serverless function to fetch for user data, then streams the data back to fill the "gaps")
no need to implement

---

**Cursor**

Your model is right for Next.js on Vercel and wrong for the approach in that doc — and the difference is exactly what "unlike framework-specific ISR implementations" is warning you about.

## Why there isn't always a file

`prerender.routes` can only generate pages whose URLs are enumerable at build time. That's why the doc's example is `['/blog', '/blog/posts/*']` with `crawlLinks: true` — a crawler can walk your blog index and find every post. Nothing at build time can enumerate a workspace that a user creates next Tuesday, so for `/w/$slug` step 1 of that list simply doesn't happen. There is no artifact.

And `stale-while-revalidate` can only serve stale content if something stale exists. It's a revalidation policy on an existing cache entry, not a guarantee of one. First-ever request for a slug has nothing to fall back on, so that visitor waits for the render.

Two more holes in "always a file", both specific to a plain CDN cache:

Cloudflare's cache is per-location. A workspace hot in Singapore is cold in Frankfurt, and each POP renders its own first copy. Tiered Cache narrows this by giving you an upper tier that absorbs misses, but it doesn't eliminate them.

And the edge cache is LRU, not storage. An unpopular page gets evicted, and then the next visitor is a cold miss again even though it was generated last week. Cache Reserve exists to push back on this, but the default assumption has to be "this can vanish".

## "Render" is not "build"

Worth untangling, because I think "one SSR render" read as "one site build". Nothing compiles at request time. Your server bundle was compiled once at deploy; a cold miss just executes it — run the loader, one Postgres query, render React to an HTML string, respond. Tens of milliseconds. That's why thousands of workspaces are fine and why I'm not treating cold misses as a problem, only as something that exists.

## Where your intuition does hold

Next.js on Vercel keeps a durable, shared ISR cache. After the first generation there genuinely is a persistent artifact, shared across regions, that survives until you revalidate it. Your description is an accurate description of that system.

The doc you linked deliberately doesn't build that. It uses nothing but `Cache-Control` so it works on any CDN, and the price is that the "store" is whatever ephemeral cache your CDN happens to have.

If you want the guarantee, you build the store yourself, and on your infra that's cleaner than it sounds: render the summary HTML and write it to R2 (or KV) keyed by slug, then serve it from there. Now there is always an object, no cold misses, no per-POP duplication, and a privacy flip is a delete rather than a race against a purge.

The interesting question then becomes when you render. Generating on write means every rename, chapter add, file upload, and material creation has to re-render, which is a lot of fan-out during active editing. Generating lazily on read with a dirty flag is the same ISR shape but backed by durable storage you control. Your schema already uses precisely that idiom — `rag_workspace_summaries` carries a `dirty boolean` and gets recomputed out of band — and you already have a jobs table with leasing and requeue, so a "summary HTML is stale, re-render it" job is a pattern the codebase already knows how to express.

## On partial prerendering

Your instinct about the mechanism is correct, and PPR is a real answer to the personalization problem in general. Two things make it the wrong tool here.

It's Next-specific, so choosing it means migrating to Next.js, not to Start. Start's nearest equivalent is streaming SSR with Suspense boundaries and deferred loader data — and streaming actively fights you here, because if the shell and the personalized holes come out of one response, the CDN can't cache just the shell. Vercel's PPR works because the platform splits the static shell from the dynamic holes below the framework, at the infrastructure layer. You'd be rebuilding that.

More to the point: look at what's actually personalized on a workspace summary. The avatar in the header, and whether the button reads "Open workspace" or "Sign in to open". Possibly a "you've already cloned this" badge. None of it is content, none of it is indexed, and no crawler cares. Fetching it client-side after hydration costs you nothing that matters, because the outline and description — the entire SEO payload — are already in the cached HTML.

The one real cost of the client-side approach is layout shift when the avatar and CTA resolve, and the fix for that is reserving the space, not adopting a rendering architecture. That's a much better trade than standing up PPR to avoid a 40px hole popping in.

---

**User**

I am thinking of two things: when user create or publish (change visibility) of the workspace or edit the workspace (mark as dirty, insert job that run later, only one per workspace ), directly compile the html file on the server with latest data -> new etag(?) cloudflare will refetch and recache the new html file -> good seo and use ssg rather than ssr
OR just build the r2/kv cache and rely on ssr for the page content?

---

**Cursor**

Let me verify what your jobs table can already express, since "one job per workspace" is load-bearing for your design A.

Your dedup idea is already a proven pattern in this schema — `summaries_rollup` does exactly it:

```817:819:server/migrations/0001_init.sql
CREATE UNIQUE INDEX IF NOT EXISTS jobs_pending_rollup_idx
  ON jobs ((payload->>'workspaceId'))
  WHERE type = 'summaries_rollup' AND status = 'pending';
```

So "mark dirty, one pending job per workspace, coalesce the edits" is house style, not a new mechanism. But there's one broken assumption in design A worth fixing before you go further.

## ETags don't invalidate anything

A new ETag will not make Cloudflare refetch. Nothing you do at the origin pushes a signal to a CDN. The edge keeps serving its cached copy until the TTL expires or you explicitly call the purge API. When the edge does eventually revalidate, the ETag lets you answer `304` and save bandwidth — that's its whole job. It's a response to a check, never a trigger for one.

So design A isn't "render → new ETag → Cloudflare recaches". It's "render → store → **purge that URL**", and the purge is mandatory. That matters because purge is now load-bearing: it's eventually consistent across colos, and purge-by-URL has per-plan rate limits worth checking before a bulk operation (say, an owner renaming themselves) tries to purge fifty URLs at once.

The other framing to drop is SSG versus SSR. Both of your designs execute the same render function against the same data; the only difference is what triggers it and when. Google receives identical bytes either way, so SEO can't be the tiebreaker. Pick on staleness safety and write fan-out instead.

## They're two axes, not two options

You've described two diagonal corners of a 2×2. One axis is *when* you render (on write, or on read at a cache miss). The other is *where* the bytes live (only the ephemeral edge cache, or a durable store with the CDN in front). Your A is write-time plus edge-only; your B is read-time plus durable. The other two combinations are legal, and one of them is better than either.

I'd take **render on write, store in R2, CDN in front** — and the reason is a safety argument you may not have priced in.

With edge-only caching you're forced into long TTLs, because every expiry costs a Postgres query and a React render. Long TTLs are exactly what makes a failed purge dangerous: flip a workspace to private, miss the purge, and the outline stays public for hours. Once there's a durable object, a cache miss costs one R2 read, so a 60-second TTL is essentially free. Now a missed purge is a one-minute exposure instead of a one-day exposure, and deleting the R2 object is itself a hard kill switch that doesn't depend on the purge succeeding. Durable storage buys correctness margin, not speed.

## What actually dirties the page

Worth enumerating before you commit, because it's larger than "edit the workspace":

Workspace name, description, tags, colour, privacy, and `share_role`. Chapter create, rename, reorder, delete. File upload, rename, move, delete. Material create, rename, delete, reorder. Two of these are sneakier than the rest. The owner's display name lives on `users`, so a single profile rename dirties *every* public workspace that person owns — that's your purge-rate-limit scenario. And `clone_count` changes from strangers' actions, so if you render it into the HTML you'll re-render on other people's clicks; either leave it out or fetch it client-side alongside the avatar.

Gate all of it on `privacy != 'private'`, and make the transition *to* private a delete rather than a re-render.

## Two refinements

Publishing should render synchronously. A user who hits "make public" and immediately pastes the link into a group chat should not race your worker. That transition is rare and user-initiated, so a few hundred milliseconds inline is fine; the debounced job is for the frequent content edits, which is where coalescing actually pays.

And build one renderer called from both paths — the job on write, and the miss path on read. Then a missing object (job backlog, a bug, a workspace published before you shipped this) renders on demand and stores itself, instead of serving a crawler a 404 for a valid public workspace. That makes the dirty flag an optimization rather than a correctness requirement, which is a much more forgiving system to operate.

## One sub-decision to think about

Storing rendered HTML is simplest, but it couples every object to the template version that produced it. A CSS or markup change means a backfill across all of them, so you'd want a template version stamp and "bump version = mark all dirty".

Storing the summary *JSON* and templating in a Worker avoids that entirely — template changes take effect on deploy — and the same payload feeds og:image generation and any in-app view later. The cost is JS at the edge and a slightly more involved deploy story.

If you go that way, prefer R2 over KV for anything the privacy decision depends on. KV propagation is eventually consistent on the order of a minute, and "the object says public for another 60 seconds after you made it private" is precisely the window you were trying to close.

