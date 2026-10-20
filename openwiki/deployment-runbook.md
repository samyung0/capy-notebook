# Deployment Runbook — manual actions

Everything that cannot be done from this repository. Each step says what breaks
if it is skipped, because several of them fail silently.

Order matters: DNS before Cloudflare rules, Cloudflare before origin lockdown,
origin lockdown before trusting `CF-Connecting-IP`.

Code-side configuration lives in `observability-metering.md` §9.

---

## 0. Release flow and branch policy

Use one protected, long-lived `main` branch. Do not create permanent `uat` and
`prod` branches. Environment branches look simple at first, but they turn
promotion into merging, allow fixes to land in one environment but not the
other, and make it harder to identify the code actually running. Release
branches are justified only when maintaining multiple supported versions; they
are not deployment environments.

This repository defines deployment as follows:

1. **Stage UAT:** push to `main` and let `CI` succeed, then manually dispatch
   **Deploy UAT** from `main` with a full SHA (blank takes the selected main
   revision). It deploys that SHA to the isolated UAT Coolify and Cloudflare
   Worker resources and calls the reusable **Deterministic UAT quality**
   workflow, which on a deploy only probes that the services answer. Nothing
   stages UAT on push.
2. **Push to production:** manually dispatch **Promote revision to production**
   from `main` with a full 40-character SHA. The workflow re-deploys that SHA
   to UAT and re-runs the deterministic UAT gate and the editor perf budgets;
   all must pass. Only then does it reach the protected `production` GitHub
   environment. Approving that environment is the release action.
3. **Code review and agent scans:** `$review-repository`, the Codex Security
   source scan, and the Strix UAT scan run only on a developer machine when a
   person starts them. Their commit statuses are evidence for the releaser;
   no workflow reads them. See `review-automation.md`.

Configure `main` branch protection to require `CI`. Configure the `uat`
environment without a reviewer so post-CI deployment can run unattended.
Configure `production` to allow only `main` and require a reviewer if the
repository's GitHub plan supports it. A solo maintainer must leave “prevent
self-review” off; otherwise nobody can approve. Manual workflow dispatch is the
fallback approval on plans that do not offer required reviewers for a private
repository.

The current deployment adapter pins the same source SHA in UAT and production
and verifies that SHA at the public SPA and gateway. Coolify still builds the
Compose images separately for each environment, and the SPA is rebuilt with
environment-specific public configuration. This is reproducible source
promotion, not yet byte-identical artifact promotion. The mature follow-up is
to publish content-addressed backend images once and make both environments
pull the same digests; do that when the deployment exists and registry access
can be tested.

The gateway (`server`) and the collaboration service always deploy together
from one revision, as the Compose stack does (collaboration waits for a healthy
`server`). Do not roll back or pin one without the other: their internal
routes change in step. A collaboration service ahead of its gateway can, for
example, misread the gateway's `epoch-reset` answer and keep a discarded room
refused until the gateway catches up.

Where the two must be split (a manual rollout, a partial rollback), the
gateway goes first or with the collaboration service, never after it. A text
checkpoint now carries `preview` (2026-10-13, `thumbnails.md`): a gateway
older than that refuses the field with a 422 (`SourceCheckpoint` allows no
other properties), the collaboration service reads a 422 as a permanent
refusal, and every open text room resets and sends its editors to recovery
until the gateway is updated. The other order is safe: an older
collaboration service sends no `preview`, which a newer gateway does not
require.

