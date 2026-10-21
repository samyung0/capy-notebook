# UAT activation checklist

What to verify once the Coolify resource for `capy-notebook-uat` has real values and
has deployed at least once. Ordered by dependency: a failure at one step makes
every later step meaningless. Setup instructions live in
[`deployment-runbook.md`](deployment-runbook.md); this file is only the
verification pass.

Hostnames are the ones recorded in `deploy/.env.uat`. Never print secrets from
that file.

## App hostname cutover

After the [hostname setup](deployment-runbook.md#102-app-hostname-transition),
verify these before redirecting old browser pages:

- TLS and the SPA work at `https://app.uat.capynotebook.com`. Both app hosts
  retain tunnel-backed DNS, their site route and their scriptless `/api/*` route.
  Anonymous API requests return the expected 401, signed-in requests return JSON,
  and an SSE connection delivers a heartbeat. API responses stay uncached with
  `no-store`/`nosniff`, and API requests do not invoke the site Worker.
- Sign-in/up/out, password reset, OAuth, invitations and post-login destinations
  reach the new app. Clerk still uses the existing UAT instance. Test an old
  bookmark with `redirect_url` before enabling page redirects.
- Direct B2 upload/read, collaboration, Office view/edit/save, Google import and
  OneDrive import work on the new app. Office accepts both app origins and
  `local.uat` during overlap and carries no app credentials. Test local UAT too.
- New checkout/portal returns and product links use the new app. Existing email
  unsubscribe GET/POST requests still reach the old-host API without redirection.
- `/w/{workspaceId}` HTML and canonical/Open Graph URLs use the new app while
  summary visibility/cache behavior is unchanged. Both UAT hosts are excluded
  from indexing. Help and credits still work inside every sidebar layout.
- App, Office, gateway and collaboration release markers match the candidate,
  and browser errors retain the UAT environment and readable source maps.
- Old source drafts are saved or exported before page redirects. Confirm `/api`
  and `/api/*` are excluded, pages preserve path/query, and the first redirect is
  temporary. Preserve old API routes and origins for the remaining transition.

## 1. The stack is actually up

```bash
pnpm review:uat:smoke
```

Probes the SPA, `uat-api/healthz` and `uat-collab/healthz` — what **Deploy UAT**
publishes — and fails loudly on anything outside the accepted status range. It
reads `deploy/.env.uat` and requires `UAT_TARGET_AUTHORIZED=true`.

Ops deploys separately, so its edge has its own probe, run by **Deploy Ops** and
available as `pnpm review:ops:smoke`:

```bash
pnpm review:ops:smoke
```

The ops probe checks both directions of the Access gate. An anonymous request
must be redirected to `OPS_CF_ACCESS_ISSUER`'s login page for the ops hostname,
and the smoke service token (`UAT_OPS_ACCESS_CLIENT_ID`/`_SECRET`) must get a
`200` shell and a `401` from `/api/ops/session`. A `404` with the token means
Access passed but no Coolify service owns the hostname yet; a `401` means the
ops container rejected Cloudflare's token, usually a wrong issuer or audience.

Then, from the ingest host, confirm the import worker can reach the gateway on
WireGuard (`CAPY_PRIVATE_BIND_ADDRESS` must be set on the UAT app host):

```bash
curl --fail --silent http://10.77.0.3:8080/healthz
```

If the gateway is unhealthy, check these before anything else:

| Symptom | Cause |
| --- | --- |
| Gateway exits at startup, logs a credential that reads like a sentence | Coolify stored a `${VAR:?message}` guard's message as the variable's value. Every unset variable must be stored blank, not left absent. |
| Gateway exits complaining about the email secret | `EMAIL_UNSUBSCRIBE_SECRET` needs 32+ characters across 3 character classes. Plain hex fails. |
| Gateway exits with `unknown EMAIL_BACKEND "resend"` or `cloudflare email token is required` | Coolify still has the Resend settings. Set `EMAIL_BACKEND=cloudflare` and `CLOUDFLARE_EMAIL_TOKEN` in GitHub `uat` (deployment runbook §12.5) and redeploy. |
| Gateway refuses to start with Clerk configured | `CLERK_SECRET_KEY` or `CLERK_WEBHOOK_SECRET` is blank, or `CLERK_WEBHOOK_SECRET` is not a Svix signing secret (`whsec_` followed by base64). Both are required unless `AUTH_DISABLED` or `E2E_AUTH` is on. |
| Variables changed but the container behaves as before | Coolify's compose parse is cached and only refreshes on deploy. Redeploy rather than restart. |
| A platform model call fails with `model capacity is not configured` | Apply the Ops grants, then enter UAT’s own total and interactive reserve for each active model in Ops. |

## 2. Clerk webhook

The endpoint is `https://uat-api.capynotebook.com/webhooks/clerk` on the UAT
application's **production** instance, subscribed to `user.created`,
`user.updated`, `user.deleted`. Nothing else is handled
(`server/internal/httpapi/webhooks.go`); other events are verified, claimed and
marked processed as no-ops.

Set its signing secret as GitHub `uat` secret `CLERK_WEBHOOK_SECRET`, or upload
the updated ignored `.env.uat` through `env:push`, then redeploy.

Verify with a real signup, not with the dashboard's test button alone:

1. Sign up a synthetic account on `app.uat.capynotebook.com`.
2. Clerk's delivery log shows `200` for the `user.created` delivery.
3. `select type, processed_at, error from webhook_events order by created_at desc limit 5;` shows the event processed with no error.

The user row and default workspace appear either way, because the first
authenticated request provisions them (`server/internal/auth/middleware.go`
`admitClerkIdentity`). A `200` in the delivery log is the only proof the webhook
itself works. Until it does, profile edits made in Clerk reach the database
only through the API's hourly profile read, and deleted identities are never
purged.

A `401` from the endpoint means the signing secret does not match the instance
that sent the delivery. A `503` means `CLERK_WEBHOOK_SECRET` is still blank.

The Clerk development instance has no webhook endpoint: local runs provision
users on their first request, and webhooks are only checked here.

### Two-step verification

Set up in [deployment-runbook §12.3](deployment-runbook.md#123-clerk-a-separate-uat-application).
Signed in on `app.uat.capynotebook.com`, Settings → Account shows a
"Two-step verification" row. A missing row means the Account Portal user
profile is off. Manage opens `accounts.uat.capynotebook.com` in a new tab, and
its security section offers an authenticator app and no SMS codes.

### Cloud import consent

After the [picker setup](deployment-runbook.md#11-google-drive-and-onedrive-pickers),
verify both providers with a test account that has not previously granted file access:

- Login/signup asks for baseline identity permissions, with no Drive or Graph
  file permission request.
- In a workspace, choose Add source → Import → Google Drive or OneDrive.
  File consent appears even if that provider was used to sign in.
- After granting consent, reopen the importer and select files or a folder.
  Inspection and import succeed. OneDrive may also request its separate picker consent.
- Declining import consent leaves the Capy account usable. A later import
  click can request consent again.
- Sign out and back in, then import again. Missing file grants trigger consent
  at import time rather than during login.

## 3. Stripe webhook

`https://uat-api.capynotebook.com/webhooks/stripe`, sandbox account
`acct_1U8Djl2ZZopeANOe`, with the sandbox signing secret in
`STRIPE_WEBHOOK_SECRET` and `sk_test_…` in `STRIPE_SECRET_KEY`. UAT price IDs
are not interchangeable with live ones.

The endpoint payload API version must be `2025-08-27.basil`, matching the
deployed `stripe-go/v82` SDK. Confirm a real subscription event receives HTTP
200 and appears processed in `webhook_events`; an enabled endpoint alone does
not establish delivery compatibility.

The endpoint subscribes to exactly the ten events listed in
[deployment-runbook.md](deployment-runbook.md) ("The event selection in every
lane"), including the five that came with credit top-ups (`invoice.paid`,
`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`,
`checkout.session.async_payment_succeeded`); after a sandbox top-up,
`invoice.paid` answers 200 and is processed in `webhook_events`. The Free row of
`plan_limits` holds the 200-credit monthly allowance.

The sandbox's failed-payment settings match the runbook ("Failed payments"):
one-off invoices (auto-reload) retry the card three times a day apart and are
then marked uncollectible; subscriptions cancel and mark the invoice
uncollectible after their last retry. The app records a reload `failed` from
the `invoice.payment_failed` that carries no next attempt (and the daily
reconciliation repairs a missed one), so these settings only decide whether a
given-up invoice can still be paid from the hosted link.

Confirm the edge does not rate-limit or challenge `/webhooks/`. Both providers
burst on retry and will trip a WAF rule written for browser traffic.

## 4. The local development lane

Verify the shared local origin `https://local.uat.capynotebook.com` is present
in `COLLABORATION_ALLOWED_ORIGINS` and `OFFICE_ALLOWED_PARENT_ORIGINS` in GitHub
UAT and the deployed services. Clerk shares subdomain sessions by default; add
this origin only if the optional Clerk subdomain allowlist is enabled.

`deploy/b2-cors.uat.json` already covers it with `https://*.uat.capynotebook.com`.
On a developer machine, complete [local HTTPS and hosts setup](../scripts/dev/README.md),
then run Caddy and `pnpm dev:uat`:

| Check | Proves |
| --- | --- |
| Sign in on `https://local.uat.capynotebook.com` | Trusted local HTTPS and matching UAT Clerk instance |
| Open a note and type | Collaboration WebSocket accepted the shared local origin |
| Open an Office document | Office Worker permits the shared local parent origin |
| Upload a file | Presigned PUT passed bucket CORS, `complete` recorded the object |
| Open a citation preview | Gateway-served preview path and B2 read credentials |

A `401` on every API call with sign-in working means the browser key belongs to
a different Clerk instance than the gateway's secret key.

## 5. Data and money

- Uploads land in the UAT bucket, not production. Check the bucket name in the
  Coolify variables against `deploy/.env.uat`.
- B2 honours a read link's response overrides
  ([deployment runbook §4](deployment-runbook.md#4-backblaze-b2) step 7). Upload
  a `.html` file, a `.svg` and a PDF, and read the headers of the `url` that
  `/api/files/{id}/links` returns for each with a GET,
  `curl -s -o /dev/null -D - "$url"` (the link is signed for GET, so
  `curl -I` gets a 403): the HTML answers
  `Content-Type: application/octet-stream` and
  `Content-Disposition: attachment`, the SVG `image/svg+xml` and `attachment`,
  the PDF `application/pdf` and `inline`. The PDF, image and audio viewers
  still open their files, and the SVG still shows in the image viewer.
  Download original on the HTML file saves it instead of opening it. Any other
  type or a missing disposition means B2 ignored the overrides: stop and tell
  the Editor session.
- `user_storage` moves after an upload and after a delete. Quota accounting is
  described in [`backend-storage-quota.md`](backend-storage-quota.md).
- `APP_URL` is `https://app.uat.capynotebook.com`. Stripe returns and product email
  links follow it, so they will point at the deployed SPA even when the person
  clicking is on a dev hostname. That is expected.
- Provider keys are UAT keys with their own budget. Inference and parse metering
  is in [`observability-metering.md`](observability-metering.md).
- Product mail leaves through Cloudflare from `uat.capynotebook.com`: a sent
  `email_outbox` row carries a `<…@uat.capynotebook.com>` provider message ID,
  and the account journey reads the same `Message-ID` back from the UAT inbox
  ([deployment runbook §12.5](deployment-runbook.md#125-mail-cloudflare-email-service-and-the-uat-journey-inbox)).

## 6. Error reporting

UAT shares its Sentry projects with production and separates only by the
environment tag, so this is worth one deliberate check.

| Check | Proves |
| --- | --- |
| An error from any backend service appears in `capy-backend` under environment `uat`, not `production` | `SENTRY_ENVIRONMENT=uat` reached the containers. `APP_ENV` stays `production` here, so an unset tag files UAT errors in production's bucket |
| A browser error appears in `capy-web` with a readable stack trace | The SPA build uploaded source maps: `SENTRY_AUTH_TOKEN` was present and `SENTRY_URL` pointed at the EU host |
| The same `trace_id` finds the request in both Sentry and the gateway logs | The W3C id survived the hop, as described in [`observability-metering.md`](observability-metering.md) |

PostHog has no UAT project. An unset `VITE_POSTHOG_KEY` is the expected state,
not a misconfiguration.

## 7. Before treating UAT as shared

Everyone on this lane shares one Postgres and one bucket. The migrator records
a checksum per migration and refuses to run when an applied file changes
(`server/internal/store/migrate.go`), so anyone changing the schema switches to
the local lane: gateway, Postgres and Redis on their own machine against the
Clerk development instance. Point a local gateway at the UAT database only with
`MIGRATE=false`.

## 7. Site summary and deployment configuration

- The site is Worker `capy-notebook-uat`, with `API_ORIGIN` and `APP_ORIGIN`
  matching UAT. `/w/{workspaceId}` contains the selected summary in the initial
  HTML with JavaScript disabled; the Open workspace link requires sign-in.
- Public and link summaries return
  `Cache-Control: public, s-maxage=300, max-age=0, must-revalidate`; a repeat
  request is `CF-Cache-Status: HIT` (Workers Cache). The `Performance`
  workflow's `share_pages` job checks this for every share page. Link summaries
  include `X-Robots-Tag: noindex, nofollow`. Changing to private returns the
  same 404 as a missing workspace once the cached copy expires (five minutes). Full file/material/quiz routes
  reject anonymous requests.
- `/assets/*` on both app hosts is Worker `capy-notebook-assets-uat`
  (deployment-runbook §1): `curl -sI https://app.uat.capynotebook.com/assets/capy-missing.js`
  returns `404` with `Cache-Control: no-store` and no `text/html` (Deploy UAT's
  release check does the same), and a chunk the page loads (find one in
  `curl -s https://app.uat.capynotebook.com/ | grep -o '/assets/[^"]*\.js' | head -1`)
  returns `200` with `Cache-Control: public, max-age=31536000, immutable`. A
  `200 text/html` for the missing name means the route is not attached: the
  SPA fallback is answering, and the year-long header would pin it.
- The Office runtime's WASM and uncompressed fonts come precompressed from
  the Office Worker (deployment-runbook §1). With `W` a `.wasm` URL on
  `uat-office.capynotebook.com` (Deploy UAT's "Stage the isolated Office
  runtime" step logs every compressed file with its sizes), first, while the
  file is cold after the deploy, a HEAD and a conditional request:
  `curl -sI -H 'Accept-Encoding: br, gzip' "$W"` answers `200` with
  `content-encoding: br` and the year-long `cache-control`, and
  `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Accept-Encoding: br, gzip' -H 'If-None-Match: "capy-check"' -H 'If-Modified-Since: Sat, 17 Oct 2026 00:00:00 GMT' "$W"`
  answers `200` with the full compressed size (the Worker never answers a
  brotli file with a 304 or an empty body, so neither can sit in Workers
  Cache). Then `curl -s -o /dev/null -D - -H 'Accept-Encoding: br, gzip' "$W"`
  shows `200`, `content-type: application/wasm`, `content-encoding: br`,
  `cache-control: public, max-age=31536000, immutable` and a `content-length`
  about a fifth below the on-the-fly size (never 0, which would be an
  answer without a body kept in the cache); `curl -s -H 'Accept-Encoding: identity' "$W" | head -c 4 | od -c`
  prints `\0 a s m` (decoded for a client without brotli). A Carlito `.ttf`
  answers the same with `font/ttf`. Repeating the plain GET shows
  `cf-cache-status: HIT` with an `age` (Workers Cache), and the identity
  request still prints
  `\0 a s m` once the file is a hit.
- GitHub configuration sync/readback passed before deployment. Managed Coolify
  variables are literal, non-preview and readable for verification; unset ones
  are blank. Neither values nor fingerprints appear in runner logs.
- The interactive block frame answers at UAT's `VITE_EMBED_ORIGIN`:
  `curl -sI https://uat.capy-embed.pages.dev/` returns `200` with the
  `Content-Security-Policy` from `embed/_headers` (`default-src 'none'; …`),
  `nosniff` and `no-referrer`, and the project's `uat` deployment carries the
  release SHA. A `302` to `capypy.cloudflareaccess.com` means Access still
  guards the project's preview deployments and every block renders blank.
  A note's interactive HTML block renders, in the app and on a signed-out
  `/share/notes/…` page. Set up in
  [deployment-runbook.md §2.3](deployment-runbook.md#23-interactive-block-frame).
- The app's image policy
  ([deployment runbook §2.4](deployment-runbook.md#24-app-page-policies)):
  `curl -sI` on `/`, on a deep link such as `/workspaces/x`, on a `/w/…`
  summary and on a `/share/notes/…` page each return
  `Content-Security-Policy-Report-Only: img-src 'self' data: blob: …`, naming
  the UAT bucket host, the bank asset base, `https://img.clerk.com`,
  `https://i.ytimg.com` and a `report-uri` on the Sentry security endpoint
  with `sentry_environment=uat`. On `/` and the deep link the same header
  also carries `script-src 'self' https://clerk.uat.capynotebook.com/npm/@clerk/ …`. If
  `/` and the deep link lack it while the summary has it, Workers Assets does
  not apply `_headers` to the SPA fallback: tell the Editor session (runbook
  §2.4 has the fallback plan). A `curl -sI` on an `/assets/…` chunk and on
  `/favicon.svg` returns no `Content-Security-Policy-Report-Only`. Then open
  a workspace with a PDF, an image
  source, a note with images, a YouTube block, a diagram and a bank-copied
  quiz, and the same note shared signed out: the console shows no
  `[Report Only]` image message and `capy-web` gets no image report. Script
  reports from the SPA are expected at first (it is how we learn what the
  app needs); collect them for the Editor session rather than treating them
  as failures. A `script-src` report with `eval` from Zod's chunk is not
  expected: the SPA sets Zod to `jitless` first. The note journey already fails on any console error on the
  shared note page. The Sentry scrubbing rule (runbook §5 step 9) is in place
  before this deploy.
- The script policy on the Worker's pages (runbook §2.4): `curl -s -o
  /dev/null -D -` on a `/share/notes/…`, a `/share/quizzes/…`, a `/w/…`
  summary and a missing `/w/x` returns an enforced `Content-Security-Policy`
  whose `script-src` is `'self'`,
  `https://clerk.uat.capynotebook.com/npm/@clerk/` and, when UAT has a
  PostHog key, the `eu-assets.i.posthog.com` `/static/` and
  `/array/{key}/config.js` paths, with no `'unsafe-inline'`, no
  `'unsafe-eval'` and no `sha256-` hash, then `script-src-attr 'none'`,
  `frame-src https://uat.capy-embed.pages.dev https://www.youtube-nocookie.com`,
  `form-action 'self'`, `frame-ancestors 'self'`, `object-src 'none'` and
  `base-uri 'none'`. Web
  Analytics' automatic beacon, Zaraz and Rocket Loader are off on the zone
  (runbook §2). Signed out, open a shared note
  with a formula, a diagram, an embedded quiz, an interactive block and a
  YouTube block (play it), an audio block (play it: its
  `/p/notes/…/assets/…` request answers `302` to the bucket with
  `Cache-Control: no-store`), a shared quiz and a shared flashcard set (Clerk
  loads on those two), and a summary: each comes to life, and the console
  shows no `Refused to` message. A `Refused to` message names what the
  policy blocked: send it, with the URL, to the Editor session.
- `COLLABORATION_UAT_PUBLICATION_HOLD` is `true` in UAT's Coolify variables and
  blank in production's (the renderer refuses a production value). Without it
  the Office refusal journey's publication is never held and the journey fails.
- `RETRIEVAL_UAT_SCRIPTED_TOOLS` is `true` in UAT's Coolify variables and blank
  in production's, and the retrieval container is running (it refuses to start
  with the switch unless `SENTRY_ENVIRONMENT=uat`). Without it the chat
  journey's scripted turns reach the model and the journey fails.
- Backend `X-Capy-Release`, SPA `capy-release` and all selected ingest container
  revision labels match the release. The state's `active` agrees, `current`
  resolves to its snapshot and `pending` is absent after success.
- The nonprod parser runs hardened and owns its work volume (set up in
  [deployment-runbook.md §7.4](deployment-runbook.md#74-parser-egress-and-libreoffice-conversion)):
  on the ingest host, with `parser` the container id from §7.4,
  `docker exec "$parser" stat -c %u /run/capy-parser/work` prints `10001`,
  `docker exec "$parser" grep NoNewPrivs /proc/1/status` prints `1`, and
  `docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' "$parser"`
  prints `true [ALL]`.
- An ingest-only run verifies the already deployed backend SHA. An unfinished
  Coolify job leaves recovery pending rather than resuming incompatible workers.
- Local UI plus UAT still renders the same summary through Vite. Full-local
  Compose uses `deploy/.env` with the renamed `CAPY_*` keys.


## Manual critical-path gate

After app and nonproduction ingest are on the same candidate SHA, run **Deterministic UAT quality** with `critical_paths: true`. Verify that every lane job (`office`, `app` and `billing`) passed: every journey and each lane's cleanup and release checks. Review each lane's retained-resource report (artifact `uat-journeys-<run id>-<attempt>-<lane>`), including delayed B2 deletions and provider history. Production promotion reruns this gate. Prerequisites and cleanup retry commands are in the [journey guide](../e2e/uat/journeys/README.md).

Before launch, also run the manual top-up journey headed (`pnpm e2e:uat:journeys --project=manual --headed`,
[Hosted payment-form entry](../e2e/uat/journeys/README.md#hosted-payment-form-entry)): CI cannot fill
Stripe's payment Checkout.