**Client protocol bumps** (Epo 2026-10-16; when to bump:
[plate-editor "When to bump"](frontend/plate-editor.md#when-to-bump)). A
deploy that raises `CLIENT_PROTOCOL` and a family's minimum starts refusing
that family's open editors (`collaboration-outdated`) the moment the new
collaboration server starts, while the new SPA is only served once the site
job finishes, about 2 to 3 minutes later. In that window a refused editor's
Reload says the update is still being published; its edits stay on the
device. So:

- the deploy request names the bump ("client protocol: material 3 → 4"), so
  the deployer knows that family's stale editors pause for those minutes;
- a site job that fails after a bumping backend deploy leaves that family's
  stale editors blocked until it succeeds: re-run it promptly (its build
  artifact lives one day);
- a rollback to an older SHA lowers the server's own protocol: newer tabs are
  refused as above it and reload into the older SPA once it is served.

The SPA build writes its revision to `dist/release.txt`, served `no-store`
(`public/_headers`). An open tab reads it when it regains focus, at most
once a minute, and a tab whose build differs loads the new SPA at its next
page change ([plate-editor "Client protocol and the release
nudge"](frontend/plate-editor.md#client-protocol-and-the-release-nudge)).
Nothing in the deploy passes it: it ships with the assets, so a tab sees the
new release once the site job has published them.

---

## 1. DNS & hostnames

One Cloudflare Worker serves the static SPA and live `/w/{workspaceId}` summaries. The Go gateway, the Rust collaboration server, the Python
retrieval service, the ingest worker, and the operator dashboard are separate
processes. The table gives intended production hostnames; production services
still need provisioning. Cloudflare Access protects the
operator hostname before traffic reaches its origin.

| Hostname           | Serves                                             | Public DNS | Proxied              |
| ------------------ | -------------------------------------------------- | ---------- | -------------------- |
| `app.capynotebook.com`     | SPA and workspace SSR (Cloudflare Worker)                    | yes        | yes                  |
| `office.capynotebook.com`  | isolated Office file runtime                       | yes        | yes                  |
| `capynotebook.com`         | future separate static public site                | yes        | yes                  |
| `www.capynotebook.com`     | future redirect to apex                                   | yes        | yes                  |
| `api.capynotebook.com`     | Go gateway (`server`, :8080)                       | yes        | yes                  |
| `collab.capynotebook.com`  | capy-sync WebSocket (`collaboration`, :1234)       | yes        | yes                  |
| `ops.capynotebook.com` | Go ops API + static dashboard (`ops`, :8082)       | yes        | yes, Access required |
| retrieval :8001    | Python chat/generate                               | **no**     | —                    |
| ingest host        | parser + ingest worker + embed                     | **no**     | —                    |
| Postgres / Redis   | —                                                  | **no**     | —                    |

The browser talks to the gateway at same-origin `/api` (`src/api/client.ts`
hard-codes `API_BASE = '/api'`; `VITE_API_URL` is only the Vite **dev** proxy).
So the site hostname must route `/api/*` to the Go process, **and**
`api.capynotebook.com` must still exist as its own hostname for Clerk/Stripe webhooks
(`POST /webhooks/clerk`, `POST /webhooks/stripe`). Retrieval is reached only
from the gateway over the docker network (`PIPELINE_URL=http://retrieval:8001`).

If the domain is **already** on Cloudflare, skip nameserver migration.

1. **Site.** Deploy `wrangler.jsonc` with `--env uat` or `--env production`.
   Every wrangler file sets `workers_dev: false` and `preview_urls: false` at
   its top level and in each environment, so even a deploy without `--env`
   publishes no `workers.dev` or preview URL (developer decision 14b).
   The Worker serves `dist/`, renders `/w/{workspaceId}` from the live Go summary
   endpoint. The UAT zone routes `/api/*` directly through the tunnel as described
   in §1.0.1; production must provision the same tunnel and scriptless route
   before its first deployment. `APP_ORIGIN`
   is the canonical browser origin. CI supplies both from the GitHub deployment
   URLs. `SHARE_LINK_SECRET` (manifest secret, targets `coolify` and `workflow`,
   at least 32 characters, `openssl rand -hex 32`) signs `/w/` links in Go and
   verifies them in the Worker; CI passes the same GitHub secret to Coolify and
   to `wrangler deploy --secrets-file`, and `wrangler.jsonc` lists it under
   `secrets.required`. Changing it invalidates every shared link, including
   quiz and flashcard links, and resets the anonymous grading IP hashes.
   `JEV_TYPESAFE_API_KEY` (manifest secret, target `coolify`) is the typesafe.ai
   key that grades open quiz parts; without it grading answers 503. Both app environments use exact Worker Routes in `wrangler.jsonc`,
   with DNS pointing at their tunnel. Do not attach either app as a Worker
   Custom Domain; that would replace the tunnel destination. The apex and
   `www` remain reserved for the future public site, whose implementation is
   deferred. Help and credits stay in the app until public pages exist.
   Coolify serves the backend, not the site. Rendered summaries are
   `public, s-maxage=300, max-age=0, must-revalidate`, and so are the
   `/share/*` pages and `/p/*` images. Workers Cache (`cache.enabled` in
   `wrangler.jsonc`) holds them for five minutes in front of the Worker,
   keyed by path, query string and Worker version (each deploy starts cold),
   never by cookies or headers, so a render must not read the request; hits
   carry `CF-Cache-Status: HIT` and `Age`. Zone cache rules do not apply to it.
   Its two tiers are built in (a lower tier in the visitor's data center, an
   upper tier every lower tier asks on a miss), so the zone's Tiered Cache
   topology does not govern it; the host is not part of the key, so both UAT
   app hosts share entries; a hit is served before the Worker's placement
   region applies. With Workers Cache on, every request to the Worker is
   billed at the Workers request rate, its static files included, while hits
   and static files use no CPU time (Cloudflare's Workers Cache pricing).
   A query string makes its own entry, so each new one renders once. Failure
   pages stay `no-store`, and link summaries are `noindex, nofollow`. The
   `/p/*` routes serve signed-out shared quizzes', flashcards' and notes'
   images under the same signature check. The Worker inlines only the CSS
   rules a page's HTML uses (`workers/site/usedCss.ts`) and preloads the full
   stylesheets, which the page applies before it hydrates. Anonymous grading skips
   the Worker and posts to `/api/public/quizzes/{token}/grade` directly, since
   Worker subrequests reach the API without the visitor's IP. There is no
   KV/R2 cache. Only the `run_worker_first` paths reach the Worker; every other
   request, SPA fallbacks included, is served by the asset layer without an
   invocation. `public/_headers` marks the avatar/workspace `/icons/*`
   `max-age=31536000, immutable` (stable artwork, kept names) and
   `/release.txt` `no-store` (open tabs compare it with their own release, so
   no cache may answer it, and as a real file it never gets the SPA
   fallback) and the content-hashed `/assets/*` bundles
   `max-age=31536000, immutable` (Vite renames a changed file and never
   reuses a name); everything else keeps the Workers Assets default of
   `public, max-age=0, must-revalidate` with an `ETag`. Every app host's
   `/assets/*` is the route of a separate assets Worker
   (`wrangler.assets.jsonc`; the route is more specific than the app Worker's
   `/*`, so it wins). Its static files are the build's `dist/assets` with
   `dist/_headers`, and its script (`workers/site/assets.ts`) runs only when
   no file matches: an empty 404 with `no-store`. The SPA fallback therefore
   never answers a chunk's URL, which it did during deploys while the app
   Worker served `/assets/*`, and which a year-long header would have pinned.
   The deploy stages `dist/assets` and `dist/_headers` and publishes this
   Worker right before the app Worker, so a new `index.html` never names a
   chunk the edge cannot serve. In the minute between the two, a fresh load
   gets the old `index.html`, whose entry chunk 404s: `index.html`'s own boot
   script then replaces the loading spinner with the reload message
   ([error-handling](frontend/error-handling.md#boundary-tiers)), and an open
   tab that lazy-loads an old chunk shows the app's. A reload once the app
   Worker is live loads the new release. The deploy checks the app Worker's
   secrets before publishing either Worker, and when the app Worker step
   fails after the assets Worker went live, it rolls the assets Worker back
   to its previous deployment (`wrangler rollback --config
   wrangler.assets.jsonc --env <env>`): the old `index.html`, still served,
   names chunks only that deployment has. It first reads the app host's
   `/release.txt` up to 3 times over about 30 s
   (`scripts/deploy/assets-rollback-check.sh`; a failed request, an error
   status or a body that is no revision is no read) and rolls back only when
   a read succeeded and every successful read shows the old revision. When a
   read shows the new revision (the app Worker step failed after its new
   version went live, in a later part such as its routes), the new
   `index.html` needs the new assets, and when no read succeeds the step
   cannot tell: either way it leaves both Workers and fails for the manual
   rollback. An assets Worker step that
   fails after its version went live gets no automatic action either (Epo
   2026-10-17). Roll back by hand the same way,
   both Workers back to back (`capy-notebook-<env>` and
   `capy-notebook-assets-<env>`, in the dashboard or with `wrangler
   rollback`), never one alone; redeploying a previous SHA moves both.
   `scripts/deploy/verify-release.sh` checks the
   404 `no-store` after every deploy. The assets Worker has no Workers Cache
   block, so its static hits stay free requests. The app Worker keeps
   `dist/assets` as well: share pages read their stylesheets through its
   `ASSETS` binding. The first deploy creates the routes with the same token
   and zone permissions the app Worker's routes use. On that first deploy
   the assets Worker has no earlier version, so the automatic rollback fails
   ("Could not find stable Worker Version to rollback to"): if the app Worker
   step failed there, rerun the site job, or remove the assets Worker's
   routes so the app Worker, still on the old release, serves `/assets/*`
   again.
   The Office viewer/editor needs its own cookie-less hostname in production,
   such as `office.capynotebook.com`. Serve only the built
   `office-runtime.html` and its `/assets/*` there (404 other routes), set
   `VITE_OFFICE_RUNTIME_ORIGIN=https://office.capynotebook.com` when building the SPA,
   and set `OFFICE_ALLOWED_PARENT_ORIGINS` to the exact comma-separated HTTPS
   parent origins in GitHub. `workers/office` stages the runtime HTML and assets
   from the same build as the SPA, replaces inherited headers, and publishes
   before the SPA. UAT uses `uat-office.capynotebook.com` and allows
   `https://app.uat.capynotebook.com,https://uat.capynotebook.com,https://local.uat.capynotebook.com`
   during the hostname transition. Remove the old app parent only after §1.0.2.
   Production uses the `office.capynotebook.com` custom domain configured in
   `wrangler.office.jsonc` and permits only `https://app.capynotebook.com`. The Worker
   handles runtime HTML with `no-store`, supplies the matching `frame-ancestors`
   policy, allows embedded blob fonts, and rejects other routes. Existing
   `/assets/*` bundles bypass the Worker and use
   `public, max-age=31536000, immutable`; staging copies the dedicated
   `workers/office/_headers` policy, including `nosniff`, `no-referrer`, noindex,
   and a CSP that prevents framing asset URLs. The exceptions are the WASM
   modules and the uncompressed fonts (`.wasm`, `.ttf`, `.otf`): staging
   (`workers/office/stage.mjs`) compresses each once with brotli at quality
   11 into `<name>.br` and removes the original, and `run_worker_first`
   sends `/assets/*.wasm`, `*.ttf` and `*.otf` to the Worker, which serves
   the `.br` file whole with `Content-Encoding: br` (`encodeBody: "manual"`,
   so the runtime does not compress it again), its real type
   (`application/wasm`, `font/ttf`, `font/otf`), the same year-long immutable
   caching and the Worker's security headers. It reads the `.br` file by GET
   with no validators or range whatever the request asks, so a conditional
   or HEAD request on a cache miss still gets the full `200` (the runtime
   drops a HEAD's body; Workers Cache converts a HEAD on a cold cache to a
   GET and stores the full file, per Cloudflare's Workers Cache "Cache keys"
   and "Limitations" pages),
   never a `304` or an empty body that the cache could keep for a year; the
   cache answers conditional requests from its stored copy. The static layer would
   recompress them on the fly at about quality 4: quality 11 is 20-25%
   smaller for WASM and 12-18% for fonts (the CJK faces 16-18%; a 2026-09
   build's 55 files: 19.0 MB → 15.1 MB), and costs about a minute of the
   deploy's site job.
   WOFF/WOFF2 are compressed inside and stay static files. A client that
   does not accept brotli gets the bytes decoded by Cloudflare's edge, which
   on a Workers Cache hit decodes the stored copy without running the Worker
   (Cloudflare's Workers `fetch` documentation; local workerd answers an
   `Accept-Encoding: identity` request with the plain WASM; the UAT checklist
   checks it on a hit). Only these
   requests and the runtime HTML run the Worker, and Workers Cache
   (`cache.enabled` in `wrangler.office.jsonc`, every environment) keeps the
   brotli files for a year in its tiers, so a hit skips the Worker
   (`CF-Cache-Status: HIT`) and each deploy fills it once per file (its key
   includes the Worker version); the runtime HTML and every refusal are
   `no-store` and bypass it. With it on, every Office-host request, the
   static scripts included, is billed at the Workers request rate, with no
   CPU time for hits and static files. Missing assets still
   reach the Worker's rejection checks, and a missing `.br` file is a 404
   `no-store`; the static layer rejects unsupported methods on existing
   assets with 405. Do not proxy `/api`, issue authentication cookies, or set
   parent-domain cookies on this hostname. The Office host transfers protected
   bytes by exact-origin `postMessage`; it does not need CORS access to the API.
2. **API + collab.** Pick one of §1.1 Coolify (typical), §1.2 bare compose, or
   §1.3 public A records. Retrieval, worker, Postgres, and Redis stay off
   public DNS in every option.
   The collaboration Docker build reads Binaryen's version and archive checksum
   from the pinned BetterOffice checkout's `.github/actions/wasm-toolchain/action.yml`,
   also used by frontend CI. Update the BetterOffice commit pin to update that
   optimizer configuration. The current checksum covers Linux x86_64; on ARM
   hosts, use `DOCKER_DEFAULT_PLATFORM=linux/amd64` for Compose or
   `docker build --platform=linux/amd64`.
3. **Same-origin API.** Deployed app hosts bypass the Worker for `/api/*`
   using §1.0.1. The retained fallback forwards `/api/*` only to its explicit
   `API_ORIGIN` and streams request/response bodies. It passes Go's file redirects
   back to the browser without following them with credentials. `/webhooks/*`
   stays on the API hostname. Do not attach the cookie-less Office hostname to
   this Worker; it must expose only Office assets as described above.

4. **Always Use HTTPS** and **HSTS** (start with a short max-age). SSL/TLS mode
   depends on how the origin is reached — see the option you picked.

> **Both the SPA and the API must be proxied.** Proxying only the SPA leaves
> `api.capynotebook.com` publicly resolvable, which is where the rate limiting, the WAF,
> and the origin's anonymity actually matter.

### 1.0.1 UAT API routing without Workers

The browser uses `https://app.uat.capynotebook.com/api/*`; the edge sends these
requests directly to `capy-uat`, then Traefik and Go. Static assets and workspace
summary renders keep using the existing `capy-notebook-uat` deployment.

| Setting | UAT value |
| --- | --- |
| Proxied `app.uat` CNAME | `3abcfdb8-68f3-4b11-b475-7b0379a1affe.cfargotunnel.com` |
| Worker Route | `app.uat.capynotebook.com/*` → `capy-notebook-uat` |
| More-specific zone route | `app.uat.capynotebook.com/api/*` → **None**, no script |
| More-specific Worker Route | `app.uat.capynotebook.com/assets/*` → `capy-notebook-assets-uat` (from `wrangler.assets.jsonc`; the old host has the same) |
| Tunnel ingress | Host `app.uat.capynotebook.com`, path `^/api/`, service `http://localhost:80` |
| Ingress HTTP Host Header | `uat-api.capynotebook.com` |

The ingress uses `originRequest.httpHostHeader` so Traefik selects the existing
API service. Keep this ingress before the tunnel's final `http_status:404`
entry and preserve every other ingress. There is no new Coolify domain or
public VM port. Keep `uat-api.capynotebook.com` for local Vite, server-rendered
summary fetches, and Clerk/Stripe webhooks.

The scriptless zone route is managed in Cloudflare's **Workers Routes**, outside
Wrangler: Wrangler's `routes` list assigns every entry to its Worker and cannot
declare a no-script exclusion. Its deploy updates routes belonging to the site
Worker and leaves the scriptless route in place. Keep `/api/*` in the Worker's
`run_worker_first` list for the existing proxy handler; the zone exclusion
bypasses that asset/script routing altogether. Removing it from that list alone
would serve the SPA fallback, not the API.

Two zone rules preserve the API behavior previously supplied by the Worker.
Both are in `deploy/cloudflare/rules.json` (§2), and during the hostname
transition both match the old and new UAT hosts as well as the production
app host:

```text
http.host in {"app.capynotebook.com" "app.uat.capynotebook.com" "uat.capynotebook.com"} and starts_with(http.request.uri.path, "/api/")
```

- **Cache Rule** `capy_app_api_bypass_cache`: bypass cache (`cache: false`).
- **Response Header Transform Rule** `capy_app_api_no_store_nosniff`: set
  `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

Save the current DNS, Worker routes, tunnel configuration and these rules
before editing. Add the new host's ingress and extend the zone rules, then add
its proxied CNAME, site Worker Route and scriptless API route. Preserve the old
host's equivalent entries during §1.0.2. On the canonical host only, removing
the scriptless route restores the Worker's existing API proxy. The fallback
checks the request against `APP_ORIGIN`, so it cannot serve the old host once
that binding points at the new app.

Verify the SPA and a static asset, workspace summary HTML,
anonymous API 401, authenticated API JSON, and an authenticated SSE connection
through at least one heartbeat. Check API `no-store`/`nosniff` headers and cache
bypass. Tail the site Worker with uniquely marked requests: a summary render
must appear, and requests to `/api/*` must not. Read back both Worker routes and
the tunnel configuration. Local `pnpm dev:uat` still sends `/api` directly to
`uat-api`; its HTTPS hostname, Clerk instance, and summary renderer are unchanged.

Verified on the old `uat.capynotebook.com` host on 2026-09-10: authenticated `/api/me` returned 200 through the UAT site,
direct API hostname, and local Vite. Notification SSE delivered its connection
frame and 25-second heartbeat through both the site and Vite. Marked summary
requests appeared in the site Worker tail; marked API requests did not. The
private summary fixture returned HTML 404 and its legacy link redirected with
301; the SPA and a built asset returned 200. `wrangler triggers deploy --env uat`
preserved the scriptless route. This check used local Vite directly; local Caddy
and a browser sign-in were not started.

### 1.0.2 App hostname transition

The approved UAT app is `https://app.uat.capynotebook.com`. Production is prepared
for `https://app.capynotebook.com`, with `capynotebook.com` and `www` reserved for
a separate public deployment. Astro with fully static output is the preliminary
choice; building that site is deferred. See the [landing-site handoff](landing-site-handoff.md).
Keep `/support`, `/help-and-legal`, credits, and existing auth links in the app
until real public destinations and approved documents exist. `/w/{workspaceId}`
stays on the app Worker.

1. Save the current public environment values, Clerk application/return URLs,
   DNS, routes, tunnel ingress and edge rules for rollback. Finish existing UAT
   journey cleanup before changing targets; saved run manifests bind to their
   original app URL and must not be rewritten to bypass cleanup checks.
2. Confirm active TLS coverage for `app.uat` under `*.uat.capynotebook.com`.
   Preserve this advanced certificate's renewal. Add the new DNS, ingress,
   Worker route, scriptless API exclusion and edge rules from §1.0.1 while
   retaining the old host. Exclude both UAT hosts from search indexing at the
   edge; production's public summaries retain their existing visibility rules.
3. Before sending users to the new app, add its origin to CORS, collaboration
   and Office parents. During overlap, configure the following values in the
   ignored `deploy/.env.uat` and sync the approved GitHub `uat` variables through
   §12.7. Preserve all unrelated entries and credentials.

   | Setting | Transition value |
   | --- | --- |
   | `APP_URL`, `DEPLOYMENT_APP_URL`, `UAT_APP_URL` | `https://app.uat.capynotebook.com` |
   | `UAT_ALLOWED_HOSTS` | `app.uat.capynotebook.com,uat-api.capynotebook.com,uat-collab.capynotebook.com,uat-ops.capynotebook.com` |
   | `CORS_ALLOWED_ORIGINS` | `https://app.uat.capynotebook.com,https://uat.capynotebook.com` |
   | `COLLABORATION_ALLOWED_ORIGINS`, `OFFICE_ALLOWED_PARENT_ORIGINS` | `https://app.uat.capynotebook.com,https://uat.capynotebook.com,https://local.uat.capynotebook.com` |

   `VITE_APP_URL` and Worker `APP_ORIGIN` derive from `DEPLOYMENT_APP_URL`; rebuild
   rather than editing generated assets. UAT B2 already permits `https://*.uat.capynotebook.com`.
   Its checked-in CORS file explicitly includes both app origins during overlap.
   Production B2, CORS, collaboration and Office parents use only the production
   app origin. The future public site has no app API or blob permissions.
4. Keep UAT Clerk's primary domain, FAPI, account portal, keys and issuer. Update
   its application home and return destinations to the new app. Preserve custom
   `/sign-in`, `/sign-up`, `/forgot-password` and `/sso-callback` paths; if Clerk's
   optional subdomain allowlist is enabled, include the app and existing local
   origin. Google and Microsoft sign-in callbacks remain on
   `https://clerk.uat.capynotebook.com/v1/oauth_callback`; retain the existing
   development callbacks too. The separate OneDrive FilePicker SPA registration
   needs `https://app.uat.capynotebook.com/msal-redirect.html` before UAT cutover
   and the production app equivalent before launch, keeping old entries during
   overlap. Add `local.uat` separately if local OneDrive use is wanted.
5. Deploy backend/collaboration configuration and rebuild the SPA and Office
   from one reviewed revision. API, collaboration, Office and local-development hostnames
   remain unchanged. `APP_URL` changes new invitation/email links and Stripe
   Checkout/portal returns; existing issued links retain their original URLs.
   Clerk/Stripe webhooks remain on `uat-api`, and product mail still sends from `uat`.
   This hostname change requires no database or ingest migration.
6. Run the [activation checks](uat-activation-checklist.md#app-hostname-cutover).
   Keep old browser pages accessible until pending source drafts reach Saved or
   are exported. IndexedDB is origin-specific; a redirect cannot move browser
   drafts, language or theme preferences. Do not clear the old host's storage.
7. Once old browser-only work is recovered and the new host passes checks,
   temporarily redirect old page navigations to the new app with path and query
   preserved. Exclude `/api` and `/api/*` from the redirect so old tabs and email
   unsubscribe GET/POST requests keep using the original backend route. Check
   bookmarks containing `redirect_url`: relative destinations survive, while an
   absolute old-host value is rejected by the app's same-origin auth guard and
   returns to `/`. Resolve those destinations before making redirects permanent.
   Keep old API DNS, ingress and scriptless routing until old tabs/links no longer
   need them. Remove the temporary old app origins only when that support ends.

As of 2026-09-14, the app migration is deployed and the user confirmed there are
no files or browser-only drafts to recover. Cloudflare ruleset
`243013591162487eaa11f79f78c9a07f`, rule `650c35e45f5448ebade28397169e6c01`
(`capy_uat_app_temporary_redirect`), temporarily redirects old-host GET/HEAD
requests with HTTP 302 and preserves path/query. `/api` and `/api/*` are
excluded; the old API routing and overlap origins remain. Disable this one rule
to restore old-host page access without removing the API routes.

Rollback restores the saved canonical app values, Clerk return paths and page
routing together, then rebuilds/redeploys so generated origins agree. DNS alone
cannot restore billing/email URLs, summaries, iframe policies or the Worker's
API-origin check. Keep both origins and API routes available during rollback.

Production route names in `wrangler.jsonc`, `wrangler.office.jsonc` and the env
example are preparation only. Provision its backend/tunnel, DNS, scriptless
`app.capynotebook.com/api/*` route, API edge rules, bucket, identity/provider
settings and GitHub environment before first deployment. The public site remains
a separate future deployment; no app wildcard route may capture its apex or `www`.

### 1.1 Coolify + Cloudflare Tunnel (recommended for this stack)

Use `deploy/docker-compose.prod.yml`, not the local `docker-compose.yml`.
The prod file runs `/migrate` once per deploy, starts the API with
`MIGRATE=false`, and does not publish host ports.

#### Create the Coolify resource

1. **Project → production environment → + New Resource → Git** (GitHub App
   or deploy key). Pick this repository and `main`; GitHub Actions pins the
   exact commit separately.
2. **Build Pack:** Docker Compose.
3. **Docker Compose Location:** `deploy/docker-compose.prod.yml`.
   Leave **Base Directory** empty (repository root). Coolify builds with
   `--project-directory` at the repository root, and Compose resolves relative
   paths against the project directory, not the compose file, so build contexts
   are written repo-root relative (`./server` is `server/` in the repo). Any
   CLI invocation must pass `--project-directory .` to match.
4. **Environment Variables:** paste `deploy/.env.prod.example`, fill values,
   and mark passwords/keys as secrets. Ops has its own application, described
   below, and needs the §8 roles first. Do **not** set
   `AUTH_DISABLED=true` or `MIGRATE=true`. In Advanced settings, enable
   **Include Source Commit in Build** so Coolify supplies `SOURCE_COMMIT` to
   the Compose build and runtime; the release verifier depends on it. Turn
   **off** "Inject build args into Dockerfile" (Advanced, both applications).
   With it on, Coolify writes `ARG KEY=value` for every build-time variable
   under each `FROM`, so `SOURCE_COMMIT` and `RELEASE_SHA` sit above every
   `RUN`, no layer below them is ever reused, every deploy leaves 5–7 GB of
   dead build cache, and the values appear in `docker history`. Compose still
   passes the `VITE_*` args the Dockerfiles declare.
5. **Deploy.** Coolify runs `docker compose up --build`. `migrate` applies
   pending `NNNN_*.sql` files and exits 0; `server` / `worker` / `retrieval`
   wait on `service_completed_successfully`. An exited `migrate` container
   is expected. Open its logs and look for `pending 0001_init.sql` (first
   deploy) or only `migrations applied` (later deploys). Applied files are
   checksum-ledgered and never edited; schema changes after the initial
   deploy are new forward-only files (`0006_rag_chunk_confidence.sql`,
   `0007_drop_caption_images.sql`, `0008_parse_page_rates.sql`,
   `0009_default_chat_model.sql` came with the OpenDataLoader release and
   apply on the next deploy of an existing database; `0009` also moves the
   catalog's chat slot default to `zai/glm-5.3-flash`, so the `zai` GLM
   capacity row and `ZAI_API_KEY` must be in place before that deploy).
6. **Domains** on the resource, after the first successful deploy (Coolify
   has to parse the compose file first). Enter **`http://`** — Cloudflare
   terminates TLS. Include the container port if the UI asks for one:

   | Service                                         | Domain field                   |
   | ----------------------------------------------- | ------------------------------ |
   | `server`                                        | `http://api.capynotebook.com:8080`     |
   | `collaboration`                                 | `http://collab.capynotebook.com:1234`  |
   | `ops` (separate application, after step 8)       | `http://ops.capynotebook.com:8082` |
   | `db`, `redis`, `migrate`, `worker`, `retrieval` | no domain                      |

   Redeploy or wait for the proxy to pick up the domains.

   Run exactly one `collaboration` container per environment. A redeploy
   (`docker compose up`) replaces it: the old container gets SIGTERM, flushes
   its rooms and exits before the new one starts, so two never serve at once.
   The Rust collaboration server keeps documents and awareness in its own
   rooms; Redis only carries evictions, relays and handoff, so a second
   instance would not share document or awareness state with the first. Its
   stale entry in the instance registry lingers up to 60 s after a restart, which only slows
   an eviction or handoff in that window (they wait for its acknowledgement and
   retry). Scaling out later means document-sticky routing, every connection
   to a room reaching the instance that holds it, not Redis fan-out.

   Production pins `collaboration` to cores 2-3 of its 4 vCPU with `cpuset`.
   `scripts/env/config.py render` sets `COLLABORATION_CPUSET=2,3` for
   production and leaves it blank for UAT, and the compose file passes it as
   `cpuset: ${COLLABORATION_CPUSET:-}`. Blank means no `cpuset`, so UAT's 2
   vCPU stay unpinned. Every other service stays unpinned and can use all four
   cores, so a busy collaboration service never takes the gateway, Postgres or
   retrieval off a core. Coolify's own resource-limit fields do not apply to a
   Docker Compose resource; the limit has to be in the compose file. The
   second core gives the Office engines their own core: in the
   2026-10-05 capacity run (`bench/collaboration/reports/2026-10-05-prod-capacity.md`)
   it roughly halved small-room p95 and moved the small-room limit from about
   80 to 160 rooms of 5. Docker refuses to start a container whose `cpuset`
   names a core the host does not have, so change the value with the host
   size. Check after a promotion:

   ```bash
   docker inspect -f '{{.HostConfig.CpusetCpus}}' $(docker ps -qf name=collaboration)
   ```

   It prints `2,3` in production and nothing on UAT.

   The collaboration service has no container memory limit (Epo 2026-10-08).
   Its Office engines are child processes of the same binary, each with its
   own data cap (`RLIMIT_DATA`, `COLLABORATION_ENGINE_MEMORY_LIMIT_BYTES`) and
   `oom_score_adj` 1000, so under memory pressure the kernel kills an engine
   child first; the room's call fails as transient and a new process starts.
   Postgres and the gateway run at `oom_score_adj` -500
   (`docker-compose.prod.yml`). Size a host for the collaboration budget:
   the engines (production 2 save + 1 background at 4 GiB each, UAT 1 + 1 at
   3 GiB, rendered by `scripts/env/config.py`), the server itself (~0.7 GiB)
   and agent markdown's V8 (~0.8 GiB, its heap capped). Production has
   7.6 GiB of RAM and 12 GiB of swap, UAT 3.9 GB and 6 GiB, so the engine caps
   lean on swap; they bound a runaway call, not the expected footprint.

   The collaboration service runs with `MALLOC_ARENA_MAX=2`,
   `MALLOC_TRIM_THRESHOLD_=131072` and `MALLOC_MMAP_THRESHOLD_=131072`
   (`docker-compose.prod.yml`, UAT and production; the engine processes
   inherit them, Epo 2026-10-17). Room loads replay on tokio's blocking
   threads, each with its own glibc arena, and glibc raises its mmap
   threshold as large blocks are freed, so without them memory freed after
   peers leave stays in the process: 411-467 MiB kept, against ~90 MiB with
   them, and a peak of ~180 MiB instead of ~520, at the same marker latency
   (`bench/collaboration/reports/2026-10-17-collaboration-allocator.md`).
   After a deploy that changes them, compare the container's memory
   (`docker stats --no-stream $(docker ps -qf name=collaboration)`) at idle
   and after a busy period with the numbers from before.

   Open source rooms keep their original files, seeds and baselines on disk,
   not in memory (Epo 2026-10-17; the disk store in
   [office-files](frontend/office-files.md)). The folder is the image's
   `/var/lib/capy/sources` (`COLLABORATION_SOURCE_DISK_DIR`, set in
   `collaboration-rs/Dockerfile`) on the named volume
   `capy_collaboration_sources` (`docker-compose.prod.yml`): disk-backed, never
   tmpfs. Docker creates the volume with the image folder's owner (the
   service user `nobody`) and mode 0700. The server deletes the files it wrote
   there when it stops gracefully, once the rooms stored (a crash leaves them),
   and wipes them at every start. One collaboration process per environment uses
   it. The image sets the folder because the path is the image's layout, the
   same in every environment; the cap has no default, and the server refuses
   to start without it. The cap is `COLLABORATION_SOURCE_DISK_BYTES`, rendered
   by `scripts/env/config.py`: production 10 GiB (10737418240), UAT 5 GiB
   (5368709120); the local compose files use UAT's. Nothing is set by hand:
   every Deploy UAT and production promotion runs `deploy-environment.yml`,
   whose deploy job renders `coolify.json` (the cap included), applies it to
   Coolify with `config.py apply-coolify` and reads it back before
   `coolify-deploy.sh` starts the deploy. A deploy that skipped that sync
   would fail on the compose file's `${COLLABORATION_SOURCE_DISK_BYTES:?}`
   rather than run without a cap. Size the disk for the
   cap: at the decision production had 50 of 75 GB free and UAT 29 of 78 GB
   (UAT shrinks with deploy images until the weekly cleanup). When loaded
   rooms' files fill the cap, new source rooms are refused
   (`capy_collaboration_source_disk_refusals_total` on `/metrics`, a
   `source room refused: disk store full` warn line);
   `capy_collaboration_source_disk_held_bytes` shows how much of the cap the
   open rooms hold. Raise the cap only with the free space to back it. To
   check the folder after a deploy:

   ```bash
   c=$(docker ps -qf name=collaboration)
   docker exec "$c" sh -c 'stat -c "%U %a" /var/lib/capy/sources; du -sh /var/lib/capy/sources'
   ```

   It prints `nobody 700` and the bytes on disk: the open rooms' files plus
   idle ones still in their 3-minute grace (a few KB right after a restart).

   Every client socket, gateway call and database connection is an open
   file. The compose files give the collaboration service `nofile` 524288,
   and the server raises its soft limit to the hard one at startup, as Go and
   Node do, logging `open_files_limit`. If the raise fails, the server exits
   instead of serving. Docker's default soft limit of 1024 held it near 1,000
   connections in the production capacity run. The line names the soft limit
   it reached, which is the container's hard limit: a value far below 524288
   (1024, say) means the compose `ulimits` did not apply, and the server will
   stop accepting connections near that number. To check:

   ```bash
   docker exec $(docker ps -qf name=collaboration) sh -c 'grep "open files" /proc/1/limits'
   ```

   Each WebSocket has an 8 KiB read buffer (`READ_BUFFER` in `http.rs`;
   tungstenite's default is 128 KiB). An idle connection costs about 30 KiB
   in all, measured on a local stack with 2,000 idle connections; Node used
   27 KB per connection in the production run. A connection's buffers grow to
   a large frame it sends or receives (a viewer joining a 2 MB note is sent
   the whole note; a writer may send a large paste, a peer up to the frame
   cap) and give that room back once the frame is through: the server vendors
   tungstenite with that patch (`collaboration-rs/third_party/tungstenite`,
   `THIRD-PARTY-NOTICES.md`; upstream keeps the capacity, about 2.3 MiB per
   viewer of the 2 MB test note, and a received frame's size per socket, Epo
   2026-10-11 and 2026-10-12). A write buffer keeps at most 64 KiB; a read
   buffer keeps about 72 KiB (a frame of up to 64 KiB plus one 8 KiB read).
   When peers leave, the process keeps the small allocations they freed and
   reuses them for later joins, so RSS stays near its peak instead of falling
   back.

   A warm deploy rebuilds only what changed: `go build`, the Vite/collab
   bundles and the pipeline source copy. Dependency installs, the BetterOffice
   WASM toolchain and `uv sync` come from the layer cache until their lockfile
   or `vendor/betteroffice` moves. `ARG RELEASE_SHA` in `pipeline/Dockerfile`
   stays below `uv sync` for the same reason. A cold build (empty cache) takes
   about 16 minutes on the UAT host.
   On the 2 vCPU UAT host the four concurrent builds also starve Coolify's own
   API into `502`s; `coolify-deploy.sh` treats that as an unknown status and
   keeps polling rather than abandoning a deployment that is still running.

   Give the host swap before deploying. Those builds peaked at load 71 and
   58 MB free on a 3.9 GB host, and the kernel killed Coolify's own PHP queue
   worker, which left its deployment stuck `in_progress` with an idle machine
   and no terminal status for the workflow to poll. Recover that state with
   `POST /deployments/<uuid>/cancel`, then provision swap as in section 7 step 5
   (6 GiB is enough here; the ingest host's 24 GiB sizing is for parsing):

   ```bash
   fallocate -l 6G /swapfile && chmod 600 /swapfile && mkswap /swapfile
   swapon /swapfile
   grep -q '^/swapfile none swap sw 0 0$' /etc/fstab || \
     printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

   Cap the BuildKit cache. Docker's default GC on a 78 GB disk keeps up to
   ~58 GiB of build cache and only evicts when under 15 GiB is free, so the
   host sits at 80% by design. Add to `/etc/docker/daemon.json` and
   `systemctl restart docker` (containers return through their restart
   policies; `docker start coolify-sentinel` by hand, it has none):

   ```json
   "builder": { "gc": { "enabled": true, "defaultKeepStorage": "20GB" } }
   ```

   BuildKit then prunes least-recently-used entries after each build; the
   `--mount=type=cache` mounts and the last build's layers are the most
   recent and survive. In Coolify's server settings set **Docker cleanup**
   to `force off`, threshold 85%. That cleanup always runs
   `docker builder prune -af`, which empties the cache mounts too and makes
   the next deploy cold, so it should only fire as a last resort when old
   image generations push the disk past the threshold.

   Coolify applies each application's *Docker images to keep* (2) only in
   that cleanup, which runs weekly, while UAT takes about 20 deploys a day,
   each leaving a full image generation (~0.27 GB after shared layers). A
   daily root cron on the UAT host keeps the newest 2 images of every
   `<uuid>_<service>` repository and removes dangling images, never the
   build cache (`/usr/local/sbin/capy-prune-app-images.sh`, scheduled by
   `/etc/cron.d/capy-prune-app-images` at 04:30, logged to the journal as
   `capy-prune-app-images`):

   ```sh
   docker images --format '{{.Repository}}' | grep -E '^[a-z0-9]{24}_' | sort -u | while read -r repo; do
     docker images "$repo" --format '{{.CreatedAt}}	{{.ID}}' | sort -r | awk -F'	' 'NR>2{print $2}' | sort -u | xargs -r docker rmi >/dev/null 2>&1 || true
   done
   docker image prune -f
   ```

   Production deploys rarely and has no cron; its `daemon.json` has had the
   BuildKit cap above since 2026-10-08.

7. Disable Coolify **Auto Deploy**. The GitHub deployment workflow updates
   `git_commit_sha`, starts the deployment through the Coolify API, polls its
   result, and verifies the reported commit. A native Coolify webhook would
   bypass the UAT and production gates.
8. After §8 grants and Access are ready, create the independent Ops application
   below. Deploy it through **Deploy Ops**; the main workflow does not build
   or restart Ops.

CLI equivalent (same file, from the repo root):

```bash
cp deploy/.env.prod.example deploy/.env.prod
# fill deploy/.env.prod — never commit it
docker compose -f deploy/docker-compose.prod.yml --project-directory . --env-file deploy/.env.prod up -d --build
docker compose -f deploy/docker-compose.prod.yml --project-directory . --env-file deploy/.env.prod logs migrate
```

Ops uses `deploy/docker-compose.ops.yml` with a distinct Compose project name
and database URLs pointing to the existing application database.
Storage and Stripe reconciliation is scheduled and claimed by the gateway's
database-backed runner; no Coolify task is required. To ensure today's runs are
queued and drain any pending work from a one-off container, use:

```bash
docker compose -f deploy/docker-compose.prod.yml --project-directory . --env-file deploy/.env.prod --profile reconcile run --rm reconcile
```

The command and gateway share `reconcile_runs`, so concurrent invocations are
safe and do not create a second run for the same UTC schedule slot.

Do **not** point the tunnel at `:8080` / `:1234`. Coolify already runs Traefik
or Caddy on the host; the tunnel should hit that proxy and let it route by
`Host`. Follow [Coolify: access all resources via tunnels](https://coolify.io/docs/integrations/cloudflare/tunnels/all-resource), with these bindings:

| Hostname                     | Tunnel service                                                                                                | Coolify domain field                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `api.capynotebook.com`               | `http://localhost:80` (or `http://coolify-proxy:80` if `cloudflared` is a container on the `coolify` network) | `http://api.capynotebook.com` on the **server** service |
| `collab.capynotebook.com`            | same `:80`                                                                                                    | `http://collab.capynotebook.com` on **collaboration**   |
| `ops.capynotebook.com`           | same `:80`                                                                                                    | `http://ops.capynotebook.com` on **ops**            |
| retrieval, worker, db, redis | none                                                                                                          | no domain                                       |

Details that are easy to get wrong:

- Run `cloudflared` as a **Coolify service** (or systemd on the host), not as a
  service in either compose file. A compose restart must not drop every
  hostname on the server.
- Deploy the separate Ops application only after §8. **Deploy Ops** supplies
  `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SENTRY_DSN_OPS`, and `RELEASE_SHA`
  from GitHub before building its dashboard and Go backend together.
- Enter Coolify domains as **`http://`**. Cloudflare terminates TLS. `https://`
  here makes Traefik request Let's Encrypt and usually 301-loops.
- App env vars still use `https://` / `wss://` — those are what browsers, Clerk,
  and Stripe see (see the block below).
- Cloudflare SSL/TLS **Full** is enough: the tunnel is already encrypted, and
  the last hop is HTTP to the proxy. **Full (strict)** needs origin certs —
  Coolify's [full TLS guide](https://coolify.io/docs/integrations/cloudflare/tunnels/full-tls).
- Do not publish `8080` / `1234` / `8001` on a public interface. Traefik + the
  tunnel is the public path; `8080` is published only on the WireGuard address
  for the ingest host's import worker (§2.2), and `:8001` must stay private.
- Chat SSE and collab WebSockets both pass through Traefik. If streams die at
  ~60–100s, raise the proxy read timeout on `api.capynotebook.com`. Cloudflare Tunnel
  itself is not subject to the 100s orange-cloud proxy timeout; Traefik still
  is.
- Coolify parses every `${VAR:?message}` in the compose file and stores
  `message` as that variable's value. The guard then cannot fire, because the
  variable is not empty: the gateway boots with `CLERK_SECRET_KEY` set to the
  literal `set CLERK_SECRET_KEY` and fails every request instead of refusing to
  start. Once the resource exists, blank every variable you have not filled in
  yourself. `SOURCE_COMMIT` picks up the literal `${RELEASE_SHA:-}` the same
  way; blank it and let Coolify inject the real commit.
- Coolify keeps a second value per variable for pull-request preview
  deployments, and creates a twin of every key when it parses the compose file.
  Preview deployments are disabled in this repository, so delete the preview
  set rather than maintaining two columns.
- Do not mark a generated secret **shown once**. Coolify then hides it from the
  UI and the API permanently, and nothing can read back the Postgres password
  that the ingest host queue env and `OPS_INGEST_UAT_DATABASE_URL` both need.
  Keep those values in the ignored local env file.
- Coolify caches its compose parse. Blanking a variable does not rewrite that
  cache, and only a deploy re-parses the repository. Check the container
  environment after the first deploy instead of trusting the stored parse.

In the tunnel's Public Hostnames page, add `ops.capynotebook.com` with service
`http://localhost:80`, or the Coolify proxy address from the table. Cloudflare
creates the proxied CNAME to the tunnel. Do not also create an A or AAAA record
for `ops.capynotebook.com`.

### 1.2 Bare docker compose + Tunnel

On a host running `deploy/docker-compose.yml` without Coolify's proxy,
`cloudflared` publishes the app ports directly. Cloudflare creates the DNS
records; do **not** also point A records at the VPS IP.

```
api.capynotebook.com     → http://localhost:8080  (the `server` container)
collab.capynotebook.com  → http://localhost:1234  (the `collaboration` container)
ops.capynotebook.com → http://localhost:8082  (the `ops` container)
```

SSL/TLS **Full (strict)** is appropriate here if the origin speaks TLS.
Leave :8001, Postgres and Redis unpublished. Bind :8082 to localhost as shown
in compose so the tunnel can reach it but the internet cannot bypass Access.
This is the origin lockdown in §3.

### 1.3 A/AAAA instead of a tunnel

`A`/`AAAA` for `api.capynotebook.com` and `collab.capynotebook.com` to the VPS, **orange cloud
on**, then firewall :80/:443 to Cloudflare IPs and enable Authenticated Origin
Pulls. Grey-cloud (DNS only) publishes the origin and makes `CF-Connecting-IP`
forgeable. SSL/TLS **Full (strict)**. "Flexible" terminates TLS at Cloudflare
and speaks plain HTTP to the origin — anyone between them reads every bearer
token.

### 1.4 App URLs and env (all of the above)

Same values whether Coolify, bare compose, or A records. Coolify domain fields
are `http://`; these vars stay `https://` / `wss://`. Copy the rest from
`deploy/.env.example` (Clerk, Stripe, Sentry DSNs, provider keys).
`RATE_LIMIT_AI_PER_HOUR` defaults to 200; the 15/minute AI burst and
120/minute editor class are not env-overridable. Configure model capacity in the
Ops model catalog before allowing platform model calls. Each environment stores
its own provider/model limits in `model_capacities`; new databases start
without limits and missing capacity fails explicitly. Production uses GLM
48 total / 40 interactive reserve (Z.AI holds about 50 calls in flight per key;
migration 0097 copies an existing Relace GLM row there under that cap; the relace
row, kept for the previous release during the deploy, is removed by hand after it) and Qwen
embedding 200 / 80. UAT and full local
development must use limits appropriate to their own provider accounts.
`deploy/model-capacities.sql` is an opt-in bootstrap after migrations. It inserts
only missing enabled platform-model capacities using the documented DeepSeek
and DeepInfra concurrency limits, and Z.AI's measured GLM limit. Its source links and
allocation assumptions are in the SQL. Existing operator values are preserved.
Apply to one explicitly selected database with
`psql -v ON_ERROR_STOP=1 -f deploy/model-capacities.sql`. If environments share
an account, divide its quota among them before applying the script.

Migration `0030_rerank_slot.sql` seeds DeepInfra `Qwen/Qwen3-Reranker-4B` as
the `rerank` default and copies the environment's Qwen embedding capacity to it
when one exists. Where none exists, set the reranker's capacity in Ops or with
the script above; until then every search logs `rerank failed; keeping fused
order` and returns unreranked results. It needs no new secret
(`DEEPINFRA_API_KEY` on the retrieval service). To turn reranking off, remove
the reranker from the `rerank` column in the Ops model catalog and save;
running retrieval processes stop reranking within one registry poll
(10 minutes). That save disables the reranker row, so turning reranking back
on needs a new catalog version: clone the row into a draft in Ops, assign it
to the `rerank` column as its default, and save.

Rollout order for `0030`: an older pipeline registry fails on the unknown
`rerank` slot (running workers stop picking up catalog changes; a restarted
worker or retrieval service does not start). **Deploy ingest** refuses a
revision the backend does not serve yet, so deploy the app (its migration
applies `0030`, and the retrieval service ships with it), then that
environment's ingest lane immediately after at the same revision; in between,
running workers keep the catalog they loaded. This coupling is specific to
`0030` (a migration writing catalog content older pipeline code cannot
read), not to every deploy, and ends once every lane runs that code. The
gateway migrates at startup unless `MIGRATE=false`, so developers run a local
gateway build containing `0030` with `MIGRATE=false` (or not at all) until
`worker-local` runs that code.

Migration `0010_deepseek_flash.sql` moves Flash Vision catalog entries and user
preferences to `deepseek-flash`, carries over existing credit rates and capacity,
and retains historical rows for pinned messages/jobs. Deploy the API/Ops build
containing the new exact-slug agentic-loop certification with this migration.
Migration `0011_retire_deepseek_pro.sql` removes V4 Pro's catalog and operational
configuration directly. Its original seed remains in frozen `0001`; fresh
databases replay the removal before serving traffic.
`pnpm model:certify --provider deepseek --model deepseek-flash` records/replays
two live tool turns; `uv run --extra test python pipeline/scripts/smoke_deepseek_flash.py`
makes two additional small paid calls for image input and max thinking.

The initial schema in `0001_init.sql` creates the capacity table. Apply the Ops
role grants in §8, then enter each environment's limits through Ops before
allowing traffic. Runtime admission reads current limits without worker restarts.
Do not copy production capacity into another environment automatically.

Gateway env once those hostnames exist:

```
APP_URL=https://app.capynotebook.com
CORS_ALLOWED_ORIGINS=https://app.capynotebook.com
COLLABORATION_URL=wss://collab.capynotebook.com
COLLABORATION_ALLOWED_ORIGINS=https://app.capynotebook.com
```

Ops uses one read/auth role and one shared admin-actions role. The admin pool
opens lazily only after the application authorizes a registry Save or a
reconciliation request:

```
OPS_DATABASE_URL=postgres://capy_ops:<password>@<private-postgres-host>:5432/capy?sslmode=require
OPS_ADMIN_DATABASE_URL=postgres://capy_ops_admin:<password>@<private-postgres-host>:5432/capy?sslmode=require
OPS_INGEST_PRIMARY_ENVIRONMENT=production
# Optional: the same column-limited capy_ops role in the other app databases.
OPS_INGEST_UAT_DATABASE_URL=postgres://capy_ops:<password>@<uat-postgres-host>:5432/capy?sslmode=require
OPS_INGEST_LOCAL_DATABASE_URL=postgres://capy_ops:<password>@<local-postgres-host>:5432/capy?sslmode=require

`OPS_INGEST_PRIMARY_ENVIRONMENT` names which environment wrote the rows in
`OPS_DATABASE_URL`, and must equal the `CAPY_INGEST_ENVIRONMENT` of the queue
consumers pointed at that database: `production` here, `uat` in the UAT
resource, `local` in the local compose stack. Every ingest attempt, provider
call, and host sample is filtered on it. A mismatch is not rejected at startup
and raises no error: the ingest pages render one tab of zeros while the queue
counters, which are not environment-scoped, keep reporting real depth. Startup
does reject the secondary DSN that duplicates the primary, so leave
`OPS_INGEST_UAT_DATABASE_URL` unset when the primary is `uat`, and
`OPS_INGEST_LOCAL_DATABASE_URL` unset when it is `local`. Sharing one ingest
host does not merge the labels: the nonproduction project runs separate local
and UAT consumers that write `local` and `uat` into their own databases.
OPS_CF_ACCESS_ISSUER=https://<team-name>.cloudflareaccess.com
OPS_CF_ACCESS_AUDIENCE=<Access application AUD>
# OPS_CF_ACCESS_JWKS_URL defaults to <issuer>/cdn-cgi/access/certs
OPS_ACCESS_DISABLED=false
OPS_AUTH_DISABLED=false
OPS_UNSAFE_DEVELOPMENT=false
```

`OPS_ADMIN_DATABASE_URL` is stored as configuration at startup, but its shared
pool opens lazily from admin-only handlers. Viewer requests are rejected before
the credential is used.

Use `db` as the Postgres host only when the ops container shares the compose
network with `db`. A managed database must use its private hostname. Do not add
a public Postgres DNS record or a Coolify domain. The ops process does not run
migrations and must never receive the database owner URL. Deploy the gateway
migration first, then start ops.

Startup verifies both database sessions against their privilege contracts. It
rejects superusers, owner sessions with broad writes, inherited roles,
customer-content reads, direct operator-table writes, direct reconciliation
queue writes, table-level writes on any public relation, unexpected
column-level `INSERT`/`UPDATE`/`REFERENCES`, and `model_configs` DELETE. Missing
required column grants also stop startup. Local owner URLs are accepted only with
`APP_ENV=development` and `OPS_UNSAFE_DEVELOPMENT=true`. Auth bypasses also
require their individual `OPS_ACCESS_DISABLED=true` or
`OPS_AUTH_DISABLED=true` switch. None of these unsafe settings is accepted
outside development.

Set `VITE_CLERK_PUBLISHABLE_KEY` at image build time and `CLERK_SECRET_KEY` at
runtime. They must belong to the same Clerk instance as the product. Start the
service through **Deploy Ops**. Local development still uses the compose
`ops` profile. Do not set any database URL in browser
build arguments.

In Clerk, add `https://ops.capynotebook.com` to the production instance's allowed
origins and redirect URLs alongside `https://app.capynotebook.com`. The future
public site needs neither app API access nor a separate Clerk application. Do not create a second Clerk instance: the Clerk
subject must continue to match `users.id` and `operators.user_id`. The Clerk
webhook remains `https://api.capynotebook.com/webhooks/clerk`; ops does not accept
webhooks. Stripe remains `https://api.capynotebook.com/webhooks/stripe`. B2 CORS
`allowedOrigins` is the SPA origin, not `api.` or `ops.`.

---

## 2. Cloudflare — rules

The zone's WAF custom rules, cache rules and response header transform rules
are code. One zone holds production and UAT, and
[`deploy/cloudflare/rules.json`](../deploy/cloudflare/rules.json) lists every
rule of those three phases for both environments.
`scripts/deploy/cloudflare_rules.py` applies the file or checks the zone
against it:

```bash
# A token for the capynotebook.com zone with Zone: Read, Zone WAF: Edit,
# Transform Rules: Edit and Cache Rules: Edit. The script never prints it.
export CLOUDFLARE_API_TOKEN=...
python3 scripts/deploy/cloudflare_rules.py --check   # exit 1 on any drift; writes nothing
python3 scripts/deploy/cloudflare_rules.py           # replace each drifted phase's rules with the file's
```

The file owns each phase it lists: the phase's entry point ruleset must hold
exactly the file's rules, in the file's order, matched by `ref`, and nothing
else. `--check` prints every difference: `+` a rule the zone lacks, `~` a rule
whose fields differ (both versions printed), `-` a live rule the file does not
list, or a changed order. An apply rewrites only the phases that drifted, then
reads them back. It refuses to delete a live-only rule unless given `--prune`:
fold a rule made in the dashboard into the file first (keep its live `ref`, so
it keeps its id), or prune it on purpose. If the readback still differs, the
API stores a field the file leaves out (a default it adds); copy that field
from the printed live version into the file. Change these rules only in the
file, through a commit, then apply; run `--check` after any dashboard visit.
Phases the file does not list stay manual: redirect rules (the old UAT host's
redirect in §1.0.2), configuration rules and Managed Transforms.

Before an apply that removes or replaces rules, save each phase's live rules
for rollback; rolling back is a `PUT` of the saved `rules` to the same entry
point. The file holds the UAT hosts' search-indexing exclusion from §1.0.2
(`capy_uat_app_noindex`, its live `ref`).

```bash
zone=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=capynotebook.com" | jq -r '.result[0].id')
for phase in http_request_firewall_custom http_ratelimit http_request_cache_settings http_response_headers_transform; do
  curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$zone/rulesets/phases/$phase/entrypoint" > "before-$phase.json"
done
```

**No edge rate limiting rule yet.** The zone is on the Free plan, where a
rate limiting rule may match only the path (no host), counts per IP over 10 s
and blocks for 10 s, and the zone gets one rule. Production and UAT share the
zone and their paths, so a production-only limit cannot be written; it needs
the Pro plan (host in the expression, blocks up to an hour, two rules). Until
then the gateway's limits are the only ones. When the rule is added it goes in
the file's `http_ratelimit` phase and must leave `/webhooks/` out: Stripe and
Clerk burst deliveries and retries from small sets of IPs, and rate limiting
them can lose subscription or identity events.

**WAF custom rule** (`capy_webhooks_skip_security`): requests under
`/webhooks/` on the API hosts (`api`, `uat-api`) skip every security rule (the remaining custom rules, rate
limiting, managed rules, Super Bot Fight Mode, and Zone Lockdown, User Agent
Blocking, Browser Integrity Check, Hotlink Protection and Security Level).

**Do not enable Bot Fight Mode.** It cannot be skipped per-path, so it
challenges webhook deliveries, which cannot solve a JavaScript challenge.

**Keep script injection off on the app zone:** Web Analytics' automatic
beacon (`static.cloudflareinsights.com`), Zaraz and Rocket Loader each add a
script to every page, which the public pages' script policy (§2.4) blocks
with a console error.

**Cache rules:** `capy_backend_hosts_bypass_cache` bypasses the cache for the
API, collaboration and ops hosts of both environments (`api`, `collab`, `ops`,
`uat-api`, `uat-collab`, `uat-ops`) entirely. A cached SSE or WebSocket
response breaks streaming. Cached operator responses can disclose one
operator's data to another. `capy_app_api_bypass_cache` does the same for the
app hosts' same-origin `/api/` (§1.0.1).

**Worker caching checks** (read-only; nothing here is set by Wrangler):

- Workers Routes for the zone list each app host's `/assets/*` on the
  assets Worker (`capy-notebook-assets-uat` / `-production`), the host's
  `/*` on the app Worker and `/api/*` on no script (§1.0.1).
- No Cache Rule, Page Rule or Compression Rule matches the app hosts'
  `/assets/*` or the Office host, and no Transform Rule adds
  `Cache-Control: no-transform` there: the edge decodes the Office Worker's
  brotli files for a client without brotli only while the response allows
  transforms.
- Caching → Tiered Cache governs only zone-cached, proxied origins (the
  bank assets host, for one); Smart Tiered Cache is available on every plan
  and is the setting to keep on. Workers Cache and Workers static assets
  tier on their own, and Regional Tiered Cache is an Enterprise add-on.

**Response header rules:** `capy_ops_no_store_noindex` sets
`Cache-Control: private, no-store` and
`X-Robots-Tag: noindex, nofollow, noarchive` on both ops hosts. Keep the
dashboard's HTML `robots` meta tag too. These headers prevent accidental cache
and search indexing; they are not access controls.
`capy_app_api_no_store_nosniff` sets the app hosts' `/api/` headers (§1.0.1).

### 2.1 Cloudflare Access for ops

Create a self-hosted Access application for `https://ops.capynotebook.com/*`.
Use an Allow policy that names each operator email, or a company identity
provider group that contains only operators. Do not use `Emails ending in` for
a mixed-use domain, and do not add a Bypass or Everyone policy. A short session
duration, such as eight hours, limits a forgotten browser session.

Add a second, `Service Auth` policy that allows only the smoke service token
(Zero Trust → Access → Service Auth). Its client id and secret go in
`UAT_OPS_ACCESS_CLIENT_ID`/`UAT_OPS_ACCESS_CLIENT_SECRET`; `pnpm review:uat:smoke`
sends them to prove the gate lets an allowed caller through. The token carries
no email, so the ops service treats it like any other Access identity and Clerk
still applies.

Copy the application audience tag from the Access application's overview into
`OPS_CF_ACCESS_AUDIENCE`. Copy the Zero Trust team domain, for example
`acme.cloudflareaccess.com`, and use it as the issuer:

```
team domain:          acme.cloudflareaccess.com
OPS_CF_ACCESS_ISSUER: https://acme.cloudflareaccess.com
```

The service derives the JWKS URL as
`https://acme.cloudflareaccess.com/cdn-cgi/access/certs`.
The audience is application-specific. The team domain is account-specific.
Using the account id, zone id, application name, or hostname in either field
causes every request to fail JWT verification.

Access is the first gate, not the application identity. The ops service verifies
the signed `Cf-Access-Jwt-Assertion` against the remote JWKS, including issuer,
audience, and time claims, before it serves static files or API responses. The
static shell must load before Clerk can produce a bearer token. Clerk and the
`operators` check therefore apply to `/api/ops/*`, not to the static shell. An
API request must pass all three checks.

The Access identity and Clerk identity are intentionally independent. Access
decides who may reach the origin. Clerk supplies the product user id checked
against `operators`. Their email addresses are not required to match, so either
gate can be revoked without coupling the two identity systems.

Keep the Access application in front of static files and `/api/*`. Do not
add a bypass policy for `/healthz` at Cloudflare. Docker calls the health route
on the private container network. The public hostname still requires Access.

Test both failure paths before granting an operator row (`pnpm review:uat:smoke`
covers 1 and 2 with the service token):

1. An email outside the Access policy must stop at Cloudflare.
2. An allowed Access identity without a Clerk session can load the sign-in
   shell, but `/api/ops/session` must receive `401`.
3. A valid Clerk user missing from `operators` must receive `403`.
4. A `viewer` without `write_registry` must receive `403` from registry Save
   without opening the writer database pool.

**Timeouts:** the default 100 s orange-cloud proxy read timeout will cut long
chat streams. Parser traffic stays on WireGuard and does not cross Cloudflare.
Coolify's Traefik/Caddy in front of the tunnel still has its own read timeout —
raise that on `api.capynotebook.com` if streams die around a minute.

### 2.2 Drive import worker

Google Drive and OneDrive imports run on the ingest host as the `import` job
type of the pipeline's Postgres `jobs` queue (`import-worker` in
`deploy/docker-compose.ingest-host.yml`, `import-worker-local` / `-uat` in the
nonprod stack). The gateway writes the import row, its upload reservation and
the queue job in one transaction; the worker asks the gateway for a download
grant, streams the provider file into the attempt's incoming B2 object with the
host's own B2 credentials, and reports completion so the gateway finalizes the
file and enqueues the normal parse or ingest job. A parse or ingest job only
exists once the bytes are in B2, and import work takes its own capacity slot so
a slow download never holds an ingest slot.

The worker reaches the gateway's `/api/internal/import/*` routes with
`GATEWAY_URL` and the gateway's `PIPELINE_SECRET`. Production publishes the
gateway on `CAPY_PRIVATE_BIND_ADDRESS:8080` next to Postgres and Redis, so the
ingest host uses `http://10.77.0.1:8080`; the nonprod queue env files carry each
environment's own gateway URL and secret. That publication exposes the whole
gateway API to the ingest host, not only `/api/internal/`; the host is trusted
infrastructure, so no further gate is added. An empty `PIPELINE_SECRET` on the
gateway disables new imports with `503` instead of creating stranded
reservations.

Retry scheduling lives on the `jobs` row (three attempts, 30 s doubling
backoff, `CAPY_IMPORT_JOB_TIMEOUT` per attempt). The gateway's twelve-minute
attempt lease only fences stale callbacks: a retryable failure releases it before
the requeue, a terminal failure or an exhausted budget closes the import and
releases its reservation, and a worker that finds the lease still held by a
reaped predecessor waits out the remaining lease (the gateway's `Retry-After`)
without spending an attempt. A `too_many_ingest_leases` answer at completion also
waits without spending an attempt: the worker releases the gateway lease and
backs off by `Retry-After`; the object is already promoted, so the next claim
resumes at completion without downloading again. Import upload sessions expire after one hour, so the
upload-session sweeper frees within the hour a reservation whose worker died
with its budget spent. One import request carries at most 20 files, the
per-actor ingest lease cap.

Download URLs the gateway did not build itself (Microsoft's preauthenticated
URL, every redirect) are checked per hop: the host must match a suffix in
`CAPY_IMPORT_DOWNLOAD_HOSTS`, every resolved address must be public, and the
connection goes to that validated address with the hostname as SNI so a second
lookup cannot redirect it. A redirect that changes origin drops the bearer
token. Providers move download tiers without notice (OneDrive personal answers
on `microsoftpersonalcontent.com`), so extend the host list in the environment
rather than in code.

### 2.3 Interactive block frame

A note's interactive HTML block runs its snippet in a sandboxed iframe that
loads `embed/index.html` from a Cloudflare Pages project. `pages.dev` is a
public suffix, so the frame is a site of its own: the browser gives it its own
process, and a runaway snippet cannot freeze the app's tab. `embed/_headers`
sends the CSP (inline script and style, scripts, stylesheets and fonts from
`https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net`, `https://esm.sh`
and `https://unpkg.com`, `data:` and `blob:` images, `data:` fonts, no worker
and no other request; SECURITY.md path 11 has the residual risk), `nosniff`,
`no-referrer` and `X-DNS-Prefetch-Control: off`. Every place that serves the
frame reads this one file: Pages, `vite-embed.ts` and the playground's
`/embed/`. It sets no `frame-ancestors`: the same file
serves both environments and every per-deployment URL, and the frame holds
nothing another site could take.

`deploy-environment.yml` uploads `embed/` with `wrangler pages deploy` in the
`site` job, at the deployed revision and before the SPA Worker, so promotion
carries it to production too. One project serves both environments: production
deploys to the project's production branch `production`
(`https://capy-embed.pages.dev`), UAT to the branch `uat`, whose alias is
`https://uat.capy-embed.pages.dev`. The SPA build reads the frame origin from
`VITE_EMBED_ORIGIN`.

First setup, once, by hand:

1. Create the project:
   ```bash
   npx wrangler@4.149.0 pages project create capy-embed --production-branch production
   ```
   If `capy-embed.pages.dev` is taken, Cloudflare adds a suffix to the
   subdomain. Use the hostname shown under Workers & Pages → `capy-embed` in
   step 3. The `uat` alias appears with the first UAT deploy.
2. Give the deploy token (`CLOUDFLARE_API_TOKEN`, both GitHub environments) the
   account permission **Cloudflare Pages: Edit** next to its Workers
   permissions.
3. Set the GitHub variables in both environments through `deploy/.env.uat`,
   `deploy/.env.prod` and `pnpm env:push` (§12.7):

   | Variable | `uat` | `production` |
   | --- | --- | --- |
   | `EMBED_PAGES_PROJECT` | `capy-embed` | `capy-embed` |
   | `VITE_EMBED_ORIGIN` | `https://uat.capy-embed.pages.dev` | `https://capy-embed.pages.dev` |

   The SPA build fails without `VITE_EMBED_ORIGIN` and the frame step without
   `EMBED_PAGES_PROJECT`. `VITE_EMBED_ORIGIN` is a bare origin with no
   trailing slash; the app loads `${VITE_EMBED_ORIGIN}/`.
4. Turn off Cloudflare Access on the project's preview deployments: Workers &
   Pages → `capy-embed` → Settings → General → Access policy → disable (or
   delete its application under Zero Trust → Access → Applications). The `uat`
   alias is a preview deployment, and Cloudflare puts previews behind Access by
   default; Access answers with a login page that sends
   `frame-ancestors 'none'`, so the browser refuses to frame it and every
   interactive block on UAT is blank. The production branch is not covered by
   that policy. Previews hold nothing private, so they stay public. A custom
   domain under `capynotebook.com` is not an alternative: it is the same site
   as the app.

Local development: `pnpm dev` serves `embed/` at `VITE_EMBED_ORIGIN` when that
is a loopback `http` origin (`vite-embed.ts`), with the headers from
`_headers`. `deploy/.env.example` uses `http://127.0.0.1:5180` while the app
runs on `localhost`; another port alone would be the same site. The Playwright
configs serve their own frame on `localhost` next to the app's `127.0.0.1`.

### 2.4 App page policies

Two content security policies, both built once per SPA build by
`vite-image-policy.ts` from configuration the deploy already has:

- **Images, report-only, everywhere.** The SPA's pages and the pages the site
  Worker renders are sent with `Content-Security-Policy-Report-Only` listing
  the only places a page may draw an image or CSS `url()` from: `'self'`,
  `data:`, `blob:`, the environment's bucket, the `BANK_ASSETS_URL` base,
  `https://img.clerk.com` (avatars) and `https://i.ytimg.com` (YouTube
  posters). It stays report-only.
- **Scripts, enforced on the Worker's pages.** The share, summary and error
  pages the site Worker renders are also sent with an enforced
  `Content-Security-Policy` (`pagePolicy`):
  - `script-src` names only `'self'`, Clerk's packages on its frontend API
    (`https://{host}/npm/@clerk/`, the host decoded from
    `VITE_CLERK_PUBLISHABLE_KEY`, and a key that names no plain host fails the
    build; shared quizzes and flashcard sets load clerk-js from it) and this
    PostHog project's script assets (`/static/` and
    `/array/{VITE_POSTHOG_KEY}/config.js` on the host posthog-js loads them
    from, `src/lib/posthogHost.ts`: `https://{eu|us}-assets.i.posthog.com` for
    PostHog Cloud, the proxy itself otherwise). No `'unsafe-inline'` and no
    `'unsafe-eval'`: the Worker adds the SHA-256 of each inline script its own
    template holds, so markup a render writes into the page never runs. A
    build's `share.html` and `summary.html` (the error pages' template) hold
    one, the classic theme script, kept inline so the page paints in the
    chosen style and theme from the first frame instead of after its bundle
    loads (Epo 2026-10-17; Vite would bundle a module script into the entry).
    The templates are never pages of their own: `/share.html`, `/summary.html`
    and `/summary` run the Worker first and answer the 404 page.
    The dev server's templates also carry React's refresh preamble. The SPA's
    and the share pages' scripts set Zod to `jitless` first
    (`src/lib/zodJitless.ts`), so Zod never probes `new Function` (the summary
    and error pages' script builds no schema);
  - `script-src-attr 'none'` (no event-handler attributes),
    `worker-src 'self' blob:` (clerk-js's timer worker),
    `style-src 'self' 'unsafe-inline'` (the Worker inlines the page's CSS;
    MathLive and Mermaid write style attributes),
    `frame-src` `VITE_EMBED_ORIGIN` and `https://www.youtube-nocookie.com`,
    `form-action 'self'`, `object-src 'none'` and `base-uri 'none'`;
  - `frame-ancestors 'self'`: only the app may frame these pages, and
    nothing in it does today, so an outside site (an LMS, a blog) cannot
    embed a shared quiz or note.

  The SPA gets the same `script-src` report-only, inside its image header,
  plus `https://challenges.cloudflare.com` (Clerk's Turnstile on sign-up) and
  `https://apis.google.com` (the Drive picker), to learn what the app itself
  would need before anything there is enforced.

Go's own HTML behind `/api/*` (the unsubscribe page) has no images and no
policy. The values reach the pages two ways:

- Workers Assets serves the SPA's HTML, so the client build appends a `/*`
  rule to `dist/_headers` (after `public/_headers`) with the report-only
  `appPolicy`. With `html_handling: "none"`, every SPA page, `/` included, is
  the single-page-application fallback, so the whole SPA's policy rests on
  Workers Assets applying `_headers` to that fallback, which only a deployed
  check can see (UAT checklist §7). If it does not, the fallback plan is to
  run the site Worker first on every path but the static files
  (`run_worker_first` with exclusions such as `!/assets/*`) and set the
  header there, at the cost of one Worker call per page load. Rules after it
  detach the header (`! Content-Security-Policy-Report-Only`) from the static
  files (`/assets/*`, `/icons/*`, `/mathlive/*`, `/favicon.svg`): only
  documents and workers apply a policy, and on every chunk, stylesheet and
  font it cost about 18 KB of headers per shared page. The worker scripts
  under `/assets/` (drafts, source analysis and PDF.js, CSV, DOCX, export,
  the Office engine) therefore run without it.
- Worker responses get no `_headers`, so the share, summary and error pages
  the site Worker renders read both values from the share renderer bundle
  (`IMAGE_POLICY` and `PAGE_POLICY`, `src/share/server.tsx`) and set them in
  `workers/site/handler.ts`, on GET and HEAD alike.

Nothing is set by hand. The hosts come from configuration:

- the bucket from `B2_BUCKET` and `B2_ENDPOINT`, addressed like Go's
  presigner: `https://{bucket}.{endpoint host}`, or the bucket's path on the
  endpoint when `B2_FORCE_PATH_STYLE=true`. The manifest gives these three to
  the `build` target;
- the bank from `VITE_BANK_ASSETS_URL`, which `scripts/env/config.py` builds
  from `BANK_ASSETS_URL`: its origin, or its path on the host when the base
  has one (a shared host such as `f003.backblazeb2.com/file/…`);
- Clerk, PostHog and the embed frame from the variables the SPA build already
  reads (`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_POSTHOG_KEY`,
  `VITE_POSTHOG_HOST`, `VITE_EMBED_ORIGIN`);
- reports from both policies go to the `capy-web` Sentry project's security
  endpoint, derived from `VITE_SENTRY_DSN` and tagged with `VITE_APP_ENV`
  (`https://{host}/api/{project}/security/?sentry_key=…&sentry_environment=…`).

A `uat` or `production` build (`VITE_APP_ENV`) fails when `B2_BUCKET`,
`B2_ENDPOINT` or `VITE_SENTRY_DSN` is empty, so a deployed policy always names
its bucket and reports somewhere. Local and e2e builds may leave them out; a
policy without a DSN only logs to the browser console. Each report carries the
page's full path, so a report from a shared page includes its link token;
Sentry scrubs those paths (§5 step 9).

A new image host goes into `imageSources` (and its test) before any page uses
it; a new script or frame host on a public page goes into `scriptSources` or
`pagePolicy` (and `workers/site/scriptPolicy.test.ts`) first, never as
`'unsafe-inline'` or `'unsafe-eval'`. A blocked script shows in the console as
`Refused to load the script` or `Refused to execute inline script`, and as a
`capy-web` security report. The HTML embed frame, the Office runtime and Ops
keep their own policies (§2.3, `workers/office/_headers`, the Ops application
below).

---

## 3. Origin lockdown

Until this is done, `CF-Connecting-IP` is forgeable and every IP-keyed rate
limit — edge and application — can be bypassed by hitting the origin directly.

Pick one:

- **Cloudflare Tunnel (recommended).** Coolify: §1.1, tunnel → proxy `:80`.
  Bare compose: §1.2, tunnel → `:8080` / `:1234`. The origin needs no inbound
  ports and its IP is never published.
- **Firewall allowlist.** Restrict :80/:443 to Cloudflare's published IP ranges
  and enable **Authenticated Origin Pulls**. Requires re-checking the ranges
  periodically.

### 3.1 Host lockdown: SSH and firewalls

Both hosts' SSH and firewall settings are code: `deploy/ansible/app-host`
(the UAT Coolify host, and the production one) and `deploy/ansible/ingest-host`.
A rebuilt host gets them back from one playbook run, and a host changed by
hand drifts back on the next one.

**SSH, both hosts: key-only.** Both playbooks install
`deploy/ansible/shared/sshd-key-only.conf` as
`/etc/ssh/sshd_config.d/10-capy-key-only.conf`: `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password` and
`X11Forwarding no`. sshd keeps the first value it reads and Debian's
`sshd_config` includes its drop-ins before its own settings, so this file wins
over the stock `PermitRootLogin yes` and over a cloud image's
`50-cloud-init.conf`. The copy is checked with `sshd -t -f`, and the handler
runs `sshd -t` on the whole configuration before it reloads sshd; a reload
keeps open sessions. The play refuses while root has no authorized key. On the
ingest host it also removes the old `90-capy-ingest.conf`, which kept password
logins on. Port 22 stays open to all: restricting it to an admin or WireGuard
range is not decided. Ansible itself connects as root with a key.

**App host firewall: ufw.** The playbook installs ufw and enables it at boot,
denying inbound by default and allowing outbound. What stays reachable:

- SSH on 22, from anywhere, IPv4 and IPv6. Coolify manages its own host over
  SSH from its container, so a later restriction must keep the Docker bridges.
- WireGuard on UDP 51820, from the ingest host's public address only.
- Loopback and established traffic (ufw's built-in rules). `cloudflared` only
  connects out, and the Coolify proxy serves the tunnel on `localhost:80`.
- The database, Redis and gateway published on the WireGuard address, which
  the ingest host reaches over the link (and GitHub runners through it, by SSH
  to the ingest host). Docker forwards published ports before ufw sees them,
  so ufw neither blocks nor protects them.

That last point is why the public interface needs its own rule. The playbook
appends a `DOCKER-USER` block to ufw's `after.rules` (IPv4) and `after6.rules`
(IPv6) that drops every new connection arriving on the public interface (the
default route's, `eth0` on the UAT VM) for any container, whatever the port or
protocol: Traefik's 80 and 443 (TCP and UDP), Coolify's 8000, 6001 and 6002, and
any port a compose file publishes later. Replies to the containers' own
outbound connections, the cloudflared tunnel among them, are not new and pass.
ufw creates and refills the chain at boot and on
every reload, and Docker keeps the chain's rules when it restarts, so the rule
survives both. The WireGuard address's services, traffic between containers
and the tunnel's loopback hop are not on the public interface.

**Ingest host firewall: nftables.** `templates/nftables.conf.j2` stays the only
firewall there (no ufw beside it). Its input chain drops by default and accepts
loopback, established traffic, ICMP, SSH on 22 (open to all), the WireGuard UDP
port and everything arriving on `wg0`. Its forward chain's drop policy keeps
any port a container publishes closed, TCP and UDP, IPv4 and IPv6: the job
DOCKER-USER does on the app host. `nftables.service` loads it at boot and Docker
never edits the table. The output chain's parser rule is §7.4.

`pipeline/tests/test_host_hardening.py` keeps all of this in the playbooks.

**Applying, lockout-safe.** Run from the playbook's directory with its ignored
`inventory.yml` (the README lists the values). The `ssh` and `firewall` tags
apply only these tasks. Use them on hosts that already run: a full ingest-host
run also rewrites `/etc/docker/daemon.json` and restarts Docker when it differs.

1. Prove the key works before anything else:
   `ssh -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no root@<host> true`.
2. Open a root session on the host and keep it open until step 5. An
   established session survives the sshd reload and ufw's enable. The
   provider's console is the fallback.
3. Review, then apply:
   ```bash
   ansible-playbook playbook.yml --tags ssh,firewall --check --diff
   ansible-playbook playbook.yml --tags ssh,firewall
   ```
   A check run cannot evaluate the ufw tasks on a host without ufw. Install
   it first there (`apt-get install ufw`); it stays inactive until the play
   enables it.
4. In a second terminal, log in again with the key, and confirm a password
   login is refused before it asks: `ssh -o PubkeyAuthentication=no root@<host>`
   answers `Permission denied (publickey)`.
5. Verify, then close the first session:
   - `sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '`
     prints `without-password`, `no`, `no`.
   - App host: `ufw status verbose` shows `active`, `deny (incoming)`, 22/tcp
     open to all (v4 and v6) and 51820/udp from the ingest host;
     `iptables -S DOCKER-USER` and `ip6tables -S DOCKER-USER` each list one
     `--ctstate NEW` drop on the public interface; from outside, port 8000 and
     443/udp on the host's public address time out while the app hostnames
     still load through the tunnel; from the ingest host,
     `curl --fail http://<app WireGuard address>:8080/healthz` answers;
     `pnpm review:uat:smoke` passes; Coolify's dashboard loads, its server
     validates and a deploy runs; `journalctl -k --since -15min | grep 'UFW BLOCK'`
     shows nothing arriving from `docker0` or a `br-` bridge.
   - Ingest host: `nft list table inet capy_ingest_filter` is unchanged, and
     the next Deploy ingest (SSH as the service account) succeeds.

**Rolling back.** SSH: delete `/etc/ssh/sshd_config.d/10-capy-key-only.conf`
and `systemctl reload ssh` from the open session or the console. ufw:
`ufw disable` stops filtering inbound; it also sets the `FORWARD` policy to
`ACCEPT`, so put Docker's back with `iptables -P FORWARD DROP` and
`ip6tables -P FORWARD DROP`. The `DOCKER-USER` drops stay until
`iptables -F DOCKER-USER` and `ip6tables -F DOCKER-USER`; remove the
`CAPY DOCKER-USER` block from `/etc/ufw/after.rules` and `after6.rules` to keep
them off after a reboot. The ingest host's nftables rules are unchanged by this
playbook revision.

---

## 4. Backblaze B2

1. Create the bucket **private**. Public buckets make every presigned URL
   pointless.
2. Create an application key **scoped to that bucket only**, with
   `listBuckets`, `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`.
   Record `B2_KEY_ID` / `B2_APP_KEY` — the secret is shown once.
3. Set `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_PRESIGN_TTL` (default
   900 s: upload PUT lifetime and the reservation deadline completion checks,
   so it must cover a slow full-size upload) and `B2_LINK_TTL` (default 300 s:
   read links, which the browser fetches as soon as they land).
4. **CORS rules on the bucket.** The browser uploads directly to B2 via
   presigned PUT (the only source upload path), so B2 itself must allow the
   SPA origin. Apply the file for the bucket's environment rather than
   hand-writing rules:

   | Bucket             | File                       | Origins                                            |
   | ------------------ | -------------------------- | -------------------------------------------------- |
   | production         | `deploy/b2-cors.prod.json` | the production SPA                                  |
   | UAT (local shares it) | `deploy/b2-cors.uat.json` | UAT SPA, the tunnelled dev origin, `localhost:5173` |

   `PresignPut` sends only `Content-Type`, so the allowed headers do not grow
   as the app does. `etag` must be exposed or upload completion cannot verify
   what was stored.

5. **Lifecycle rule:** delete unfinished large-file uploads after 1 day. An
   aborted multipart upload is billed indefinitely and is invisible in the
   bucket listing. `deploy/b2-lifecycle.prod.json` and
   `deploy/b2-lifecycle.uat.json` hold the same rules — the split exists so
   each bucket is applied from its own file, not because the policies differ.
6. Leave file versioning off, or set versions to expire after 1 day. With
   versioning on, the blob reaper's deletes only hide objects and storage grows
   without bound.
7. **Read links set the response headers.** A short-lived read link asks the
   bucket for `response-content-type` and `response-content-disposition`
   (`blob.ReadHeaders`): the type from the key's extension, `inline` for PDF,
   raster images and audio, `attachment` for everything else. B2 has to
   honour both overrides, or a file comes back with the type its uploader
   declared. Check it after each deploy that changes `server/internal/blob`
   ([UAT checklist §5](uat-activation-checklist.md#5-data-and-money)) with a
   GET that prints only the headers, `curl -s -o /dev/null -D - "$url"`: the
   link is signed for GET, so a HEAD (`curl -I`) is refused with a 403. The
   bucket also appears in the app's image policy (§2.4), so `B2_BUCKET`,
   `B2_ENDPOINT` and `B2_FORCE_PATH_STYLE` reach the SPA build too.

Do **not** put a current-object B2 lifecycle rule on `captions/` or
`derived-text/`. Their database references and the blob reaper own cleanup;
unused reuse caches default to 90 days. The retired `previews/` and
`parse-bundles/` prefixes remain covered by the report-only orphan sweep.
Migration `0038` releases registered parse bundles through the deletion outbox
with a 15-minute reader grace; hidden versions follow the bucket lifecycle.
For this migration, finish the measurement baseline and its cleanup, verify the
target environment has no pending/running parse, ingest or source-refresh jobs,
then stop its old parse coordinator and ingest worker before deploying the app.
Keep them stopped until **Deploy ingest** activates the matching new release.
Preparation accepts existing stopped consumers only at the recorded previous
SHA; the parser and newly activated consumers must still be running.
An old coordinator could otherwise upload a ZIP after migration deleted the
cache rows, fail the new cache-kind constraint, and leave an unregistered object.
The existing rule requiring local consumers to stop before changing the shared
nonproduction parser still applies. If deployment fails after migration 0038
commits, keep old consumers stopped while recovering the new release.

The required parse ZIP handoff stays in the parser/worker shared local volume.
The coordinator validates the local ZIP before handing it to ingest and never
copies it to B2. A job retains its verified source, and the ingest continuation
its bundle, across capacity waits and retries, then deletes them after
committed success or terminal failure. The worker's 5-minute idle sweep removes
leftovers older than `CAPY_PARSE_SPOOL_TTL_HOURS` (default 2) that no pending or
running job names. This release replaces `CAPY_PARSE_ZIP_TTL_HOURS` and
`CAPY_PARSE_SOURCE_TTL_HOURS`; delete either from GitHub environment variables
or host env files if it was ever set.

### 4.1 Knowledge-base bucket

The shared knowledge library's book PDFs live in their own bucket, not a prefix
of the app bucket, because the library is shared by UAT and production. The
deployed retrieval service holds a read-only key; only the loader on the
developer PC holds a key that can write.

1. Create the bucket `capy-notebook-knowledge-base`, **private**. It holds one
   object per book at `books/<sha256>.pdf`; nothing else writes into it.
2. Two application keys, each **scoped to that bucket only**; each secret is
   shown once:
   - **Reader**, `listFiles` and `readFiles`: the retrieval service's
     `KNOWLEDGE_BASE_B2_KEY_ID`/`KNOWLEDGE_BASE_B2_APP_KEY`, in UAT and
     production alike. Because the bucket is shared, a writable key here would
     let either environment change the books every tenant renders.
   - **Writer**, `readFiles` and `writeFiles`: only in the developer PC's
     ignored `.env.local` as `KNOWLEDGE_BASE_B2_WRITER_KEY_ID` and
     `KNOWLEDGE_BASE_B2_WRITER_APP_KEY`, for the builder's source upload. It
     never goes to GitHub, Coolify or a host; a CI test fails if any deploy
     file names these variables.

   To rotate (and when moving from the former single writable key): create the
   new key, push it, redeploy retrieval in UAT and production, confirm a
   library page capture works, then delete the old key in B2.
3. Endpoint `https://s3.eu-central-003.backblazeb2.com`, region
   `eu-central-003` — the same B2 region as the app bucket.
4. No CORS rules and no lifecycle rule. The browser never touches this bucket:
   `capture_knowledge_page` renders a page server-side and the books are
   permanent.
5. The five variables are **all or none**, enforced at import of
   `pipeline.config`: set all five and `capture_knowledge_page` is offered;
   set none and the tool is simply unoffered. A **partial set raises while the
   module is imported**, so the retrieval service — the only service that
   declares these five, under `retrieval` in both Compose files — fails to
   start, which stops chat and generate in that environment. The ingest
   host's workers never receive them, so ingest keeps running. Paste all five in
   one save, or none:

   | Variable                     | Value                                        |
   | ---------------------------- | -------------------------------------------- |
   | `KNOWLEDGE_BASE_B2_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com`  |
   | `KNOWLEDGE_BASE_B2_REGION`   | `eu-central-003`                             |
   | `KNOWLEDGE_BASE_B2_BUCKET`   | `capy-notebook-knowledge-base`               |
   | `KNOWLEDGE_BASE_B2_KEY_ID`   | the reader key's id                          |
   | `KNOWLEDGE_BASE_B2_APP_KEY`  | the reader key's secret                      |

   All five carry the manifest targets `coolify` and `local` and are
   `required_for` `coolify`, so a UAT or production render fails when any is
   missing from GitHub; only `KNOWLEDGE_BASE_B2_KEY_ID` and
   `KNOWLEDGE_BASE_B2_APP_KEY` are manifest secrets, the other three are plain
   variables. Push them with `scripts/env/config.py push` from a file that
   holds only the keys being set (a blank value deletes the GitHub entry);
   `deploy/.env` carries them for the local stack. The library builder and
   loader on the developer PC read the same five names, plus the two writer
   variables, from the ignored project-root `.env.local`. Nothing else in the
   stack needs them.

### Ingest worker replicas

The dedicated-host Compose file defaults to four `worker` containers. Each
claims only `ingest` rows and runs exactly one direct-route or post-parse job.
Each has a 1 CPU, 1 GiB RAM, 1.25 GiB memory-plus-swap, and 128-process hard
ceiling. Embedding and summary calls are sequential inside each job; their
host-wide concurrency is at most four. PDF jobs open the source or repaired PDF
with PyMuPDF for heading retention and extraction confidence. Office jobs use
the page evidence frozen in the PDF-free v5 bundle. These are limits, not reserved
capacity; idle containers use little CPU or memory. The legacy app-host
debugging profile still defaults to one worker.

One `parse-coordinator` container supervises four child processes, each
claiming one `parse` row. Its container limit is 1 CPU, 512 MiB RAM, 768 MiB
memory-plus-swap, and 128 processes. A child spends most of its lifetime
waiting on the parser. It has two-connection sync and async pool ceilings; each
ingest worker retains the ordinary four/eight limits. `claim_job` filters by
type and uses `FOR UPDATE SKIP LOCKED`, so the pools never consume one another's
work.

Provider rate limits scale only with ingest workers. Parse coordinators have no
provider keys and accept only exact-vector donor reuse, so a donor requiring
re-embedding stays on the parse path and is handled later by ingest.

> B2 egress is **not** in `usage_events` — the browser fetches presigned URLs
> directly and the gateway never sees the transfer. B2's own reporting is the
> only source. Set a spend alert.

---

## 5. Sentry

1. Create the organization in the **EU region**. The storage location is fixed
   at creation, projects cannot be transferred between regions, and moving
   means a whole new organization.
2. Create two projects: `capy-web` (browser) and `capy-backend`, shared by
   `SENTRY_DSN_GATEWAY`, `_RETRIEVAL`, `_WORKER`, `_COLLABORATION`, and the
   ingest host's `SENTRY_DSN`. Those four separate by the `service` tag each
   already sets. Add `capy-ops` when the Ops application is deployed (§8) — operator
   failures must not share product alert rules — and set `SENTRY_DSN_OPS` for
   the Go process and `VITE_SENTRY_DSN_OPS` for its browser build. A browser
   DSN is public and belongs only to a browser project.
3. UAT and production share these projects and separate by environment. Set
   `SENTRY_ENVIRONMENT=uat` in the UAT resource: its `APP_ENV` stays
   `production` (§12.2), so without this its errors land in production's
   bucket. Scope every alert rule to an environment.
4. For source map upload, set the `uat` / `production` environment secret
   `SENTRY_AUTH_TOKEN` (scopes: `project:releases`, `org:read`) and the
   variables `SENTRY_ORG`, `SENTRY_PROJECT=capy-web`, and
   `SENTRY_URL=https://de.sentry.io/`. The EU region needs that host; the US
   default uploads nothing the organization can resolve. Without maps every
   browser stack trace is minified and useless. `RELEASE_SHA` /
   `VITE_RELEASE_SHA` must be set for the upload to attach to a release.
5. Turn on **"Prevent Storing of IP Addresses"** in Security & Privacy. The
   SDK's `send_default_pii: false` stops the client sending one; confirm the
   server is not inferring it from the request.
6. Set an **inbound filter** for `AbortError` as a second line of defence
   behind the client-side `ignoreErrors`.
7. Set a spend cap. Default sampling can burn a month's quota in a day during
   an incident, which is exactly when reporting must not stop.
8. The app's page policies (§2.4) report to `capy-web`'s security endpoint,
   tagged by environment. Keep the project's default ignored sources for CSP
   reports on (Settings → Security Headers: browser extensions and local
   schemes), so extensions that inject images do not file reports. A report
   carries the full path of the page it came from, and on a shared page
   (`/share/{kind}/{token}`, `/w/{id}.{signature}`) that path holds the
   link's token.
9. Scrub share-link tokens before Sentry stores them: Settings → Security &
   Privacy → Advanced Data Scrubbing → Add Rule, method **Replace**, data
   type **Regex Matches**, source `$string`, regex
   `/(?:share|p)/(?:quizzes|flashcards|notes)/[^/?#\s"]+|/w/[^/?#\s"]+`.
   Do it once per project that receives browser reports (`capy-web`), before
   the first deploy that sends the policy; a report from a shared page should
   then show `[Filtered]` where the path was.

---

## 6. PostHog

No project exists for local or UAT, and none is needed: an unset
`VITE_POSTHOG_KEY` leaves capture, identify, pageviews, and flags inert. Do this
at production launch.

1. Create a project on the **EU** host. A region move afterwards is a support
   ticket on a paid tier.
2. Set `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`.
3. Under project settings, **enable "Authorized URLs"** for `https://app.capynotebook.com`
   only, or anyone can post events into your project with the public key.
4. Do **not** enable autocapture or session replay defaults in the UI; both are
   configured in code and the UI settings will override intent silently.
5. Verify once before launch — `identify`, one `$pageview`, one custom event —
   with a throwaway key, since nothing has exercised this path before.

---

## 7. Dedicated ingest host

The Netcup ingest host runs the parse coordinator, ingest workers, parser, and
host sampler, and the Drive/OneDrive import worker. Browser uploads go straight
to B2 and imported files are streamed into B2 by the import worker here; source
bytes do not traverse the Go application process.
Coordinator, worker, and parser containers mount the same `parse_spool` volume.
The compose init service gives the unprivileged pipeline user access before
those services start.

1. Apply `deploy/ansible/app-host/playbook.yml` to build the app side of the
   point-to-point WireGuard service network (it also sets the app host's
   firewall and key-only SSH, §3.1), then put its displayed public key
   in the ingest-host inventory. The app host uses `10.77.0.1/32` and the ingest host
   uses `10.77.0.2/32`. Netcup's
   [community WireGuard guide](https://community.netcup.com/en/tutorials/how-to-setup-wireguard-ubuntu)
   covers the provider-specific setup and applies to Debian. Do not add a
   default route, DNS override, NAT, or forwarding: this tunnel carries only
   parser HTTP, Postgres, Redis, and the gateway's `:8080` for the import
   worker.
2. On the app host, set `CAPY_PRIVATE_BIND_ADDRESS=10.77.0.1` before deploying
   this branch. The app-host playbook stops the confirmed-unused native
   PostgreSQL cluster but preserves its files under `/var/lib/postgresql`.
   `deploy/docker-compose.prod.yml` publishes Capy Notebook Postgres and Redis only on
   WireGuard. The default bind address is loopback, never the public interface.
3. Copy `deploy/ansible/ingest-host/inventory.example.yml` to ignored
   `inventory.yml`, restrict it to mode `0600`, and follow that directory's
   README. Ansible provisions the host, network, service account and selected
   watchdogs. GitHub workflows own release checkouts and application secrets.
   Choose `ingest_watchdog_stacks: [nonprod]` for UAT; production provisioning
   is a separate authorized action. Ansible refuses an active legacy stack unit.
4. Fill the matching `deploy/.env.uat` or `deploy/.env.prod` using the complete
   example and upload it with `pnpm env:push` as described in §12.7. The workflow
   derives `DATABASE_URL`, `REDIS_URL`, and `GATEWAY_URL` from that environment's
   `POSTGRES_PASSWORD` and `CAPY_PRIVATE_BIND_ADDRESS`. It supplies `PIPELINE_SECRET`
   to the import
   worker. The worker also needs `DEEPINFRA_API_KEY` for the seeded Qwen
   embedding route, `OPENROUTER_API_KEY` for the file-descriptor pin
   (DeepSeek V4 Flash 0731 held on Relace) and the captioning pin (DeepSeek
   V4.1 Flash 1017 held on DeepInfra: standalone-image captions and the VLM
   read of text-less document pages; Ops reads the key too, to flag a missing
   credential), and `ZAI_API_KEY` for GLM-5.3-Flash, the same Z.AI key the app
   host's `retrieval` and `ops` containers carry. The `uat` environment has
   `ZAI_API_KEY`; the `production` environment needs it before a production
   deploy, since the renderer writes an empty key without it. Those calls
   happen on this ingest host after it
   downloads the B2 object, never in Go. The parser binds only to
   `PARSER_BIND_ADDRESS`; its bearer token remains defense in depth. The
   parser is OpenDataLoader 2.5.7 plus the refined repairs (`parser/odl/`);
   it renders text-less pages for the worker's VLM and holds no OCR model, so
   the image needs no model files or model volume.
   Configure its platform model capacities through Ops (§1.4) before ingest.
   `CAPY_PARSE_COORDINATOR_CONCURRENCY` is a production-only input listed in
   `.env.prod.example` and `ingest-host.env.example`; local/UAT Compose fixes it at one.
   Production limits are eight coordinator processes, seven parse children
   (`CAPY_PARSE_WORKERS`), parser depth 8 (`CAPY_PARSE_QUEUE_DEPTH`, parsing
   plus waiting) and 500 text-less pages per document
   (`CAPY_PARSE_OCR_PAGE_CAP`, a name older than the VLM read; more fails as
   `parse_too_many_scanned_pages`). `CAPY_PARSE_MAX_PAGES` (1,400)
   caps pages per document. Both page caps are GitHub environment variables
   rendered to Coolify (the API serves them in the upload policy) and to the
   ingest host (the parser enforces them), so one value feeds both; the
   manifest marks them required for both targets, and the API, the prod
   Compose and the ingest Compose refuse to start without
   `CAPY_PARSE_MAX_PAGES`. Set `CAPY_PARSE_MAX_PAGES=1400` and
   `CAPY_PARSE_OCR_PAGE_CAP=500` in the `uat` and `production` GitHub
   environments before deploying this change. The default time hierarchy is
   a 600-second per-document deadline (`CAPY_PARSE_DOCUMENT_TIMEOUT`), a
   1,320-second parser request (`PARSER_TIMEOUT`: one 600 s wait for a parse
   child, the 600 s parse and 120 s, see agentic-retrieval's Parse capacity)
   and a 1,500-second parse job (`CAPY_PARSE_JOB_TIMEOUT`). Its ingest continuation has a separate
   20-minute bound. Queue wait does not spend the parse deadline. The job worker
   refuses to start with a `PARSER_TIMEOUT` that is not below `CAPY_PARSE_JOB_TIMEOUT`;
   retrieval, which reads `PARSER_TIMEOUT` only for page captures, does not check it. The parser container
   gets 8 CPUs, 14 GiB RAM, 18 GiB memory plus swap and a per-document JVM
   heap of `CAPY_PARSER_JVM_MAX_HEAP` (1g; 1g to 8g made no speed difference on
   15 to 1,220 pages). The coordinator writes the raw source to
   `parse_spool` while hashing it, the parser atomically publishes the
   fingerprint zip there, and an ingest worker extracts it locally. There is no
   parse method knob; `parseMode` is `fast` or `none`.
5. Provision a persistent 24 GiB swapfile as emergency headroom for large
   documents. The steady-state target is still zero swap use:

   ```bash
   fallocate -l 24G /swapfile
   chmod 600 /swapfile
   mkswap /swapfile
   swapon /swapfile
   grep -q '^/swapfile none swap sw 0 0$' /etc/fstab || \
     printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

   Verify with `swapon --show --bytes` and `free -h`. Do not interpret available
   swap as permission to raise the queue depth or run documents concurrently.

6. On the first **Deploy ingest** run, select `bootstrap`. That workflow warms
   the candidate parser, then activates its matching coordinator, ingest worker,
   import worker and sampler. It refuses unless the backend already serves the
   same SHA, so deploy the app first.
   Verify parser `/healthz` through WireGuard. It must return HTTP 200 with `ok=true`,
   `state=ready`, and a `release_sha` equal to the app's deployed revision. No
   parser port may listen on the public address.
7. Parse the lab corpus through the new service and compare block sequences
   with the refined outputs under
   `/opt/capy-odl-third-pass-20260909/refined-final-r1/<source>/` on the ingest
   host; every source must match. Record wall time (the 610-page textbook is
   about four minutes), peak RAM and swap.
8. App deployment and ingest are separate workflows: **Deploy UAT** builds the
   site, applies GitHub config to Coolify, deploys the backend and publishes the
   Workers, and never touches the ingest host. Deploy the app first, then run
   **Deploy ingest**, leaving `revision` blank so it resolves the SHA from the
   backend's own `X-Capy-Release`; it then verifies the backend still reports
   that revision before it pauses consumers. Name a revision only to override
   that, and expect it to fail unless the backend already serves it. Prepare and activate share one job
   and one release owner, so its exit trap settles any pending release the run
   created — either activating the candidate or restoring the previous snapshot
   from the live backend SHA. A run killed before that trap leaves pending
   behind for `reclaim_pending` to adopt. For `production`, the run first
   calls the **Parser budget** workflow on the same revision (about 25
   minutes; `bench/parsers/README.md`, "Parser budget") and does not touch
   the host unless it passes; UAT runs skip it.

The ingest checkout, Compose files, and config renderer stay pinned to the
backend revision. The SSH release wrapper and remote release script come from
the immutable commit that dispatched the workflow, so recovery fixes can run
against an older application release. After pushing a release-script fix,
start a new **Deploy ingest** run from `main`; rerunning an old Actions run
keeps its old workflow commit. To recover an existing pending release, keep
the backend on that release's candidate or previous SHA and select
`reclaim_pending`.

Each stack has its own checkout and durable release state:

| Target | Checkout | State |
| --- | --- | --- |
| Production | `/opt/capy-ingest/app` | `/opt/capy-ingest/releases/production` |
| UAT | `/opt/capy-ingest/app-nonprod` | `/opt/capy-ingest/releases/nonprod` |

`active` contains the committed SHA. `current` points to an immutable
`config-<run-id-attempt>` directory. `pending` records its owner, candidate,
previous SHA and snapshot links; `operation.lock` serializes mutations. The
workflow never invents a previous SHA or prunes another stack's images/volumes.
Every release builds a new `<project>-parser:<sha>` / `<project>-pipeline:<sha>`
pair on the host; activation then removes this stack's other tags, keeping
only `active` and `previous` (rollback). Removed tags stay in the BuildKit
cache; activation then runs `docker builder prune -f --filter until=72h`, which
drops build cache older than three days (the next release still builds warm).
The ingest host's `/etc/docker/daemon.json` also sets `builder.gc` to 20 GB, so
BuildKit trims the cache past that size between releases. The ingest-host
playbook writes it (a hand fix on 2026-10-19 restored it after a playbook run
had dropped it; the file from before is kept as
`daemon.json.before-builder-gc-20261019`).
Bootstrap only clones into an absent/empty checkout and records active after
verification. A failed bootstrap stops candidate services and retains evidence.

Docker `restart: unless-stopped` restarts the deployed containers with their
existing images and environment after a reboot. There is no second systemd
Compose launcher. The per-stack watchdog checks the same active/pending state
and lock before restarting an unhealthy existing parser.

For a failed or canceled deployment, inspect the exact Coolify deployment and
live backend revision before invoking recovery with the original run owner.
Cancelling a run does not signal the remote script (no tty), but its next
parser poll write fails and exits through cleanup, so `operation.lock` is free
within about 15 seconds. `pending` keeps the original owner, so the next run
stops at `another release is pending`. Re-dispatch Deploy ingest with
`reclaim_pending` ticked: every workflow that reaches the host shares one
concurrency group, so that owner is a finished run, and the host applies the
usual recovery rules under it before preparing. A backend at the candidate
resumes preparation using the candidate configuration: stop consumers, start
the parser, wait for health, then activate consumers. This also covers a failure
before the previous consumers stopped or `current` switched snapshots. Every
candidate Compose command, including `stop`, uses the candidate env snapshot
because Compose interpolates the checked-out file before executing commands.
A bootstrap without a matching backend, or a backend at the previous revision,
rolls back; anything else stops. Compose query errors fail immediately rather
than being reported as a pending parser. A parser that restarts three times
also fails the wait immediately; read its logs on the host.
Do not delete pending state or blindly roll back only ingest. After committed
activation, promote the previous compatible revision through the whole app
workflow; this does not reverse database migrations automatically.

### 7.1 Production and non-production ingest-host storage

Production keeps the explicitly named `capy-ingest_parse_spool` volume. The one
local/UAT project uses `capy-ingest_nonprod_parse_spool` through
`deploy/docker-compose.ingest-host.nonprod.yml` and never mounts the production
volume. Docker named volumes grow only as files are written, so this setup
reserves no fixed number of bytes for nonproduction. The ordinary
source/artifact sweeper bounds retained data by age instead.

Local and UAT keep separate databases, Redis instances, B2 buckets, and
provider credentials. Their queue consumers run in one nonproduction Compose
project and point to one parser process. Each profile also runs a sampler
against its own database. It reports that environment's durable queue and the
shared parser pool, but deliberately omits physical-host CPU, RAM, disk, and
network so the same host is not attributed to both environments. Queue consumers take role-specific
file locks on the shared spool before claiming a row. Across local and UAT,
only one parse job and one ingest job can run at a time. A
consumer that cannot take its role lock leaves the database row pending. The
lock descriptor closes automatically if its process or container dies.

Compose hard-codes per-consumer coordinator concurrency to one and the parser
queue depth to two. It also hard-codes the shared capacity-lock path,
so environment files cannot raise the global parse or ingest limit. The parser
gets 2 CPUs, 6 GiB RAM, 8 GiB total memory plus swap and a 3g JVM heap. Each coordinator gets
0.5 CPU, 384 MiB RAM, and 512 MiB total. Each worker gets 1 CPU, 1 GiB RAM, and
1.25 GiB total. Local and UAT each need an idle queue consumer because one
process cannot connect to two databases, but the locks allow only one consumer
per role to do job work. These resource values are hard container ceilings,
not reservations.

The UAT workflow writes `nonprod.env` and `uat.queue.env` into the current
immutable snapshot. Keep only the local lane's `local.queue.env` at
`/opt/capy-ingest/local.queue.env`, mode `0600`, owned by `capy-ingest`. Its
private Postgres/Redis routes, test B2 bucket and provider credentials belong to
local development. UAT deployment never overwrites that file.

After a UAT release is active, local consumers can use its same parser revision:

```bash
cd /opt/capy-ingest/app-nonprod
export CAPY_INGEST_UAT_ENV_FILE=/opt/capy-ingest/releases/nonprod/current/uat.queue.env
docker compose -p capy-ingest-nonprod \
  --env-file /opt/capy-ingest/releases/nonprod/current/nonprod.env \
  -f deploy/docker-compose.ingest-host.nonprod.yml --profile local \
  up -d --no-build --no-deps parse-coordinator-local worker-local import-worker-local host-sampler-local
```

Stop those four local consumers before the next UAT release. The workflow
refuses to change their shared parser while they run. Resuming them afterwards
uses the newly committed revision; it never rebuilds or changes the parser.
The standalone full-local Docker Compose lane remains available for schema work.

Do not add `-v` to `down`: that would request deletion of project volumes. The
shared spool has an explicit name, but treating destructive volume flags as safe
would be a bad operational habit. The default app-host Compose worker is behind
the `app-host-ingest` profile; normal local ingest must use this ingest-host stack so the
worker and parser actually see the same filesystem.

A hard-timeout or OOM marker lives under `quarantine/{fingerprint}.json` in the
owning spool. It makes the offending file terminal for that exact parser
version while Docker restarts the parser container for collateral jobs. Do not
manually clear the marker just to force a retry. Reproduce and fix the parser,
then deploy a new release; the versioned fingerprint changes automatically.
Manual removal is only for an operator-confirmed false marker where the
underlying parser version has not changed.

### 7.2 Parser capacity and failure handling

The parser parses five documents at once (`CAPY_PARSE_WORKERS`, one per parse
child). Depth 8 counts the documents in a parse child plus the waiting ones;
one more concurrent request gets `429`, and the coordinator re-pends it as a
capacity wait. A parse child renders a document's text-less pages as JPEGs
into the bundle; the ingest worker's captioning-slot VLM reads them (at most 20
calls in flight across the host), so the parser has no OCR stage or OCR
backlog. The parse child counts each document's pages before parsing it, and
the API process opens no source, and no file a child wrote, with MuPDF. A
document with more than 500 text-less pages fails as
`parse_too_many_scanned_pages` (terminal), one with more than 1,400 pages
as `parse_too_many_pages`, and one past the element limits (figures, vector
shapes, Office rows or shapes; `odl/elements.py`) as `parse_too_many_elements`. The OpenDataLoader accuracy record is the September 2026 series
under `bench/parsers/reports/` (`2026-09-09-odl-accuracy-third-pass.md` and the
per-repair experiments it cites); the acceptance oracle is the refined corpus
on the ingest host. The capacity run found CPU and the deadline, not memory,
to be the limit: no OOM up to eight slots, about 1.45 GiB per 1,216-page book,
and at 8 slots the old 256-process limit made Java fail `pthread_create`, so
the parser's `pids_limit` is 512. The shared non-production parser keeps one
child and depth 2. The v11 stress run
(`2026-09-28-parser-v11-stress.md`) measured, with a 1g heap, Java at 0.24–1.28
GiB, a parse child at 1.46–2.12 GiB and the whole cgroup at 1.8–3.9 GiB per
document; a trimmed idle child holds about 0.55 GiB. The v14 rerun
(`2026-10-15-parser-v14-stress.md`, same shape and inputs, still with the
RapidOCR process) peaked at 8.6 of 14 GiB with five 1,400-page books and a
150-page scan at once (v11: 13.1). Each book finished in under 400 s of the
900 s deadline. One parse or OCR child
reached 1.44 GiB RSS and 4.91 GiB virtual size; most of that was the RapidOCR
process, which left the parser on 2026-10-15. With `MALLOC_ARENA_MAX=2` a parse
child peaked at 0.64 GiB of virtual size, alone on the 1,400-page book and with
five of them beside a 150-page scan (scenario C on a 14 GiB, 8-CPU container:
6 of 6 parsed, peak 7.0 GiB), and LibreOffice at 0.88 GiB, so each child runs
under a 2 GiB address-space limit (Java lifts it; its heap is bounded by
`-Xmx`).

Each of the four production ingest workers has a 1 CPU, 1 GiB RAM, 1.25 GiB
total memory-plus-swap, and 128-process ceiling. A separate 120 MiB
content-list edge test needed about 518 MiB and failed under a 512 MiB no-swap
cgroup. The 1 GiB ceiling leaves room for that allowed shape while bounding the
four-worker pool to 4 GiB of resident memory. A no-swap fault injection killed
worker PID 1 with exit 137 and Docker restarted it. The lease reaper retries
that post-parse job once from its artifact; an OOM never quarantines the file.

The production parse coordinator is a separate 1,280 MiB/1,536 MiB-total
container with eight child processes and no LLM credentials: nine Python
processes of about 81 MiB after imports, plus about 55 MiB per child while it
validates a 1,220-page content list. Eight children hold up to 32 Postgres
connections (two sync and two async each). A coordinator timeout durably
requeues its claim and exits that child; the supervisor replaces only that
child. If the kernel kills a coordinator child, its lease expires and follows
the same one-retry rule. This differs from a parser OOM: when a parse child or
its JVM dies by SIGKILL, or its LibreOffice conversion fails, while the parser
cgroup's `oom_kill` count rises, the parser writes a `parse_oom` marker for
that child's document and respawns only that child. Parse children run at
`oom_score_adj` 1000 and the API at 0, so the kernel picks a parse child first.

`restart: unless-stopped` recovers PID 1 kills, cgroup OOM kills, a Docker
daemon restart, and a full VM reboot. Ansible installs
`capy-ingest-watchdog@.service` for explicitly selected stacks. It restarts an
existing parser after three unhealthy Docker health observations. The
per-document deadline owns stuck-work detection; the watchdog does not
independently time active work. It skips absent containers and planned release
cutovers. A restart drops in-flight connections, but ordinary parser errors get
one retry and the client recovers an atomically published spool artifact when
publication completed before the disconnect.

Each document has a 600-second limit that begins when it leaves the queue,
before LibreOffice normalisation and the Java run, and ends when the API has
read the child's result, page renders included. A timed-out document is
quarantined (`parse_hard_timeout`) and its parse child is killed with its
session (Java, LibreOffice) and respawned; the other children keep running. A
LibreOffice conversion past `CAPY_OFFICE_CONVERT_TIMEOUT` is final the same
way. Hard-timeout and OOM fingerprints
are terminal without a retry. An OOM marker covers only the document whose
process the kernel killed; with several slots the kernel picks the largest
process, which may be a large document rather than the one whose allocation
tipped the cgroup over. Queued documents and all other retryable failures get
one retry.

Once parsing publishes an artifact and hands off an `ingest` row, all timeout,
OOM, provider, database, and worker-death failures use the ingest job's one
retry. Exhaustion fails that job but creates no problematic-file marker, so a
later operator/user re-ingest remains valid. A missing or corrupt handoff bundle
is removed and sent through parsing once; a second invalid bundle is terminal
to prevent a repair loop.

### 7.3 Shared library database

The knowledge library (pre-ingested open textbooks) lives in one dedicated
pgvector Postgres on this host, `capy-library-db`, shared by UAT and
production over WireGuard. It is separate from every app database and from
the lab containers, and it is not part of the release workflows: it is a
stateful service managed by hand from `/opt/capy-library-db`. It holds one
live library that every environment reads: versions are per book, so a
republished book swaps its own pointer atomically and retires the previous
version (its content rows go, its version row and receipts stay). Nothing is
pinned per environment.

1. Copy `deploy/docker-compose.library-db.yml` to
   `/opt/capy-library-db/docker-compose.yml` together with
   `deploy/library-db-init.sh` and `deploy/library-db-backup.sh`. Strip CR line
   endings if copied from Windows and mark both scripts executable.
2. Create `/opt/capy-library-db/.env` (mode 0600) from
   `deploy/library-db.env.example`, generating both passwords on the host with
   `openssl rand -hex 24`. `LIBRARY_DB_BIND_ADDRESS` is the host's WireGuard
   address `10.77.0.2`; the port is `5433` so it never collides with an app
   database. The container uses host networking like the parser, because the
   host firewall drops forwarded traffic into Docker bridges; Postgres itself
   listens on the WireGuard address and loopback, never the public interface.
   Verify with `ss -tlnp | grep 5433` and a refused probe of the public
   address from the host.
3. `docker compose up -d`, then wait for `docker inspect --format
   '{{.State.Health.Status}}' capy-library-db` to report `healthy`. The init
   hook runs once on the empty volume: it creates the `vector` extension and
   the read-only role `capy_library_reader`, with default privileges so every
   table the owner creates later is readable without a second grant step.
4. Roles and URLs. The owner `capy_library` belongs to the library loader and
   is the only role that writes. App environments use the reader:
   `postgres://capy_library_reader:<pw>@10.77.0.2:5433/library?sslmode=disable`
   (WireGuard already encrypts the hop, matching the app database URLs). The
   developer PC is not a WireGuard peer; it loads the library through an SSH
   tunnel via this host:

   ```bash
   ssh -i ~/.ssh/capy_ingest_159_195_61_195 -N -L 15433:10.77.0.2:5433 root@159.195.61.195
   ```

   and then `postgres://capy_library:<pw>@localhost:15433/library?sslmode=disable`.
   Read the passwords from the host's `.env`; they are never stored in the
   repository or in chat.
5. Backups. `/etc/cron.d/capy-library-db` runs `library-db-backup.sh` at
   03:15 Europe/Berlin (01:15 UTC during summer, 02:15 UTC during winter): a
   custom-format `pg_dump` of the library and of the bank into
   `/opt/capy-library-db/backups`, each uploaded to the private bank bucket
   (step 5 of the bank setup), keeping the two newest of each on the host.
6. Sizing. The host has 15 GiB and the parser is capped at 6 GiB; the
   container is capped at 3 GiB with `shared_buffers` 768 MB and
   `maintenance_work_mem` 512 MB. Raise `LIBRARY_DB_MAINTENANCE_WORK_MEM` for
   large HNSW builds and drop it back afterwards. Disk is on the root volume
   (about 390 GB free at setup).
7. Application access. The ops dashboard reads the library through
   `OPS_LIBRARY_DATABASE_URL` (manifest secret, target `ops`, required): put
   the `capy_library_reader` URL there and restart ops to get the read-only
   Library section; leave it empty and every `/api/ops/library` route answers
   404 `library_unconfigured`. That pool skips the app role contract because
   the library has its own schema and its own reader role. The retrieval
   service reads the same database through `LIBRARY_DATABASE_URL` (manifest
   secret, targets `coolify` and `local`, required for `coolify`); both hold
   the same reader URL. The loader keeps the owner URL through the tunnel in
   project-root `.env.local` under the same `LIBRARY_DATABASE_URL` name, so
   never copy one into the other. There is no pin variable, because UAT and
   production read the same live books.
8. Loading. The loader runs on the developer PC through the tunnel with the
   owner URL: `schema` creates the schema as `LIBRARY_SCHEMA` writes it,
   `publish --run <run> [--book <id>]` loads each book as its next version,
   retires the previous one (content rows dropped, version row and model-run
   receipts kept) and swaps its pointer, refusing a corpus identity the current
   version already holds; `remove --book` deletes a book; and `status` lists the
   books with their history. There is no rollback: undo a bad publish by
   republishing from the book's saved run. There is no migration path: a changed `LIBRARY_SCHEMA`
   means dropping the `library` database, running `schema` again and
   republishing every book. That costs one loader run and no model calls,
   because the builder's output is on the developer PC.

#### Question bank database and backups

The `bank` database shares `capy-library-db`; it has its own numbered
`server/bankmigrations` ledger. The local publisher owns `capy_bank`, while
production's API uses `capy_bank_editor`, restricted to updating question content
and review columns. UAT and local API use only `capy_library_reader`. Keep bank
schema and question-format changes readable by production before publishing new
content. Never point the ordinary app migrator at `bank`.

1. Run `deploy/bank-db.sql` as `capy_library` with `bank_password` and
   `bank_editor_password` psql variables. It creates the database and roles.
   Through the existing 15433 tunnel, set `BANK_OWNER_DATABASE_URL` in the
   publisher's ignored `.env.local` and run `go run ./cmd/bank migrate` from
   `server`, then `go run ./cmd/bank exams ../lab/questions/syllabi` to write
   the exams before publishing under them. Re-run `bank-db.sql` after migration
   to apply the column grants.
2. Set `BANK_DATABASE_URL` to the reader URL in each environment. Configure
   `BANK_EDITOR_DATABASE_URL` only in production. Hand-grant editor accounts
   in the production app database with `INSERT INTO bank_editors(user_id,note)
   VALUES ('production-user-id','review scope');`. Delete the row to revoke.
   Suspended, deleted and deletion-pending users cannot edit.
   The existing `LIBRARY_DATABASE_URL` reader resolves source book/version
   attribution for bank questions that have sources. Source-free pilot questions
   do not open that connection; unresolved credits fail explicitly.
3. Create two distinct bank B2 buckets. Public figures use content-hash names
   and a Cloudflare hostname supplied as `BANK_ASSETS_URL`. Configure the
   `BANK_PUBLIC_B2_ENDPOINT`, `REGION`, `BUCKET`, `KEY_ID`, and `APP_KEY` names
   with the full `BANK_PUBLIC_B2_` prefix in production and the local publisher.
   The API uploads on behalf of editors; credentials never reach browsers.
   Private references, run records and dumps use a separate bucket and keys;
   no private-bucket credentials belong in the API environment.

   The September 2026 setup uses `capy-notebook-question-bank-public` and
   `capy-notebook-question-bank-private` in `eu-central-003`, with S3 endpoint
   `https://s3.eu-central-003.backblazeb2.com`. `BANK_ASSETS_URL` is
   `https://bank-assets.capynotebook.com`. Its proxied CNAME targets
   `f003.backblazeb2.com`. A Cloudflare URL Rewrite Rule matching only that
   hostname rewrites the path with
   `concat("/file/capy-notebook-question-bank-public", http.request.uri.path)`
   and preserves the query. A Configuration Rule for the same hostname sets
   origin SSL to Full (strict). Stored asset URLs use the hostname root plus
   the content-hash filename. Verify a published object in a browser: HTTP 200,
   the expected image content type, immutable cache headers and a Cloudflare
   cache hit after warming.
4. Production comments require `BANK_COMMENT_EMAIL` and the existing email
   backend, sender identity and `APP_URL`. Sending is direct and user-retryable.
5. Install the updated `library-db-backup.sh` only after the bank exists. Add
   the `BANK_PRIVATE_B2_*` entries from `deploy/library-db.env.example` to the
   host's mode-0600 `.env`. Use a bucket-scoped write-only backup key. The script
   runs rclone in a container and writes `backups/library-<UTC>.dump` and
   `backups/bank-<UTC>.dump`. Apply a
   **backups-prefix-only** lifecycle rule retaining 30 days; keep references
   and run records. Verify one dump upload and restore it to a disposable
   database with `pg_restore` before relying on the cron.

Questions are retracted, never deleted, because learners' progress in each app
database names their ids. Retraction is an owner SQL operation:
`UPDATE questions SET retracted_at=now() WHERE id=...` (setting it back to
NULL restores the question). Every read skips retracted questions; the row,
shared public assets and private run records remain. Backups are the recovery
path for production edits. Restore roles with `bank-db.sql`, then restore a
selected dump as owner; restoring a dump replaces bank content with that
snapshot and requires an operator maintenance window.

### 7.4 Parser egress and LibreOffice conversion

The parser converts untrusted Office uploads with LibreOffice (7.4.7 from
Debian bookworm in `parser/Dockerfile`, out of upstream support, so security
fixes come only from Debian). A document can link images or text from a URL or
a local file, so the conversion is fenced in the image, the container and on
the host:

- **In the parser image.** `parser/odl/document.py` converts an Office file
  only from the container its suffix names (ZIP for `.docx/.xlsx/.pptx`, OLE2
  for `.doc/.xls/.ppt`) and through that format's pinned import filter
  (`--infilter`), never LibreOffice's own type detection; other bytes are
  refused before LibreOffice starts, as the terminal `422 parse_format_mismatch`
  (the coordinator fails the file without a retry). Every conversion gets a
  fresh LibreOffice profile in a job directory under the parse child's slot
  directory, which is also LibreOffice's `TMPDIR`, so a killed conversion's
  files go when the slot is wiped. Its
  `registrymodifications.xcu` blocks links from documents outside trusted
  locations (there are none), disables macros at the highest security level and
  sets Writer and Calc link updates to never. A conversion that exceeds
  `CAPY_OFFICE_CONVERT_TIMEOUT` (180 s) is killed with its whole process group,
  so `soffice.bin` cannot outlive its launcher, and the document fails as
  `parse_hard_timeout` with its fingerprint quarantined, like a parse past its
  deadline. Ingest, `/capture_page`, and
  Drive/OneDrive imports (which reach the parser as ordinary parse jobs) all
  convert through this one function. It ships with the parser image; nothing to
  apply by hand.
- **In the container.** Both ingest compose files run the parser with
  `cap_drop: [ALL]`, `no-new-privileges:true`, Docker's default seccomp
  profile and `read_only: true`. Its writable places are a 64 MiB tmpfs HOME
  (`/run/capy-parser/home`, also the parser user's passwd home, which Java
  reads), a 64 MiB tmpfs `/tmp` (only the JVM's perf data: Java's
  `java.io.tmpdir` is the document's output directory), the `parse_spool`
  volume and the disk-backed `parser_work` volume at `/run/capy-parser/work`
  (slot directories, transfers, Office jobs, and the image's `TMPDIR`, so
  spooled uploads stay off RAM; startup empties it). The release script runs
  `parse-spool-init` before every candidate parser, not only at bootstrap, so
  the volumes get their directories and owner (uid 10001) from init rather
  than from the image. The Parser budget workflow runs the image under the
  same flags. `pipeline/tests/test_ingest_compose.py` keeps both files and the
  budget's `docker run` to this and checks that every `${VAR:?}` they use is
  required by `deploy/env-manifest.json` for that deploy target. After a
  release, `docker exec "$parser" stat -c %u /run/capy-parser/work` prints
  `10001`.
- **On the host.** `deploy/ansible/ingest-host/templates/nftables.conf.j2`
  rejects every new outbound connection from uid 10001 (the `parser` user)
  except TCP to 8090 (production) and 8091 (nonprod) over loopback. Both
  parsers use host networking, so this one rule in the host output chain covers
  both. Loopback is also the route to the host's own WireGuard address, so the
  containers' healthchecks keep working. Replies to coordinator requests are
  established traffic and pass. The rule rejects rather than drops, so a
  blocked link fails at once instead of holding the conversion until its
  timeout. Nothing else in the parser needs the network: it holds no models
  and downloads none, the Java and LibreOffice steps run locally, and the
  parser sends no Sentry events. Scanned pages are read by the ingest worker,
  not the parser. If `PARSER_PORT` ever moves off 8091, change
  the template in the same release or the nonprod healthcheck fails.
- **Process isolation.** The parser's API process makes itself non-dumpable
  at startup (`prctl(PR_SET_DUMPABLE, 0)`), so its children, which run as the
  same user, can neither trace it nor read its memory or environment. The
  playbook also sets `kernel.yama.ptrace_scope=1`
  (`/etc/sysctl.d/60-capy-ptrace.conf`): a process may trace only its own
  descendants. Check it with `sysctl kernel.yama.ptrace_scope` after applying
  the playbook. The container's PID 1 is the image's own init, Debian's
  `tini`, installed execute-only (root, mode `0711`) as the entrypoint; the
  compose files set no `init: true`. A binary the user cannot read runs
  non-dumpable, so the parser user cannot read PID 1's environment either
  (`PARSER_TOKEN`), and tini still reaps the `soffice.bin` a conversion
  timeout kills. After a deploy,
  `docker exec "$parser" cat /proc/1/environ` and the same for uvicorn's pid
  answer `Permission denied`.

Apply the host rules with the provisioning playbook (see the
[ingest-host README](../deploy/ansible/ingest-host/README.md) for the inventory):

```bash
cd deploy/ansible/ingest-host
ansible-playbook playbook.yml --tags firewall --check --diff   # review the output-chain change
ansible-playbook playbook.yml --tags firewall
```

SSH is key-only (§3.1), so Ansible connects with a key.

The template task checks the file with `nft -c` before installing it, and the
handler reloads nftables. The reload replaces the `capy_ingest_filter` table in
one transaction. Existing connections keep their conntrack state.

Verify on the host (nonprod shown; production uses project `capy-ingest` and
port 8090):

```bash
nft list chain inet capy_ingest_filter output
parser=$(docker ps -q --filter label=com.docker.compose.project=capy-ingest-nonprod \
  --filter label=com.docker.compose.service=parser)
docker exec "$parser" curl -sS --max-time 5 http://1.1.1.1         # fails at once: connection refused
docker exec "$parser" curl -sS --max-time 5 https://example.com    # fails at once: could not resolve host
docker exec "$parser" curl -fsS http://10.77.0.2:8091/healthz      # 200
docker inspect --format '{{.State.Health.Status}}' "$parser"       # healthy
curl -sS -o /dev/null -w '%{http_code}\n' https://example.com      # root on the host keeps egress
```

---

## 8. Database

1. Apply migrations with `/migrate` from the **same image / git SHA** as the
   API. `deploy/docker-compose.prod.yml` does this as the `migrate` service
   before `server` starts (`MIGRATE=false`). Local docker keeps `MIGRATE=true`
   on the API. The ops service does not run migrations.
   `docker compose … run --rm migrate -status` prints pending files versus
   `schema_migrations`. Do not `psql -f` a migration against a kept database —
   that skips the ledger.
2. **Grant operator access by hand.** Have the operator sign in to the product
   once so `users.id` exists. Copy their Clerk user id, then either run
   `pnpm uat:grant-operator user_2abc... admin`, which refuses when that sign-in
   has not happened, or use a database owner session directly:

   ```sql
   INSERT INTO operators (user_id, role, note)
   VALUES ('user_2abc...', 'admin', 'initial operator');
   ```

   Use `viewer` unless the person must save registry changes or queue
   reconciliation. Those writes are tokens on `ops_permissions` for that role,
   not a second grant API. Seeded map: both roles have `read_all`; `admin` also
   has `write_registry` and `execute_reconciliation_job`. Give a viewer a write
   without promoting them:

   ```sql
   INSERT INTO ops_permissions (role, permission)
   VALUES ('viewer', 'execute_reconciliation_job');
   ```

   Revoke access with `DELETE FROM operators WHERE user_id='user_2abc...'`.
   There is no operator membership API by design.

3. Create two roles with independent random passwords. `pnpm uat:ops-roles`
   applies `deploy/ops-roles.sql` for UAT, taking both passwords from the
   configured DSNs so they match by construction; edit those DSNs first and
   `env:push` them after. Re-running only resets the passwords and re-grants, so
   it is also the way to pick up a migration that adds a column Ops reads. The grants name every
   readable column. In particular, neither role can read `messages` columns,
   file names, content or blob paths, job `payload`, email recipients or
   `payload`, or `usage_events.metadata`. The exception is the
   `ops_assistant_turns` view below: its tool details can carry a chat search
   query or a file title. Apply them as the database owner:

   ```bash
   docker exec -i db-<main-resource-uuid> psql -U capy -d capy \
     -v ops_password="$READ_PASSWORD" -v ops_admin_password="$ADMIN_PASSWORD" \
     < deploy/ops-roles.sql
   ```

   [`deploy/ops-roles.sql`](../deploy/ops-roles.sql) holds every statement and is
   the only copy to edit. Run it as the database owner after migrations have
   applied; the grants name tables and fail when the schema is absent. Re-running
   is safe and resets both passwords to the supplied values. Column grants do not
   extend to columns added later, so re-run it after a migration that adds a
   table or column ops reads. The ops boot probe skips a forbidden column that a
   migration has since dropped, so an older ops build still starts; do not roll
   ops back past a release that dropped a column it names.

   Ops validates the eight `plan_limits` column grants before it loads the
   startup catalog. A missing grant therefore fails as a role-contract error,
   rather than as a later plan-catalog query error.

   `ops_assistant_turns` (migration 0014) exposes an assistant message id,
   owning user id, lifecycle status, trace id and timestamp, plus each tool
   call's name, outcome and detail capped at 240 characters, as decided
   (human/observability-metering.md, 2026-09-13). A detail can quote what the
   tool was given or found, such as a chat search query or a file title, so
   operators can see those. Do not replace that view grant with `SELECT` on
   `messages`.

   `edit_incidents` holds ids, kinds, reason tokens and sizes, never content.
   Migration 0066 grants `capy_ops` `SELECT` on it where the role already
   exists, and this file grants it where the role is created later. Ops
   requires the grant on its own database. On a secondary database
   (`OPS_INGEST_UAT_DATABASE_URL`, `OPS_INGEST_LOCAL_DATABASE_URL`) that has not
   run 0066 yet, it logs one line and boots; once the table exists there, the
   grant is required too.

   `touch_operator_seen`, `request_reconciliation`, and
   `record_registry_audit` are `SECURITY DEFINER`.
   The read/auth role cannot update `operators` directly. The admin-actions
   role cannot write the reconciliation queue or `operator_audit_events`
   directly. The two action functions check the operator token again and append
   the audit event inside the mutation transaction. Audit triggers reject
   `UPDATE`, `DELETE`, and `TRUNCATE`, including attempts by the database owner.
   `model_configs_thinking_ok` is the CHECK helper for registry inserts; grant
   EXECUTE to `capy_ops_admin` only. Do not grant `UPDATE` on `operators`,
   table-level `UPDATE`, any other update column, or `DELETE` on `model_configs`,
   audit-table writes, schema creation, sequence access, or generic
   `ALL TABLES IN SCHEMA` privileges.
   Registry saves serialize on the `model_registry_state` row; they do not need
   a table-level `model_configs` lock.

   PostgreSQL grants function execution to `PUBLIC` by default. The two
   `REVOKE EXECUTE` statements above close that path for existing and future
   functions. Database owners keep their implicit privileges. If another
   production service uses a non-owner database role, grant that role the exact
   functions it calls before applying the global revoke.

4. Put the two URLs in `OPS_DATABASE_URL` and `OPS_ADMIN_DATABASE_URL`. Restart
   ops, verify `current_user` through both pools, and check that neither role
   belongs to a broader role. Viewer mutation requests must fail before the
   application opens the admin pool.

5. **Ligature and sub/superscript keyword vectors (one-off, decisions
   2026-09-24).** After the pipeline release whose `tokenize_for_search` maps
   `ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ` and printed sub- and superscripts (`H₀`, `s²`) is live,
   rebuild the lexical vector of chunks indexed before it with
   `pipeline/scripts/reindex_ligatures.py`. It rewrites only `search` on rows
   whose `indexed_text` holds one of those characters and whose vector is
   stale, prints `{"candidates", "stale"}` as JSON, and is safe to rerun: a
   second run reports `"stale": 0`. Run `--dry-run` first each time. An
   environment already run for ligatures alone needs one more run after the
   sub/superscript release. The shared library and the pilot database were
   done on 2026-09-24.
   - UAT and production: on the Coolify host, in that resource's retrieval
     container, which already holds `DATABASE_URL`:
     `docker exec retrieval-<resource-uuid> python pipeline/scripts/reindex_ligatures.py app --dry-run`,
     then the same command without `--dry-run`.
   - Local: from the repository root against the full-local database,
     `uv run python pipeline/scripts/reindex_ligatures.py app`
     (`DATABASE_URL` defaults to the compose database on `localhost:5432`).
   - Shared library (§7.3): from the developer PC through the tunnel, with the
     owner URL from `.env.local`,
     `PGHOSTADDR=127.0.0.1 PGCONNECT_TIMEOUT=10 uv run --env-file .env.local python pipeline/scripts/reindex_ligatures.py library`.
     It covers every stored book version. Also run `pilot` with
     `DATABASE_URL` set to the builder's pilot database
     (`data/knowledge-base/config.json`), since `publish` copies vectors from
     there; otherwise a later publish from a run indexed before the mapping
     brings the old vectors back.

---

## 9. Changing models in the registry

Most slots are safe to retarget from the ops dashboard: chat,
editor, ingest and captioning all resolve a pin per request or per job, so a new
default applies to the next one and everything in flight keeps what it had.

The dashboard deliberately disallows aliases: each grid row is the natural
`(provider_slug, model_slug)` identity. Each slot cell may still select a
different immutable version of that identity. User preferences store the same
two slugs, so there is no second hidden key namespace.

Retrieval is not one of those, and neither is deleting any row.

### Retargeting the embedding default

Every workspace pins an embedding model at creation and keeps it for life, so
a new default reaches **only workspaces created after the change**. Existing
workspaces keep using their own. Nothing breaks and nothing is migrated. Before
changing it, be sure you accept:

- **The two populations diverge permanently.** There is no reindex job (see
  [agentic-retrieval.md](agentic-retrieval.md)), so retrieval quality is now a
  function of when a workspace was created. Anything you conclude from search
  quality afterwards has to account for that.
- **The old model must keep working forever.** Every existing workspace still
  resolves it on every search and every upload. Postgres refuses
  `enabled=false`, `DELETE`, stripping or adding the retrieval slot, and
  in-place changes to the pin, `model_slug`, or `params`
  (`protect_embedding_model_configs`). Same width from another model is a
  different space and a different table. Add a `rag_chunk_vectors_*` table,
  an allowlist entry in both languages, a `model_configs` row with
  `params.vector_table`, then in one transaction clear the old
  `is_default_for` and mark the new row (Postgres refuses two defaults for
  the same slot). Bump `model_registry_state.version`. Old workspaces
  stay on the old pin. If a vendor drops the model, create a new version
  with a different exact `model_slug` that serves the **same weights**.
- **Deprecating a table is not possible.** Every embedding row stays
  enabled, and every pin in use keeps its table.
- **A new model is a migration, not a config change.** Even at 2560-d.
  Without the table, `CreateWorkspace` refuses the default pin, which is
  the intended failure: discovering a missing table at ingest time would
  mean a workspace whose vectors have nowhere to go.

### Disabling or deleting rows

`enabled = false` is the safe control for chat/generate/editor: users holding
that preference fail with `model_unavailable` rather than being silently
downgraded, which is the intended behaviour. It is not allowed on embedding
rows. Rows are never deleted, because a pinned `(key, version)` is resolved
forever, by assistant messages, by queued jobs, and by workspaces.
Embedding rows are the ones the database will actually reject a delete of.

---

## 10. Post-deploy verification

| Check                                                                        | Expected                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `curl -sI https://api.capynotebook.com/healthz`                                      | `x-request-id` header present                    |
| Send a chat turn, then `SELECT * FROM usage_events ORDER BY id DESC LIMIT 5` | rows with non-zero `output_tokens`               |
| Same `trace_id` searched in Sentry and in gateway logs                       | both return the request                          |
| `SELECT * FROM provider_sessions WHERE status='open' AND expires_at < now()` | empty after a minute (sweeper is running)        |
| Open Ops Overview after sending a chat turn                                  | current-month usage appears within 30 seconds    |
| `curl -sI https://ops.capynotebook.com` without Access credentials               | Cloudflare Access login or denial, never the app |
| Sign in through Access + Clerk as a user absent from `operators`             | `403` from the ops service                       |
| Sign in as an operator with `role='viewer'`, then submit registry Save       | `403`; registry writer pool remains unopened     |
| `curl -sI http://127.0.0.1:8082/healthz` on the host                         | `200`; :8082 is not reachable from another host  |
| Fire >200 AI requests in an hour, or 16 in a minute                          | `429` with `code: "ai_rate_limited"`             |
| Open 6 platform-paid AI calls at once                                        | 6th returns `429 too_many_streams`               |
| Hit the origin IP directly                                                   | connection refused                               |
| Coolify: `ss`/`docker ps` shows `:8080`/`:1234`/`:8082` bound on `0.0.0.0`   | wrong: only Traefik `:80` should be public       |

If `usage_events` stays empty while chat works, the usual cause is a streamed
completion without `stream_options={"include_usage": True}` — the request
succeeds and reports nothing.

---

## 11. Google Drive and OneDrive pickers

Cloud import uses two OAuth clients per provider. Clerk holds the download
token. The browser picker uses a second public client (Google Picker API key
plus app id, or an Entra SPA for OneDrive File Picker v8). Do not reuse the
Clerk Microsoft token in the OneDrive picker. That token is Graph `Files.Read`.
The picker needs a SharePoint-audience token (`{resource}/.default` for work,
`OneDrive.ReadOnly` for personal).

Skip this section and the import tab stays connect-only or fails closed.

### Clerk custom credentials

Clerk's shared Google and Microsoft credentials cannot add extra scopes.

1. Create a Google Cloud OAuth web client. Use it as Clerk's Google custom
   credentials.
2. On the Clerk Google connection, keep the baseline login scopes. Remove
   `https://www.googleapis.com/auth/drive.readonly` from global extra scopes
   if previously added; configure it on the Google OAuth consent screen.
3. Create a Microsoft Entra web app (or reuse one) for Clerk. Add Graph
   delegated `Files.Read` and `offline_access`.
4. On the Clerk Microsoft connection, keep the baseline login scopes. Remove
   `Files.Read` and any `offline_access` manually added for imports from global
   extra scopes; leave Clerk's built-in defaults intact.

Clerk's global extra scopes apply during login/signup. Import permissions are
requested only when a signed-in user explicitly connects for cloud import:
`useProviderConnect` passes Google `drive.readonly` or Microsoft `Files.Read`
and `offline_access` as `additionalScopes` to `createExternalAccount` or
`reauthorize`. These per-user scopes do not need to be global Clerk scopes.
See [Clerk's per-user scope guide](https://clerk.com/blog/implement-per-user-oauth-with-clerk).

Keep the existing Google/Microsoft OAuth apps, credentials, redirect URIs and
provider-side permission declarations. Declaring a permission in the provider
console does not request it on every login; the authorization request's scopes
control when consent is requested.

The importer checks `googleDriveReadonly` / `microsoftFilesRead` in
`GET /api/integrations` before opening a picker. A linked login account alone
does not prove file access. Check on each import entry, including after another
login, because Clerk's token grant can change. Consent returns to the current
page; the user reopens the importer. Declining file access does not remove the
Capy login session. Microsoft's separate MSAL picker consent still occurs when
the OneDrive picker opens.

The Go gateway downloads with Clerk's token wallet. Same Google Cloud project
must own the Picker API key, the Picker app id, and the Clerk Google client.
`setAppId` identifies that project when Picker opens selected files.

### Google Picker

1. Enable **Google Picker API** and **Google Drive API** on that project.
2. Create an API key. Restrict it to the Picker API.
3. Copy the **project number** (not the project id). That is the app id.
4. Set on the SPA build:

```
VITE_GOOGLE_PICKER_API_KEY=...
VITE_GOOGLE_PICKER_APP_ID=...
```

Missing the API key or a non-numeric app id shows a toast and reports a
`source-picker` error to frontend Sentry before opening the picker.
`VITE_GOOGLE_PICKER_APP_ID` is the numeric project number, never the project
name/id. UAT uses project number `648035563420` for `gen-lang-client-0126099102`.
These are build-time values: changing `deploy/.env.uat` also requires syncing
the UAT GitHub environment and rebuilding the SPA.

Google folder import uses `drive.readonly`, which can read and download every
Drive file the account can access. It is a restricted scope: configure it in
the Google OAuth consent screen, request it at import time, and complete
Google's restricted-scope verification/security assessment before a public
production rollout. Existing per-file (`drive.file`) connections must grant
the new scope through reconnect. Keep the normal `openid`, email and profile scopes.

Google's OAuth app can remain in Testing for UAT. Add accounts that will import
Drive files to Test users. Drive authorizations and refresh tokens expire after
seven days in this mode; baseline identity-only login is exempt. See
[Google's app audience rules](https://support.google.com/cloud/answer/15549945).

Check each Clerk instance separately: Capy production, UAT development, and UAT
production. Development needs custom Google credentials to add the Drive scope.
The app id, API key and OAuth client must belong to the same Google Cloud project
in each environment. Updating one Clerk instance does not update the others.
The `/v1/environment` public config reports enabled providers but not global
scopes; inspect baseline scopes in the Clerk dashboard or with a Platform API token
authorized for instance configuration.

### OneDrive File Picker v8 (MSAL)

Create a **second** Entra app. This is a single-page application, not the Clerk
web app.

1. Authentication. Platform **Single-page application**. Redirect URIs are
   `{SPA origin}/msal-redirect.html`, for example
   `http://localhost:5173/msal-redirect.html`,
   `https://app.uat.capynotebook.com/msal-redirect.html`, and
   `https://app.capynotebook.com/msal-redirect.html`. Leave **Implicit grant and hybrid
   flows** unchecked: `@azure/msal-browser` v5 uses auth code + PKCE, and the
   SPA platform already enables the CORS-enabled token endpoint.
2. Supported account types. Choose personal, work and school, or both. The
   picker uses the `consumers` authority for `driveType=personal` and
   `organizations` for work.
3. API permissions (delegated only):
   - Microsoft Graph `Files.Read`
   - SharePoint `MyFiles.Read`
4. Do **not** add `Files.Read.All` or `AllSites.Read` unless My files cannot
   open without them.
5. Set `VITE_MSAL_CLIENT_ID` on the SPA build to this app's client id.
   If a school tenant rejects `common` / `organizations`, set
   `VITE_MSAL_AUTHORITY=https://login.microsoftonline.com/<tenant-id>`.

The host URL comes from Graph `GET /me/drive` (Clerk token, server-side), not
from the user's email.

- Personal. `https://onedrive.live.com/picker`
- Work. `{origin of webUrl}/_layouts/15/FilePicker.aspx`

The browser probes MSAL (`acquireTokenSilent`, then a popup) before the picker
page loads. `AADSTS65001`, `AADSTS90094`, `consent_required`, `access_denied`,
and an `InteractionRequiredAuthError` that the popup cannot complete become a
toast that the connected account cannot use the picker. School tenants often
need admin consent. `integrations.microsoft === true` is not enough.

MSAL cache is `sessionStorage` and is cleared when the picker closes. Picker
`postMessage` handlers check `event.origin` against the computed picker origin.

### After pick

Import stays `POST /api/workspaces/{id}/sources/import` with `fileIds` and,
for OneDrive, optional `driveIds` of the same length. Download uses
`/drives/{driveId}/items/{id}` when `driveId` is present, otherwise
`/me/drive/items/{id}`.

---

## 12. UAT review environment and external-service sandboxes

The manual heavy lifecycle gate is configured in the [UAT journey guide](../e2e/uat/journeys/README.md). It documents verifier-role setup, provider read credentials, fixed-code Clerk signup, same-revision ingest checks, committed fixtures and resumable cleanup. Apply the dedicated verifier SQL only to UAT after migrations.

This section is the manual counterpart to the repository's review automation.
There is no deployed UAT system yet, so complete it only when rapid local
development has settled enough to keep an environment running. Until then,
source review and local tests work normally; remote smoke, authenticated
authorization tests, and Strix UAT scans must remain disabled.

Start the guided setup from the repository root:

```bash
scripts/review/setup-uat.sh
```

The setup command creates the ignored `deploy/.env.uat` from its example if
missing, sets mode `0600`, and validates known keys. Fill it before uploading
through the shared manifest-backed `env:push` command in §12.7. Service and
DNS provisioning are separate from environment upload.

### 12.1 Isolation model

UAT should resemble production without sharing durable application state or
credentials with it. The only local/UAT exception is the short-lived,
fingerprint-addressed nonproduction parser spool described in §7.1; production
never mounts that volume.

| Resource            | Local development                    | UAT                                                                                         | Production                                      |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| App compute         | local compose                        | separate Coolify environment/resource                                                       | production Coolify environment/resource         |
| Postgres and Redis  | disposable/local                     | dedicated UAT instances/volumes                                                             | production instances/volumes                    |
| Blob storage        | local/test bucket                    | dedicated private UAT bucket and key                                                        | production private bucket and key               |
| Ingest host         | shared nonprod project, local queue consumers | same nonprod project, UAT queue consumers; one global `1/1/1` capacity with local | production project and `capy-ingest_parse_spool` |
| Clerk               | development instance                 | separate Clerk application, Production instance                                             | production application's Production instance    |
| Stripe              | `Capy Notebook Dev` sandbox, `stripe listen` | named UAT sandbox with a registered endpoint                                             | live mode                                       |
| Product mail        | log backend, no credentials          | Cloudflare Email Service from `uat.capynotebook.com`; journey inbox on `inbox.uat`          | Cloudflare Email Service on the production domain |
| Users and content   | developer fixtures                   | synthetic accounts and fixtures only                                                        | real users and content                          |
| Scanner credentials | local only                           | GitHub `uat` environment                                                                    | never supplied to scanners                      |

Do not clone a production database, user table, object bucket, Clerk users, API
keys, or webhook secrets into UAT. Never set `AUTH_DISABLED`,
`E2E_AUTH_ENABLED`, `OPS_ACCESS_DISABLED`, `OPS_AUTH_DISABLED`, or
`OPS_UNSAFE_DEVELOPMENT` in UAT. The E2E bypass in
`deploy/docker-compose.e2e.yml` is for disposable CI only and is not a UAT
authentication strategy.

### 12.2 Create the UAT deployment

1. Create a Coolify environment named `uat` and a separate Docker Compose
   resource tracking `main`. Disable its native auto-deploy webhook; the
   workflow pins the candidate through `git_commit_sha`. Use
   `deploy/docker-compose.prod.yml`; do not reuse the production resource.
   Enable **Include Source Commit in Build**, matching production.
2. Provision separate Postgres and Redis state. A separate database on the same
   managed cluster is acceptable only if it has a distinct owner, database
   name, credentials, backup policy, and no cross-database application grants.
3. Create a separate private B2 bucket and bucket-scoped key. Apply
   `deploy/b2-cors.uat.json` and `deploy/b2-lifecycle.uat.json` (§4). Do not
   point UAT at the production bucket.
4. Use `app.uat.capynotebook.com` for the app, keeping `uat-api`, `uat-collab`,
   `uat-office`, `uat-ops` and `uat-coolify` unchanged. The advanced certificate
   covering `*.uat.capynotebook.com` is required for `app.uat`; Universal SSL's
   `*.capynotebook.com` alone does not cover it. Verify certificate coverage and
   managed renewal before routing traffic. Configure DNS, tunnel routing,
   origin lockdown, cache bypass, WebSocket support, and `/api` using §§1–3.
   Review tooling uses exact hosts, never a wildcard. Existing deployments
   follow the transition steps in §1.0.2.
5. Copy `deploy/.env.uat.example` to ignored `deploy/.env.uat`, fill only UAT
   values and upload them to the GitHub `uat` environment using §12.7. Set `APP_ENV=production`; UAT must exercise production safety
   checks. Set `SENTRY_ENVIRONMENT=uat`, which is the only thing keeping UAT
   errors out of production's Sentry bucket. Set
   `OPS_INGEST_PRIMARY_ENVIRONMENT=uat` and leave
   `OPS_INGEST_UAT_DATABASE_URL` unset. The standalone Ops renderer requires the
   primary environment to match the deployment target (§8). Use the UAT origins in `APP_URL`, CORS, collaboration, OAuth, Sentry,
   and browser build variables. Set `COLLABORATION_UAT_PUBLICATION_HOLD=true`
   for the Office refusal journey: collaboration then holds a publication (text
   or Office) after its capture, before it reads the latest save, while its
   file's name contains
   `[hold-publication]` (at most 60 s, then that publication fails with 503
   and the ingest worker retries it once). The journey sets and clears the
   marker through the file rename API, so it holds only files its actor can
   edit. It is UAT-only: the manifest scopes it to `uat`, production renders
   it blank, and the renderer refuses a production value.
   Set `RETRIEVAL_UAT_SCRIPTED_TOOLS=true` for the chat journey's scripted
   tool turns (`openwiki/agentic-retrieval.md`, Configuration surface); it is
   UAT-only in the same way, and retrieval refuses to start with it unless
   `SENTRY_ENVIRONMENT=uat`.
   For the partial-ingest and scanned-PDF journeys, set
   `CAPY_UAT_FAIL_PARTS=true` (a file named with `[uat-fail-summary]` or
   `[uat-fail-pages]` gets a descriptor or VLM page failure) and
   `INGEST_UAT_SCRIPTED_VLM=true` (a file named with `[uat-scripted-vlm]` has
   its text-less pages read as fixed text, charged as normal), both with no
   provider call (`openwiki/agentic-retrieval.md`, Configuration surface).
   They render into `uat.queue.env`, so they reach the UAT ingest workers on
   the next **Deploy ingest**; the manifest scopes them to `uat`, a production
   render with either set fails, and a pipeline process refuses to start with
   one unless `SENTRY_ENVIRONMENT=uat`.
6. The deployment publishes Worker `capy-notebook-assets-uat` (the app hosts'
   `/assets/*`), then Worker `capy-notebook-uat` with the built assets and
   live summary handler. Attach only the UAT site domain after verifying it,
   following the route and hostname transition order in §1. No summary storage service is needed.
7. Deploy once, inspect the `migrate` container, and verify all public routes
   resolve through Cloudflare. This initial deployment may use a unique random
   temporary Clerk webhook secret until the public UAT webhook URL exists.
   Replace it with Clerk's actual endpoint signing secret and redeploy before
   creating fixtures.
8. Give the ingest VM private routes to the UAT Postgres, Redis and gateway
   ports. Select `bootstrap_ingest` on the first **Deploy UAT** run; it renders
   the queue configuration from GitHub and starts only UAT consumers after
   backend verification. Local consumers remain an explicit operator action.
   Do not start an ingest worker inside the UAT Coolify resource.

Give UAT a visible banner. It shares Sentry projects with production and
separates by `SENTRY_ENVIRONMENT` (§5); it has no PostHog project at all (§6).
Budget alerts and conservative rate limits belong on UAT too: automated
security exploration can generate more traffic and LLM work than a human test.

### 12.3 Clerk: a separate UAT application

Create a separate Clerk application named `Capy Notebook UAT`. Use its Production
instance for UAT so custom domains, production-key behavior, cookies, webhook
verification, and browser restrictions match production. This does not mean
sharing the real production Clerk application: UAT and production must have
different user directories and keys. Within the real production environment,
the product and ops dashboard still use the same production Clerk instance as
required by §1.4.

In the Clerk dashboard:

1. Activate the UAT application's Production instance with primary domain
   `uat.capynotebook.com`. The browser app runs at `app.uat.capynotebook.com`;
   keep FAPI `clerk.uat.capynotebook.com`, account portal
   `accounts.uat.capynotebook.com`, and their existing keys and DNS records.
2. Enable the same sign-in methods, session lifetime, organization settings,
   and restrictions intended for production. If Google or Microsoft OAuth is
   enabled, create separate UAT OAuth credentials and UAT redirect URLs.
3. Add the UAT SPA and ops origins to the instance's allowed origins and
   redirect URLs. Do not add production origins unless the provider explicitly
   requires them.
4. Create `https://uat-api.capynotebook.com/webhooks/clerk`, selecting the same
   events as production. Copy its signing secret into UAT
   `CLERK_WEBHOOK_SECRET` and redeploy.
5. Put the UAT publishable key in the SPA build as
   `VITE_CLERK_PUBLISHABLE_KEY`, and the UAT secret key in the server as
   `CLERK_SECRET_KEY`. The GitHub authenticated tests receive the same values
   as `CLERK_PUBLISHABLE_KEY` and the protected `CLERK_SECRET_KEY` environment
   secret. Never put the secret key in a repository variable or browser build.

The gateway refuses startup when normal Clerk authentication has either a
blank `CLERK_SECRET_KEY` or a blank `CLERK_WEBHOOK_SECRET`. Development with
`AUTH_DISABLED=true` and the disposable E2E identity mode are the only
exemptions. In every mode it also refuses a `CLERK_WEBHOOK_SECRET` that is set
but is not a Svix signing secret (`whsec_` followed by base64).

#### Running the SPA locally against UAT

Use `https://local.uat.capynotebook.com`, mapped to `127.0.0.1` on each developer's
machine. Local Caddy provides HTTPS on port 443 with its internal CA and proxies
to Vite on loopback port 5173. `pnpm dev:uat` configures that hostname, HMR, and
the UAT API proxy; `pnpm dev` retains the full-local localhost lane. The deployed
UAT site remains reachable normally. No public DNS or UI tunnel is needed.

Follow [the macOS and Windows setup commands](../scripts/dev/README.md).
`pnpm dev:hosts` edits the system hosts file, with administrator privileges,
backing it up and preserving existing entries. Both `pnpm dev:hosts` and
`pnpm dev:https` request privileges automatically through macOS sudo or Windows
UAC. Run `pnpm dev:uat` in a separate normal terminal as your regular user.

The local hostname sits under the UAT Clerk primary domain, so it uses the UAT
production instance's subdomain sessions. Set these in `deploy/.env`:
`VITE_USE_MSW=false`, `VITE_API_URL=https://uat-api.capynotebook.com`, and the UAT
`pk_live` in `VITE_CLERK_PUBLISHABLE_KEY`. `pnpm dev:uat` rejects other values.
Add `https://local.uat.capynotebook.com` to both
`COLLABORATION_ALLOWED_ORIGINS` and `OFFICE_ALLOWED_PARENT_ORIGINS` in GitHub UAT
and the ignored UAT file. Deploy the collaboration service and Office Worker to
apply those settings. `deploy/b2-cors.uat.json` already covers this origin with
`https://*.uat.capynotebook.com`. Clerk needs an additional allowlist entry only
if its optional subdomain allowlist is enabled.

For full-local development, the gateway, database and UI run locally using the
Clerk development keys. Open `http://localhost:5173` with `pnpm dev`. Clerk
webhooks are not delivered to a laptop and the development instance has no
webhook endpoint: the first authenticated request provisions the user
(`admitClerkIdentity`), and webhook handling is checked on UAT, whose Clerk
production instance delivers to `uat-api`. The local gateway still needs a
`whsec_`-shaped `CLERK_WEBHOOK_SECRET` to start.

This lane shares one UAT database and bucket, and it cannot change the
backend. The migrator records a checksum per migration and refuses to run when
an applied file changes (`server/internal/store/migrate.go`), so schema work
needs a database the developer can drop or migrate forward: the gateway,
Postgres and Redis run locally on the Clerk development instance for that.

Create four synthetic accounts. Dedicated inbox aliases are sufficient if the
mail provider routes them separately:

- owner: creates the private fixture;
- editor: invited with edit access;
- viewer: invited with view access;
- other: never invited, used to check cross-tenant denial.

Use no real customer identity or content. Playwright uses the Clerk Backend API
to mint a short-lived, one-time sign-in token for the selected synthetic user;
CI does not need account passwords and the Clerk secret never enters the
browser. Keep MFA requirements consistent with production, but verify that the
sign-in-token flow works before enabling unattended runs. Suspended and
over-quota accounts are useful future fixtures but are not required by the
initial UAT workflow.

### 12.4 Stripe: a UAT sandbox and a separate local lane

Stripe's dashboard view switch does not turn a live integration into a test
integration. Live mode and each named sandbox carry
separate API keys, customers, products, prices, events, and webhook secrets.

The split matters because Stripe fans every event in an environment out to
every endpoint registered in that environment, with no filtering by which API
key created the object. Share one environment and a local checkout delivers to
the UAT endpoint while every UAT subscription change delivers to whoever is
listening locally. The gateway tolerates it — an unresolved customer leaves
`userID` empty and the case returns 200 without an error
(`server/internal/httpapi/webhooks.go`) — but each foreign event is still
claimed into both databases, and `stripeSubscriptionUser` returns
`store.ErrConflict` when its identity sources disagree, which is a signal that
should never fire on cross-environment noise.

Three lanes, none of them shared:

| Lane       | Stripe environment                                  | Delivery                     |
| ---------- | --------------------------------------------------- | ---------------------------- |
| production | live mode, `Capy Notebook`, `acct_1U8DjUFAFTXFg4S6` | registered endpoint          |
| UAT        | `Capy Notebook UAT`, `acct_1U8Djl2ZZopeANOe`        | registered endpoint          |
| local dev  | `Capy Notebook Dev`, `acct_1UC8tXFKth3QfmPW`        | `stripe listen`, no endpoint |

The live account belongs to Stable Studio Limited (Hong Kong) and carries the
Capy Notebook public name; it is the only Stripe account, so Stable Studio's own
work does not bill through it.

**Tax.** Stripe Tax is active in all three lanes with the same settings: head
office at the company address in Tsim Sha Tsui, Hong Kong; default tax behavior
`exclusive` (customers pay the USD price plus their local tax); default tax code
`txcd_10105001` (AI as a Service, cloud, personal use), also set on each Pro
product. Hong Kong has no VAT/GST and there are no registrations, so tax is zero
and Stripe charges no Tax fee until a registration is added under
Tax → Registrations. Threshold monitoring runs on live payments only. All prices
are USD.

**Failed payments.** Set by hand in live and the UAT sandbox (the API cannot read
them). Billing → Invoices → Retries → Card payments: a custom schedule of three
retries one day apart for one-off invoices (auto-reload), separate from the
subscription retries under Revenue recovery; after the last failure the invoice is
marked uncollectible, so a stale reload cannot be paid later from the hosted link.
Billing → Revenue recovery → Retries → Subscriptions: if all retries fail,
**Cancel the subscription** and mark the invoice uncollectible, in live and UAT.
The app's grace model assumes it: "Mark as unpaid" would leave a second Pro
Checkout open next to the unpaid subscription, and "Leave as past due" keeps
Pro without payment, since `past_due` still entitles.
Failed-payment emails link to the Stripe-hosted page, and the 3DS confirmation
link email is on. Public details: name `Capy Notebook`, descriptor
`CAPY NOTEBOOK`, support `support@capynotebook.com`.

**UAT sandbox.** `Capy Notebook Pro` (`prod_VBvlTdsu2tTdkK`) with a monthly
USD 8.00 price, `price_1UBXuV2ZZopeANOehrbUr1Qx`. The endpoint is
`we_1UFazI2ZZopeANOeYbwCk8PA` at
`https://uat-api.capynotebook.com/webhooks/stripe`. Pin its payload API version to
`2025-08-27.basil`, matching `stripe-go/v82` in `server/go.mod`. The account
default may be newer; `ConstructEvent` rejects incompatible release families
before recording the event, and the gateway returns HTTP 400. Revisit this pin
when upgrading the SDK. [Stripe endpoint creation](https://docs.stripe.com/api/webhook_endpoints/create)
accepts `api_version`; changing request headers in the test runner does not
change the webhook payload version. Put the sandbox
`sk_test_…`, that endpoint's signing secret, and the price ID into the UAT
Coolify resource as `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
`STRIPE_PRICE_PRO`. There is no publishable-key setting: checkout is a
server-side redirect to Stripe's hosted page (`CreateCheckoutSession` returns
the URL) and the SPA never loads Stripe.js.

**Local dev.** `Capy Notebook Pro` (`prod_VCY2Q2oiYYu0lf`), price
`price_1UC8wXFKth3QfmPWxTiKOqC1`, same USD 8.00 monthly shape. Register no
webhook endpoint here. Each developer runs

```
stripe listen --forward-to localhost:8080/webhooks/stripe
```

which prints the `whsec_…` for that session's `STRIPE_WEBHOOK_SECRET` and
needs no tunnel. Nothing persists in the
dashboard, so there is no endpoint to auto-disable while a laptop is off and
no per-developer secret to rotate. Other developers' events still arrive,
because the fan-out is per environment; only per-developer sandboxes would
stop that, and that is not worth the setup today.

The event selection in every lane is exactly what the handler switches on:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_failed`, `invoice.paid`, `charge.refunded`,
`charge.dispute.created`, `charge.dispute.closed` and
`checkout.session.async_payment_succeeded`. The last five came with credit
top-ups and auto-reload; add them to an existing endpoint. Anything else
is delivery the gateway discards.

**Credit top-ups and auto-reload.** No product or price is needed: top-ups and
reloads charge an ad-hoc USD amount. The dashboard settings they depend on, set
in live and UAT on 2026-10-16: one-off invoices retry the card 3 times a day
apart and are then marked uncollectible (the Subscription tab still shows a
Pay link, and paying later credits it); failed-payment emails with the hosted
invoice link and 3D Secure confirmation links are on. Card and Link must be
enabled payment methods. The reload worker runs only where
`STRIPE_SECRET_KEY` is set.

Plan credit limits are data, not migrations: the Free monthly allowance is
200 credits (`UPDATE plan_limits SET credit_limit_micros = 200000000 WHERE
plan_tier = 'free';`, Epo 2026-10-16), and the one-off 800-credit starter grant
is the `user_credits` column default from migration 0088. A database built from
migrations still seeds the older values, so set the row by hand in each
environment, **before** the deploy that restarts the API and the ingest worker:
both read `plan_limits` once at startup (or restart them after the change).

There is no Team product in any environment and no `STRIPE_PRICE_TEAM`
setting: `plan_limits` restricts `plan_tier` to `free` and `pro`
(`server/migrations/0001_init.sql`). Add the price and the variable together
when the schema grows a tier to hold one.

Exercise one successful subscription, update, cancellation, failed payment,
duplicate webhook delivery, and out-of-order delivery using synthetic
customers. Confirm plan state, idempotency, and reconciliation before the
first production release.

Stripe credentials are GitHub environment deployment secrets. Keep the matching
sandbox values in ignored `deploy/.env.uat` and upload through `env:push`; the
deployment sync applies them to Coolify. Scanner-only credentials remain local.

Leaving the gateway's Stripe secret, webhook secret, and Pro price blank keeps
billing disabled. If either `STRIPE_WEBHOOK_SECRET` or `STRIPE_PRICE_PRO` is
configured, the gateway refuses startup without `STRIPE_SECRET_KEY`. This
keeps Stripe optional for local deployments without allowing a partially
configured billing deployment to skip provider-authoritative deletion checks.

### 12.5 Mail: Cloudflare Email Service and the UAT journey inbox

Product mail sends through Cloudflare Email Service (beta). Workers Paid
includes 3,000 emails a month for the whole account, then $0.35 per 1,000.
Reputation and the suppression list follow the sending domain, so UAT and
production never share one: UAT sends from `uat.capynotebook.com`; production
takes `capynotebook.com`, or a `mail.` subdomain under it, when it exists.

Local development needs no credentials. `newEmailSender`
(`server/cmd/api/email.go`) uses the log backend when `CLOUDFLARE_EMAIL_TOKEN`
is empty and refuses `cloudflare` outright under `APP_ENV=e2e`. Setting
`EMAIL_BACKEND=cloudflare` without the token or `CLOUDFLARE_ACCOUNT_ID` fails
gateway startup rather than degrading.

**What sends.** Templates are Maily JSON sources in `emails/templates/`,
edited by hand (the template editor is gone, developer decision 2026-10-20);
`pnpm email:build` regenerates the Go copies the API embeds; `emailTemplateData` in `server/cmd/api/email.go` formats each
outbox payload for the recipient's locale. Clerk sends its own sign-up and
password-reset codes with its unchanged templates, so they cost this quota
nothing; share and comment mentions are in-app only.

| Template | Sent when | Opt-out |
| --- | --- | --- |
| `welcome` | the starter workspace is provisioned, once per account; skipped for Clerk test addresses (`+clerk_test@`, the UAT journey actors and seeds) | none |
| `workspace-invite`, `workspace-invite-accepted` | an owner invites someone; the invitee accepts (to the owner) | workspace invitations |
| `subscription-started` | a Pro subscription first entitles, once per subscription | billing |
| `subscription-cancelled` | cancel-at-period-end turns on, once per period end | billing |
| `subscription-over-quota`, `subscription-frozen` | the over-quota sweep: lapse, T-7 and T-3, then freeze | billing |
| `account-deletion-requested`, `account-deletion-cancelled` | deletion is requested or support restores the account | none |
| `office-maintenance` | `office-maintenance announce` without `--reminder`, recent Office editors only | none |

**Sending domain.** In Compute → Email Service → Email Sending, onboard
`uat.capynotebook.com`. Cloudflare writes its own records: MX and SPF on
`cf-bounce.uat`, DKIM at `cf-bounce._domainkey.uat`, DMARC at `_dmarc.uat`.
Create an account API token with Email Sending permission, scoped as narrowly
as the dashboard allows, and set in the GitHub `uat` environment (deploys copy
them to Coolify): `EMAIL_BACKEND=cloudflare`, `CLOUDFLARE_EMAIL_TOKEN`,
`EMAIL_FROM=Capy Notebook <notifications@uat.capynotebook.com>`, and a fresh
32-byte `EMAIL_UNSUBSCRIBE_SECRET`. `CLOUDFLARE_ACCOUNT_ID` is the variable
the deploy workflows already use; the deployment renderer now also passes it
to Coolify.

Verified 2026-10-13: a send shaped like the gateway's (display-name `From`,
`reply_to`, both unsubscribe headers) was delivered at once and reached the
journey inbox in about a second, with DKIM passing for `d=uat.capynotebook.com`
(selector `cf-bounce`), DMARC passing, and `Reply-To` set from `reply_to`. The
API's `message_id` is exactly the `Message-ID` header the recipient sees; the
account journey matches the outbox row to its inbox copy by it.

The send API takes no idempotency key: if the gateway dies between a
successful send and marking the outbox row sent, the retry delivers a second
copy. A synchronous permanent bounce or suppressed recipient comes back as an
error and is retried like any other failure, within the outbox's six attempts.
`Reply-To` must travel in the API's `reply_to` field; Cloudflare rejects the
whole request when it appears among custom headers. `List-Unsubscribe` and
`List-Unsubscribe-Post` are accepted as headers.

Cloudflare publishes `message.delivered`, `message.bounced`,
`message.complained` and related events per sending domain through Event
Subscriptions to a Queue. The gateway consumes none of them, so adding bounce
or complaint handling reopens the same per-environment question Stripe has.

Onboarding wrote `_dmarc.uat` as `v=DMARC1; p=reject;`, so mail claiming the
UAT domain without Cloudflare's signature is refused. `capynotebook.com` itself
was onboarded on 2026-10-16 so the support Gmail can send as
`support@capynotebook.com` through Email Service SMTP
(`smtp.mx.cloudflare.net:465`, user `api_token`), and that wrote
`_dmarc.capynotebook.com` as `v=DMARC1; p=reject;` too. Subdomains without a
record of their own (such as `inbox.uat`) inherit it, and anything else sending
as the root domain must sign with its own aligned DKIM, as Clerk does through
`clk._domainkey` and `clkmail`. Incoming `support@capynotebook.com` is an Email
Routing rule forwarding to `support.capynotebook@gmail.com`. That Gmail's
"Send mail as" entry authenticates with the same token as UAT's
`CLOUDFLARE_EMAIL_TOKEN`, so rotating or revoking it also stops support replies.

**Resend is retired.** The account journey passed on Cloudflare on 2026-10-13
(UAT quality run 38359470612), and the GitHub `uat` entries `RESEND_API_KEY`,
`UAT_RESEND_FROM` and `UAT_RESEND_READ_KEY` and Coolify UAT's `RESEND_API_KEY`
were deleted that day. The DNS records TXT `resend._domainkey.uat` and MX/TXT
`send.uat` go with the Resend key.

**UAT journey inbox.** Journeys register actors as
`journeys+uat-<run>-<label>-<id>+clerk_test@inbox.uat.capynotebook.com`
(`UAT_ACTOR_EMAIL_DOMAIN`). Clerk still treats the double-`+` address as a test
address with the fixed code. Catch-all rules exist only on a zone apex, so
Email Routing on the `capynotebook.com` zone has subaddressing on and one rule,
`journeys@inbox.uat.capynotebook.com` → Worker `capy-notebook-uat-inbox`, which
every `journeys+…` address matches. Enabling routing on the zone added
Cloudflare's MX (`route1`–`route3.mx.cloudflare.net`) and SPF at
`capynotebook.com` and at `inbox.uat`, and the DKIM key `cf2024-1._domainkey`;
mail to any address without a rule is rejected. Set up 2026-10-13.

The Worker (`workers/uat-inbox`, `wrangler.uat-inbox.jsonc`, deployed for UAT
by `deploy-environment.yml`) rejects envelope senders outside
`uat.capynotebook.com`, keeps each message for a day in the KV namespace
`capy-notebook-uat-inbox`, and serves
`GET https://uat-inbox.capynotebook.com/messages?to=<address>` to
`Authorization: Bearer <READ_TOKEN>`. The Worker secret `READ_TOKEN` and the
GitHub `uat` secret `UAT_INBOX_TOKEN` hold the same value; set the Worker side
with `wrangler secret put READ_TOKEN --config wrangler.uat-inbox.jsonc`. KV
reads elsewhere can trail a write by about a minute, which the journey's poll
absorbs. R2 is not enabled on the account, hence KV.

### 12.6 Create the authorization fixture

After Clerk webhooks are healthy and the UAT deployment is stable:

1. Sign in as the synthetic owner and create one private workspace and one
   small, non-sensitive material.
2. Invite the editor and viewer with their matching roles. Sign in
   as each account and accept every invitation.
3. Leave the `other` account uninvited. It must receive the same not-found
   response as any unrelated tenant rather than learning that the fixture
   exists.
4. Record the workspace and material IDs in `deploy/.env.uat` and upload them. Do not put fixture
   content, session cookies, invitation tokens, or passwords in GitHub.
5. Reset or recreate the fixture whenever a scanner changes it. Keep the IDs
   current; stale IDs are failed setup, not passing authorization tests.

The authenticated UAT suite checks read visibility, owner-only statistics, and
collaboration token modes for all five roles. Extend this fixture later for
suspension, over-quota, deletion, billing, import, and asynchronous lifecycle
tests; each extension should use bounded synthetic data and deterministic
cleanup.

### 12.7 GitHub Actions configuration

Create GitHub environments `uat` and `production`, restricted to `main`. Keep
UAT without a reviewer for post-CI deployment and retain production's release
approval protection. Codex Security and Strix still run locally; Actions checks
their commit statuses and never receives local scanner credentials.

`deploy/env-manifest.json` classifies each supported input as a GitHub variable
or secret and names its deployment targets. Both complete examples include
backend, browser, provider and ingest inputs. Keep the real files ignored and
mode `0600`. Use `CLERK_PUBLISHABLE_KEY` for deployments; the renderer derives
its browser/ops `VITE_` form. Local development continues using `deploy/.env`.
The renderer takes manifest variables from GitHub's whole `vars` context
(`CAPY_GITHUB_VARS`), ignoring unrelated settings, and each secret from its own
step variable `CAPY_SECRET_<KEY>: ${{ secrets.<KEY> }}`. Every render step
(`render-build`, `render`, `render-ops`) names exactly the secrets its render
reads, because GitHub holds a run whose workflow passes `toJSON(secrets)` for
approval. A manifest secret added without wiring fails CI
(`scripts/env/test_config.py`); add its line to each render step the failure
names. An unset GitHub secret arrives blank and renders as missing. A manifest
secret stored as a variable fails the render; a variable stored as a secret
is invisible to the renderer and renders blank, or fails its required check.
Local env files reject unknown keys.

Set `DEPLOYMENT_OPS_URL` in each GitHub environment and its local environment
file for the optional ops edge check. The UAT workflow and local review scripts
use this name directly; there is no repository-level ops URL fallback.

```bash
pnpm env:check --file deploy/.env.uat
pnpm env:push --file deploy/.env.uat --environment uat --repo samyung0/capy-notebook
```

The uploader needs `gh auth login` with repository/environment administration
access. It sends secrets through stdin, rejects unknown/duplicate keys, and
does no shell expansion. An explicit blank deletes that key in GitHub; omitted
keys are left alone. Review-only `STRIX_*`, `LLM_API_KEY`, tunnel/dev controls,
and derived release values remain local. Double-quoted `\n` escapes can hold
an SSH private key. Do not put actual multiline shell fragments in the file.

Every deployment reads GitHub's environment values afresh, renders private
runner files, and applies/reads back all managed Coolify variables. Empty
optional values remain literal blanks. After successful replacement readback, the sync removes only the corresponding old `EVO_*` names and retired `EVO_QUERY_MODEL`, `IMPORT_RELAY_ENQUEUE_URL` / `IMPORT_RELAY_SECRET`, verifies their absence, and preserves unrelated normal variables. The sync disables preview entries and
uses `is_literal=true`, `is_shown_once=false`; it prints neither values nor
fingerprints. Coolify's token needs sensitive-read access for verification.
The Cloudflare token needs Worker scripts/assets deployment access and
Cloudflare Pages edit access for the interactive block frame (§2.3). Retire
`CLOUDFLARE_PAGES_PROJECT` and `CLOUDFLARE_PAGES_BRANCH` in GitHub before the
first new deployment; they are rejected as unknown inputs.

**Workflow hardening.** Third-party actions are pinned by full commit SHA
with the release in a comment. Dependabot (`.github/dependabot.yml`) opens one
grouped weekly pull request that moves the pins and comments together, the
composite actions under `.github/actions/` included. Every workflow declares
its token scope, and every checkout sets `persist-credentials: false`: no step
needs the token for git (the submodule and fork fetches are public, `gh` reads
`GH_TOKEN`). A run script never expands `${{ }}`; values reach it through the
step's `env`. Secrets sit only on the steps that use them, never in a
workflow or job `env` or on an install or action step: the UAT journey job's
secrets sit on its tunnel, ingest-check, journey and cleanup steps, and Deploy
Ops passes the Coolify token only to its three Coolify steps. No file under
`.github` uses `toJSON(secrets)`: since 2026-07-28 GitHub holds such runs on
public repositories until someone approves them, and the step would see every
secret; the render steps name theirs instead (§12.7). The SPA build
job renders only the build values (`config.py render-build`); the deploy job
renders the Coolify and ingest configuration, so it is never on disk while
third-party build code runs. `SENTRY_AUTH_TOKEN` stays in the build values
(developer decision 6b). `coolify-deploy.sh` hands curl the API token as a
config line on stdin, never as an argument. `scripts/ci/hardening.test.mjs`
(in `pnpm test:deployment`) holds these rules.

**Dependency vulnerabilities.** CI runs one job per ecosystem and fails on a
known advisory: `audit_rust` (`cargo deny check advisories` on
`collaboration-rs`), `audit_go` (govulncheck on `server`, with the Go line the
gateway and Ops images build with; it prints its counts and also fails on a
listed id it no longer reports), `audit_pnpm` (`pnpm audit --prod`) and
`audit_python` (pip-audit over `uv.lock`'s runtime set, `parser/requirements.txt`
and `pipeline/ppt-master-requirements.txt`). An advisory that has to wait goes
on that ecosystem's commented ignore list, with its reason:
`collaboration-rs/deny.toml`, `server/govulncheck-ignore.txt`,
`auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` and `pip-audit-ignore.txt`.
Prefer a version bump or a commented `overrides` entry (the developer's rule,
2026-10-20); an advisory stays listed only when its fix breaks something, and
the entry says what. Drop an entry when its fix lands, for example the Go
entries with the version wave.

Required families include application origins, Clerk/webhook keys, Postgres,
B2, collaboration/pipeline secrets, actual provider/mail/billing keys, Coolify
and Cloudflare credentials, and ingest SSH/token/network settings. Runtime
DSNs derive from the selected environment's private address and URL-encoded
Postgres password. Never copy a development bucket or production secret into
UAT merely to fill a missing input.

Deterministic quality URLs, authorization flag, synthetic account emails and
fixture IDs belong in the GitHub `uat` environment and use the same upload
path. The local scanner authorization flag still requires explicit permission
to scan that UAT target.

Use **Deploy UAT** for the app/backend/site release, **Deploy ingest** for the
ingest host against an already matching backend SHA — leave its `revision` blank
and it takes whatever the backend reports, which is the only revision it can
safely run, and is usually not the head of `main` — and **Deploy Ops** for the
independent dashboard and its Go backend, which resolves a blank `revision` the
same way because it reads the database the backend migrates. Name the revision
explicitly on a UAT Ops run you intend to promote: the promotion gate finds the
prior UAT run by its title, and a blank run's title carries no SHA. The three are isolated: neither the
ingest host nor Ops can fail a **Deploy UAT** run, and its quality gate checks
only that what it deployed is answering. The authenticated Playwright suite is
opt-in: it runs on a manual **Deterministic UAT quality** dispatch and as the
production promotion gate, not on every deploy. All
apply their selected GitHub configuration on every run. Native Coolify
Git auto-deploy stays disabled. Production promotion retains the UAT,
editor-perf, and protected-environment gates.

### Independent Ops application

The Ops dashboard sends a strict content security policy, widened only for
Clerk: its browser bundle and API calls, `img.clerk.com` avatars, the worker it
spawns, and the Cloudflare challenge frame bot protection renders at sign-in.
The origin comes from decoding `VITE_CLERK_PUBLISHABLE_KEY`, so it follows the
environment; an unreadable key leaves the policy at `'self'` and the dashboard
reports that Clerk failed to load. The SPA's policies are report-only
(§2.4), which is why the same Clerk setup works there without
configuration.

Every hostname a stack publishes on the shared `coolify` network has to be
unique, because Coolify's own infrastructure containers claim bare service
aliases there too: `coolify-redis` answers to `redis` and `coolify-db` to
`postgres`. A service named `redis` therefore resolves to both containers, and
the gateway reaches the password-protected Coolify one about half the time,
which surfaces as intermittent `503`s from SSE endpoints while ordinary requests
keep working. The stack's own cache is named `capy-redis` for that reason.

Point the Ops database URLs at the compose service alias `db`, not at
`db-<main-uuid>`. Coolify appends a fresh timestamp to every compose container
name, so it aliases the database on the shared network as both
`db-<main-uuid>-<timestamp>` and `db`; only the latter survives a redeploy. A
wrong host here fails as `hostname resolving error: lookup db-... no such host`
in the Ops container logs, and the edge answers `404` because Traefik has a
router but no healthy backend.

Keep `${...}` defaults in `deploy/docker-compose.ops.yml` simple. Coolify parses
the compose and materialises each variable's default expression into a real
environment row, so a nested `:?` default becomes a `build-time.env` line that
Compose cannot read — the deploy then fails with `failed to read
/artifacts/build-time.env: required variable RELEASE_SHA is missing a value`
before any image builds. `render-ops` always supplies `RELEASE_SHA`, so refer to
it directly rather than defaulting through `SOURCE_COMMIT`. Delete any stored
`SOURCE_COMMIT` row that already holds such an expression.

Ops is a separate Coolify Git application on the same host as the main stack.
It builds `ops/Dockerfile`, containing the dashboard and Go Ops API, using
`deploy/docker-compose.ops.yml`. The main stack owns Postgres and migrations.

One-time setup per environment:

1. Deploy the main stack and complete the Ops database roles/grants in §8.
2. Create a Coolify Git application from this repository and `main`, using the
   Docker Compose build pack, repository-root base directory, and
   `/deploy/docker-compose.ops.yml`. Disable automatic and preview deployment;
   enable Include Source Commit in Build.
3. Set GitHub environment variable `COOLIFY_OPS_RESOURCE_UUID` to the new
   application UUID. Keep `COOLIFY_RESOURCE_UUID` pointing to the main stack.
4. Enable **Connect to Predefined Network** on both applications, using the
   same Coolify destination. Redeploy the main stack once to attach its
   database container. Use the full database container hostname shown in
   Coolify, typically `db-<main-resource-uuid>`, rather than the stack-local
   `db` alias. No additional database port needs to be published for Ops.
   See [Coolify networking](https://coolify.io/docs/applications/build-packs/docker-compose#connect-to-predefined-networks).
5. Set `OPS_DATABASE_URL` and `OPS_ADMIN_DATABASE_URL` using their restricted
   database roles and that full database hostname. Configure Access
   issuer/audience, Clerk, and optional telemetry/provider values through the
   same GitHub environment. Ops-specific keys target only the Ops resource;
   the renderer excludes the application owner's Postgres password, billing
   credentials, ingest SSH keys, and development auth bypasses.
6. Assign the existing Ops hostname to this application's `ops` service on
   port `8082`, such as `http://uat-ops.capynotebook.com:8082`. Keep its
   Cloudflare Access protection. If migrating an already-running Ops service,
   move the hostname from the old application and retire that service before
   starting the new one. Remove `COMPOSE_PROFILES=ops` from old configuration.
7. Run **Deploy Ops** from `main`, select `uat`, and choose a full commit SHA
   or leave it blank to use the running backend's revision. UAT and production
   Ops deployments run independently of CI results.

Each run verifies that its target is a different Coolify application with the
Ops Compose file and a shared Coolify destination with predefined networking
enabled on both applications, synchronizes and reads back GitHub configuration, and deploys
that exact commit. The provider deployment result verifies the commit, and the
container health check probes the Ops Go process. Verify dashboard sign-in and
an authenticated read after the first deployment. Ops does not run migrations
or redeploy the main app, ingest workers, or frontend Workers.

Production additionally requires a successful **Deploy Ops uat** run for the
same SHA and the GitHub production environment protection. The workflow shares the main promotion
concurrency group so it cannot restart Ops during an app migration. Ops may
use a newer code revision than the main app for schema-compatible changes;
changes requiring new database tables/columns must deploy the main migrations
first. Roll back compatible Ops changes by selecting a previous passing SHA.

### 12.8 Baseline, automation, and release gate

1. Manually dispatch **Deploy UAT** from `main`. It deploys the selected SHA and
   automatically calls **Deterministic UAT quality**, which probes the SPA,
   gateway and collaboration health and verifies the released SHA. For the
   authenticated authorization evidence, dispatch
   **Deterministic UAT quality** yourself with `browser_suite`, which promotion
   also requires. Leave `revision` blank to resolve the running UAT backend's
   SHA once, matching the Ops and ingest defaults. The smoke, browser, and
   lifecycle jobs all check out that revision, and release checks expect it.
   An explicit SHA, including one passed by Deploy UAT or promotion, remains
   the required target. A failed backend lookup stops the run.
2. Repair the fixture and tune only documented budgets or exclusions. Do not
   weaken authorization assertions or allow-host guards to make a run green.
3. Dispatch **Performance** (`perf.yml`) once so later runs have a baseline to diff. No
   workflow has a schedule and no workflow stages UAT on push.
4. Before a promotion, on the developer machine with `gh auth login` done:
   run `pnpm review:source:codex` on the clean candidate checkout, and
   `pnpm review:uat:strix` while UAT serves that SHA. Each posts its commit
   status (`source/codex-security`, `uat/strix`) on the SHA as evidence for
   the releaser. Triage candidates rather than suppressing unexplained results.
   When the release warrants the full review, invoke `$review-repository` in
   `release` mode; it runs both scans as part of its procedure.
5. Perform the manual Stripe sandbox sequence in §12.4 plus the release checks
   for over-quota/suspension, ingest/index/search, cleanup, reconciliation,
   collaboration revocation, and recovery until dedicated synthetic fixtures
   automate them.
6. Dispatch **Promote revision to production** with the exact full SHA. The
   workflow re-stages UAT, re-runs the deterministic gate and editor perf on
   that SHA, waits for production approval, deploys both production resources, and verifies
   the public release SHA and health. Then perform the bounded login, upload,
   collaboration, webhook, and observability checks in §10. Production is not
   a penetration-test target.

Do not dispatch **Deploy UAT** while UAT is being rebuilt, its fixture is
invalid, or allowed-host ownership changes; quality dispatch remains available
for repair. Rotate Clerk and LLM secrets
after exposure or personnel changes. Delete stale artifacts under the
repository's retention policy; they should contain sanitized evidence, but
they are still security-sensitive. Local `review-results/` bundles are
unsanitized; keep them out of shared drives and chat.


## Repeatable UAT authorization seed

After the first UAT backend deployment has applied its numbered migrations,
run the explicit initializer from the repository. This does not run on each
deploy and does not apply migrations or reset data.

```sh
pnpm uat:seed --file deploy/.env.uat \
  --ssh-key ~/.ssh/id_ed25519_capy_uat \
  --db-container <actual-UAT-Postgres-container>
```

Find the exact Postgres container name in the UAT Coolify resource or with
`ssh -i ~/.ssh/id_ed25519_capy_uat root@159.195.250.206 docker ps`.
The script targets only this UAT host and checks the database schema before
creating accounts. The ignored environment file must select the UAT URLs and
contain the UAT Clerk backend key. The script also verifies the key's primary
Clerk domain before changing accounts.

The approved emails are `capy-uat-{owner,editor,viewer,other}+clerk_test@stablestudio.org`.
Missing users are created through Clerk's backend API with verified email
addresses and no password or invitation. Existing users must remain active with
the matching verified primary email. UAT browser tests use short-lived sign-in
tickets; the seed stores no reusable login tokens.

The SQL transaction inserts missing application users, private workspace
`ws_uat_authorization_v1`, and note `note_uat_authorization_v1`, assigning owner,
editor and viewer membership. The other account remains uninvited.
Repeated runs preserve content and revision history. Identity, lifecycle,
ownership or permission drift stops the transaction; it never resets accounts,
restores deleted data or overwrites existing note content. Storage is accounted
through the normal database triggers.

Every run, including `--accounts-only`, also keeps two plan test accounts for
manual testing outside the fixture: `capy-uat-free+clerk_test@stablestudio.org`
and `capy-uat-pro+clerk_test@stablestudio.org`. Clerk's `user.created` webhook
gives each its application user and default workspace. The pro account is kept
on one live Stripe sandbox Pro subscription (customer with `metadata.user_id`,
Stripe's 4242 test card, `STRIPE_PRICE_PRO`) that renews monthly on that card;
the app's subscription webhook makes the account Pro. A rerun reuses a live
subscription and subscribes again only after it lapsed. The run that first
creates the pro account does not subscribe it, since the app drops a
subscription webhook for a user it has not admitted yet: rerun a minute later.
The environment file needs a `sk_test_` `STRIPE_SECRET_KEY` for
`UAT_STRIPE_ACCOUNT_ID`. The free account never subscribes.

Sign in to any seeded account at `https://app.uat.capynotebook.com` with its
email and Clerk's fixed test code `424242` (no mail is sent). Automated journeys
do not use these long-lived accounts; they create their own per run.

To prepare or verify only the Clerk accounts while the backend is unavailable:

```sh
pnpm uat:seed --file deploy/.env.uat --accounts-only
```

GitHub UAT variables `UAT_OWNER_EMAIL`, `UAT_EDITOR_EMAIL`,
`UAT_VIEWER_EMAIL`, `UAT_OTHER_EMAIL`,
`UAT_FIXTURE_WORKSPACE_ID` and `UAT_FIXTURE_MATERIAL_ID` must match the values
above. Run `pnpm e2e:uat` after full initialization and a healthy deployment.


## Database migration baselines

`server/migrations/NNNN_name.sql` files are forward migrations.
`BNNNN_name.sql`, for example `B0100_snapshot.sql`, is an optional
snapshot equivalent to all numbered migrations through that version.
Keep four-digit consecutive numbered versions, starting at `0001`; the baseline
and a numbered migration may share a version, but two files of the same kind
may not. There is currently only `0001_init.sql`, so no duplicate snapshot is
checked in.

| Database state | Execution with `B0100_snapshot.sql` available |
| --- | --- |
| Empty application database and empty migration ledger | Apply `B0100_snapshot.sql`, then `0101` onward |
| Existing numbered history at `0070` | Apply `0071` onward; ignore the snapshot |
| Previously initialized from `B0050_snapshot.sql`, upgraded through `0100` | Keep that baseline record; apply `0101` onward |

The runner records only SQL files it actually executes. It does not invent
ledger entries for migrations covered by a snapshot. Applied baselines and
numbered migrations retain SHA-256 validation; editing an applied file fails
before any pending file runs. `migrate -status` reports `applied`, `pending`,
`covered-by-baseline` and `ignored-baseline` from the same validated plan.
Migration processes take the existing advisory lock before ledger creation and
execute each SQL file and its ledger entry in one transaction.

A baseline requires an empty application database, including other user schemas.
Preinstalled extensions and the empty migration ledger are allowed. The runner
refuses to adopt existing tables, routines or types just because their migration
ledger is missing. It never resets, deletes or automatically labels existing
data as baselined.

To publish a new baseline, build a disposable database through version N using
the retained numbered files. Produce a reviewed SQL snapshot containing its
schema plus required catalog rows, such as plan limits, model configuration,
credit rates and operator permissions. Exclude user data, development fixtures,
UAT actors and the migration ledger. Preserve sequence values for any seeded
serial/identity IDs. Baselines use executable SQL statements, including explicit
`INSERT`/`setval`; remove psql backslash directives and do not use `COPY ... FROM
stdin` streams or transaction-control statements. Schema snapshots may contain
ordinary dump session settings; the runner resets those settings before recording
the file so they cannot leak to later migrations or API connections.

Run `pnpm test:go`. `TestEmbeddedBaselinesMatchForwardHistory` automatically
checks each embedded baseline against the numbered path through its version.
It compares PostgreSQL schema dumps including grants, table rows, and sequence
`last_value`/`is_called`. Only `created_at` and `updated_at` metadata are excluded
from row comparison. Fixtures also exercise an upgrade with existing content,
checksum refusal, empty-database checks, rollback, and dump session settings.
New data-changing forward migrations still need tests with representative
existing rows; baseline equivalence alone does not prove a backfill is safe.

Once a database is kept, freeze its applied migration files. Publish a later
baseline as a new immutable file. Keep the old baselines and numbered history
for existing environments and restored backups. This implementation does not
retire historical upgrade paths; that would require a separate minimum-supported-
version decision. An older binary without the database's recorded baseline
refuses migration, even if later numbered files could otherwise be ignored for
an application rollback. Schema changes remain forward-only.

### Native Office citation deployment

There is no production deployment or production data, and UAT data was cleared.
Use the normal app-first deployment followed by **Deploy ingest** at the matching
revision. This release needs no maintenance window or legacy data conversion.
Migration 0016 only removes the obsolete preview columns and updates their
triggers, cache-kind constraint and account-deletion function. The retained
numbered migrations still create the earlier schema before applying this change.

Parser bundle v5 and processing plan v2 are the current contracts. Bundles
carry parsed blocks, refinement evidence and the receipt, with no image files
or Markdown; Office bundles also carry no PDF bytes. Google Docs, Sheets and
Slides import as DOCX, XLSX and PPTX; Drawings export PDF.

Set `PARSER_URL` and `PARSER_TOKEN` on retrieval for temporary Office captures.
The shared non-production parser binds `PARSER_BIND_ADDRESS` on WireGuard
instead of loopback; configure its private address and port 8091, with production
on port 8090 when provisioned. Local development needs a private route or an SSH
forward. The environment manifest includes these app-host values.

## Office maintenance window

An Office engine upgrade that changes seed output (the seed check below and the
fork's golden seed tests decide, per format) ships in a maintenance window: editing pauses, every file
with unpublished edits publishes on the old engine at platform cost, and the
deploy resets the saved states so rooms reseed on the new engine (decision in
`human/frontend/office-files.md`). An upgrade that keeps seeds only bumps
epochs. Run the window on UAT first; it doubles as the rehearsal.

Migration `0031_office_maintenance.sql` adds what the window uses: the
`office_editing_pause` row and `source_documents.reprocess_at` with its partial
index.

The commands are one binary, `office-maintenance`
([`server/cmd/office-maintenance`](../server/cmd/office-maintenance/main.go)),
run against the environment's database:

- UAT and production: in the gateway (`server`) container, which already holds `DATABASE_URL`:
  `docker exec server-<resource-uuid> /app/office-maintenance <command>`.
- Local: `cd server && go run ./cmd/office-maintenance <command>`
  (`DATABASE_URL` defaults to the compose database on `localhost:5432`).

| Command | Effect |
| --- | --- |
| `announce --at <RFC 3339> --hours <n> [--reminder]` | Tells every active account (not suspended, deleted or pending deletion) that Office editing pauses at that time for about that long: an in-app `system` notification (`office_maintenance`, shown in the reader's time zone) and, without `--reminder`, the `office-maintenance` email to owners and editors of a workspace with a docx/xlsx/pptx edited in the last 30 days, a service notice sent whatever the email preferences (time in UTC). Rerunning for the same start skips accounts already told. Prints the notifications and emails written. |
| `drain [--limit N]` | Runs while editing is live, before the window: requests a system-paid republish (`paid_by='system'`, whatever auto-process says) for each Office source with unpublished edits, oldest first. Its publication is deferred like any refresh, so open editors keep working and move onto the new version when the room empties; only a system publication while the pause is on hands editors off at once. Files that can only publish export-only, and trashed rebuilds, wait for `publish-all`. |
| `pause` | Inserts the `office_editing_pause` row. The gateway answers `423 office_editing_paused` to Office edit sessions (`source-session` for editing, `collaboration-token`, after authorization) and to seeding, and agent edits and their Undo refuse with the tool code `office_editing_paused`, also where they commit. Within about 15 seconds (5 to notice, up to 10 for the flush) every collaboration instance runs the handoff flush on each loaded Office room, persists it once and closes its writers with `source-editing-paused`; a saved editor keeps its view read-only under the maintenance banner, one with unsaved changes goes to recovery. A room that loads later is flushed on a later tick, a room mid-publication after its handoff. Authentication refuses new writers with the reason `office-editing-paused`, a paused room refuses updates from any writer that slipped through, and a client refused on reconnect goes to the same banner or recovery. Viewing and text sources keep working. |
| `publish-all [--limit N]` | Requests a publication for every Office source with unpublished edits (at most N, oldest first, with `--limit`) (checkpoint ahead of the indexed one, or pending effects), clearing a stale `refresh_error`. Files of active and blocked owners republish with the system payer (`paid_by='system'`), skipping the credit, storage and owner-state checks. Files never parsed successfully (store-only uploads and failed first parses, so maintenance never runs a first parse), trashed files, files of suspended or deletion-pending owners, and files whose system republish of the same checkpoint already failed publish export-only. A file with a refresh in flight is left for the next run. A trashed file waiting for its rebuild onto a deferred publication, with nothing saved since, is rebuilt here (`rebuild`), since the collaboration service skips trashed files. Prints one line per file and the number refused. |
| `status` | Prints whether editing is paused, every Office source still unpublished (with its running job and `refresh_error`) and the Office publication and reprocess work in flight: `source_refresh` jobs, the `parse` or `ingest` jobs they became, and system-paid reprocess jobs. Other uploads and text refreshes are not counted. Exits 1 until editing is paused and both lists are empty. A refused rebuild shows as a pending rebuild on a file with unpublished edits; the file's automatic republication, or `publish-all`, clears it. |
| `resume` | Deletes the pause row. |
| `seed-manifest` | Prints one JSON line per base a stored Office change was taken over: format, base SHA, the seed's SHA-256, the number of files, and a signed base link (lifetime `B2_LINK_TTL` seconds, default 300; pass `-e B2_LINK_TTL=3600` to `docker exec` for a slow copy). Reads only. |

**Seed check, before every BetterOffice pin bump.** Stored Office changes are
kept as their change over seed(base), so a pin that seeds any stored base
differently cannot read them (the service refuses them, it never misapplies
them). Before deploying a pin to an environment, run
`docker exec server-<resource-uuid> /app/office-maintenance seed-manifest > seeds.jsonl`
there, copy the file to a checkout of the new pin, then run
`pnpm office:seed-check seeds.jsonl` (the collaboration server's `seed-check`
subcommand, built with the new pin's native engines). It prints `same` or `changed` per
base and exits 1 when any seed changed: that pin then ships through the
window below, and its reset covers the formats listed as changed (plus any
golden seed changes). An empty manifest passes.

The same bump keeps the fork's Yjs equal to Capy's: the fork's root
`package.json` pins the `yjs` it bundles into `shared/office-checkpoint.mjs`
(the browser-side tests, dev seeding and the UAT journeys use it), and it must
be the version Capy's root `package.json` and `pnpm-lock.yaml` resolve.
Compare `grep '"yjs"' vendor/betteroffice/package.json package.json` before the
bump and bump both together. The collaboration server and its Office engines
share the fork's own `third_party/yrs`, so they need no Yjs pin.

A maintenance export-only publication makes the saved state the file's bytes
without a parser or provider call: the collaboration service exports and
uploads the candidate as for any refresh, and finalizing it replaces the file's
bytes, bumps the epoch, returns the state to NULL so it derives from the export, drops the
file's index and evicts the old room (editing is paused, so no writer needs a
flush). Outside the window a store-only file's automatic export-only
publication goes through the handoff like a refresh instead. Unless the file
never parsed successfully it is marked for reprocessing: the refresh scheduler parses and
indexes it at platform cost, whatever the workspace's auto-process setting,
once its owner is active and it is out of the trash, with one job at a time,
and retries a day later if that fails. A parse that timed out or ran out of
memory is not rerun until the file's bytes or the parser version change: the
pipeline refuses a quarantined fingerprint before calling the parser, and the
same saved state always exports the same bytes. A file never parsed
successfully stays unmarked and waits for its owner's Process, charged as its
first parse.

Steps:

1. Beforehand, deploy the maintenance tooling on the old pin, and on UAT run
   `pause`, `status` and `resume` once to check them. Pick the start and an
   expected length from the last rehearsal.
2. Seven days before: `announce --at <start> --hours <n>` (notification and
   email to every account).
3. One day before: `announce --at <start> --hours <n> --reminder` (notification
   only), then `drain --limit N` repeatedly while watching `status`, so the
   window only has the last day's edits left. N paces the shared ingest host
   and the collaboration Office worker, which also serves live editing; take
   it from the latest capacity measurement.
4. `pause`. Connected editors flush and go read-only.
5. `publish-all --limit N`, then `status`. Repeat both until `status` prints
   `0 unpublished, 0 in flight` with editing paused. A second `publish-all`
   sends each file whose system republish failed to export-only. An export
   that fails again (an engine error) stays listed with its `refresh_error`:
   the deploy waits for the operator, who fixes the file on the old engine
   with editing still paused. Nothing keeps a dropped state, so the deploy
   never runs while a file is unpublished; to abort the window instead, run
   `resume` on the old engine without deploying. The old engine's export
   losses in these publications (charts, opaque drawings) are known and
   accepted for UAT data.
6. Deploy the pin bump with that window's reset migration, still paused. The
   pin bump copies
   [`server/migrations/templates/office_window_reset.sql`](../server/migrations/templates/office_window_reset.sql)
   into the next numbered migration, fills the formats whose seeds changed,
   and ships it. Its guard is the only protection: the migration refuses to
   run, and the deploy stops, while editing is not paused or any Office source
   of those formats has unpublished edits or a refresh in flight, and it holds
   a lock on `source_documents` for its transaction. Then, in one statement,
   it releases AI edit Undo, deletes refresh candidates, bumps the epoch,
   drops the state and empties pending effects. No dropped state is kept.
7. `resume`. Tabs from before the deploy get 403 on reconnect and go to
   recovery or the banner. Editing needs the pause off, so the check comes
   after this step.
8. Check: open one file of each format in Edit, make an edit, publish it, and
   confirm quota and the `source_documents` rows (an Office edit stores a small
   `state` with `state_seed_sha256` set).

**Migration 0043 (DOCX and PPTX rebases onto seed(export)).** It drops
`source_documents.indexed_baseline` and requires every Office state to name
its seed. A DOCX or PPTX state that a publication rebased on the earlier
release is stored whole with a baseline, and the migration refuses to run
while one exists. Before deploying, run on the environment's database:

```sql
SELECT file_id, format FROM source_documents
WHERE indexed_baseline IS NOT NULL
   OR (format <> 'text' AND state IS NOT NULL AND state_seed_sha256 IS NULL);
```

No rows: deploy normally. Otherwise, on the old release, `pause`, then
`publish-all` and `status` until `status` prints `0 unpublished, 0 in flight`
(each such file publishes with no later edits, which returns its state to
NULL), deploy with editing still paused, then `resume`. The BetterOffice pin
of this release keeps every seed, so it needs no reset migration.

## Rust collaboration cutover reset (migration 0080)

The release that moves an environment from the Node collaboration server to
the Rust one (shipped with live items, 0076/0077) drops every live
collaboration state with
[`0080_cutover_reset.sql`](../server/migrations/0080_cutover_reset.sql).
States stored before the cutover keep base64 user ids as deleted map keys in
their Yjs history, their saved rows hold user ids (source clones copy them),
and a note's Yjs state may hold a pending quiz reference, which the Rust
server neither cleans on load nor stores. A database with no collaboration
rows (production today) passes and needs none of the steps.

In one transaction it:

- resets every source (DOCX, XLSX, PPTX and text) as the Office window does:
  AI edit Undo released, refresh candidates and saved rows
  (`source_document_updates`) deleted, epoch bumped, state NULL, pending
  effects emptied. Rooms re-seed from their base, the published bytes;
- deletes every note's, mindmap's and diagram's `material_yjs_documents` row
  with its `material_yjs_updates` and releases its AI edit Undo. The next open
  bootstraps it from `materials.content`. `materials.trash_restores` rises to
  the dropped `room_schema`, so the new room (`1 + trash_restores`,
  `store.MaterialRoom`) is past every old name: browser drafts of the old
  lineage open copy-only recovery, and the collaboration server refuses to
  bootstrap a room below `1 + trash_restores`, so an old token cannot revive
  the old name. Comment anchors fall back to their block and quote, as after
  a lineage compaction;
- turns each pending quiz reference left in a note's `materials.content` into
  an empty paragraph with its id and bumps the note's revision (no document
  holds one since: every validator refuses `pending`, `openwiki/embeds.md`);
- leaves live flashcard and quiz rooms: 0076/0077 drop every older one in the
  same release, and only the Rust server writes them after.

Its guard refuses, and the deploy stops at `migrate`, while any source has
unpublished edits, a refresh in flight or a pending rebuild, while Office
editing is not paused, or while a note's projection is behind its stored Yjs
state. Text sources need their own step: `publish-all` and `status` cover
Office files only, and the pause leaves text editing on. 0076 and 0077, which
run just before 0080 in the same deploy, delete every flashcard and quiz Yjs
row with no such guard: step 4 below is what keeps their unprojected edits.
Migrations commit one file at a time, so a refusal leaves 0073 to 0079
applied; see "If 0080 refuses" below. The checks make a refusal unlikely.

Dropping unpublished work is never a default: every explicit-loss `UPDATE`
below runs only after the operator has saved the listed ids, kinds and owners
with the cutover notes and Epo has approved those rows.

Steps on UAT (`docker exec` on the UAT host; find the container names with
`docker ps`):

1. `docker exec server-<uuid> /app/office-maintenance pause`. Notes and text
   sources stay editable until step 5; ask whoever uses UAT to stop editing.
2. `publish-all --limit N` and `status` until `status` prints
   `0 unpublished, 0 in flight`, as in the
   [Office maintenance window](#office-maintenance-window) step 5.
3. Text sources with unpublished edits:

   ```sql
   SELECT d.file_id, f.name, f.workspace_id, w.user_id AS owner, d.checkpoint,
          d.indexed_checkpoint, d.running_job_id, d.refresh_error
   FROM source_documents d JOIN files f ON f.id = d.file_id JOIN workspaces w ON w.id = f.workspace_id
   WHERE d.format = 'text'
     AND (d.checkpoint > d.indexed_checkpoint OR d.pending_effects <> '[]' OR d.running_job_id IS NOT NULL);
   ```

   The owner of each listed file runs **Process all** in the workspace's file
   changes (owner-paid, as any Process). Repeat until no row is left. A file
   that cannot process (a failed file, a suspended or deletion-pending owner,
   a trashed file) keeps the deploy waiting: fix it, or accept losing its
   unpublished text with
   `UPDATE source_documents SET indexed_checkpoint = checkpoint, pending_effects = '[]' WHERE file_id = '<id>'`.
4. Materials of every kind (notes, mindmaps, diagrams, quizzes, flashcard
   sets) whose projection is behind their stored Yjs state (a room projects
   once it is idle or unloads):

   ```sql
   SELECT d.material_id, m.kind, m.owner_user_id, m.trashed_at, d.stored_version,
          d.projected_version, d.projection_error
   FROM material_yjs_documents d JOIN materials m ON m.id = d.material_id
   WHERE d.projected_version < d.stored_version;
   ```

   Wait until it is empty. A row that keeps a `projection_error` (or belongs
   to a trashed material, which never projects) needs the material fixed or
   restored on the old release, or an explicit loss of its unprojected edits:
   `UPDATE material_yjs_documents SET projected_version = stored_version WHERE material_id = '<id>'`.
5. `docker stop collaboration-<uuid>` (its 60 s grace period flushes every
   room). From here nothing writes collaboration state. Run `status` and the
   queries of steps 3 and 4 again; if anything shows, `docker start
   collaboration-<uuid>`, repeat steps 2 to 4 and stop it again. This restart
   is allowed only before step 8.
6. Note any storage drift that already exists, to compare after the deploy
   (reconciliation's recount, `storageRecountSQL`, against what the triggers
   booked):

   ```sql
   SELECT u.id FROM users u
   WHERE COALESCE((SELECT used_bytes FROM user_storage WHERE user_id = u.id), 0)
       + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id = u.id), 0)
    <> COALESCE((SELECT sum(size_bytes) FROM files WHERE user_id = u.id), 0)
       + COALESCE((SELECT sum(storage_bytes) FROM source_documents WHERE user_id = u.id), 0)
       + COALESCE((SELECT sum(size_bytes) FROM editor_assets WHERE user_id = u.id AND status = 'ready'), 0)
       + COALESCE((SELECT sum(size_bytes) FROM materials WHERE owner_user_id = u.id), 0)
       + COALESCE((SELECT sum(inverse_bytes) FROM agent_edit_inverses WHERE owner_user_id = u.id), 0);
   ```

7. Back up the database (nothing writes it now):

   ```bash
   mkdir -p /root/backups
   docker exec db-<uuid> pg_dump -U capy -d capy -Fc > /root/backups/capy-uat-pre-cutover-$(date -u +%Y%m%dT%H%MZ).dump
   docker exec -i db-<uuid> pg_restore --list < /root/backups/capy-uat-pre-cutover-<UTC>.dump | head
   ```

   Keep the dump on the UAT host and copy it to the developer machine
   (`scp -i <your UAT SSH key> root@159.195.250.206:/root/backups/<file> .`,
   outside any repository). It holds UAT accounts' content: delete both copies
   once the step 10 checks pass and UAT has been used normally for a week.
8. Deploy the release (`deploy-uat`), still paused. `migrate` runs 0073 to
   0080; the Rust collaboration server starts after it. **Once `deploy-uat`
   has begun, never start the old collaboration container again**: on a
   schema where 0076/0077 ran it would bootstrap quiz and flashcard rows in
   the old Plate shape, holding user ids, which the Rust server cannot load
   and no later migration drops.
9. `resume`. Old tabs speak the Node protocol and cannot join; a reload loads
   the new app, whose drafts of old rooms open in recovery.
10. Check:
    - the storage query from step 6 lists no new user;
    - no note room from before the reset was recreated, and no pending
      reference is left:

      ```sql
      SELECT count(*) FROM material_yjs_documents d JOIN materials m ON m.id = d.material_id
      WHERE m.kind IN ('note', 'mindmap', 'diagram') AND d.room_schema <= m.trash_restores;
      SELECT count(*) FROM materials m, jsonb_array_elements(m.content->'value') b
      WHERE m.kind = 'note' AND b->>'type' = 'material_ref'
        AND (b ? 'pending' OR jsonb_typeof(b->'materialId') IS DISTINCT FROM 'string'
             OR b->>'materialId' !~ '\S');
      ```

      Both print 0;
    - open a note in Edit (its saved content shows), type, reload; open a
      text source and one Office file of each format in Edit, make an edit,
      save and publish it.

**If 0080 refuses.** The deploy stops at `migrate` with 0073 to 0079 applied.
The new gateway, collaboration and retrieval services wait on `migrate` and
never start, so no collaboration server runs: unpublished text cannot be
processed and lagging projections cannot catch up. Read the refusal message:

- "Office editing is not paused": pause (`INSERT INTO office_editing_pause
  DEFAULT VALUES ON CONFLICT DO NOTHING` in `psql`) and rerun `deploy-uat` at
  the same SHA. Nothing is lost.
- "unpublished edits" or "projection is behind": the only way forward is the
  explicit loss. List the rows with the queries of steps 3 and 4 and, for
  Office files, `SELECT file_id, format FROM source_documents WHERE
  checkpoint > indexed_checkpoint OR pending_effects <> '[]' OR running_job_id
  IS NOT NULL OR rebuild_pending`. An Office file listed there takes
  `UPDATE source_documents SET indexed_checkpoint = checkpoint,
  pending_effects = '[]', running_job_id = NULL WHERE file_id = '<id>'`; a
  pending rebuild cannot be accepted this way and needs the restore below.
  Save the ids, kinds and owners, get Epo's approval, run the `UPDATE`s for
  exactly those rows, and rerun `deploy-uat` at the same SHA; `migrate` then
  runs 0080 alone.

Never start the old collaboration container to publish or project (see step
8). To abandon the cutover instead, restore the step 7 dump into a fresh
database and redeploy the old release:

```bash
# Stop every service that connects to the database first: the stack's app
# services, Ops and the nonprod ingest lane's consumers on the ingest host.
docker exec db-<uuid> psql -U capy -d postgres -c 'DROP DATABASE capy WITH (FORCE)' -c 'CREATE DATABASE capy OWNER capy'
docker exec -i db-<uuid> pg_restore -U capy -d capy --exit-on-error < /root/backups/capy-uat-pre-cutover-<UTC>.dump
```

Restore into a fresh database, never over the refused one: `--clean` leaves
the tables 0073 to 0079 created, and the next deploy's migrations fail on
them. The dump holds the pause row, so run `resume` once the old release is
back.

**Local development.** The compose gateway runs migrations at start
(`MIGRATE=true`), so 0080 refuses on a local database with Office rows and no
pause, unprocessed text edits or a lagging projection, and the gateway does
not boot. Run `cd server && go run ./cmd/office-maintenance pause`, then
process or accept the listed rows with the `UPDATE`s above, or recreate the
local database (`docker compose down -v`; there is no backward compatibility).
