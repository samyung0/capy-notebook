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

1. **Push to UAT:** merge or push to `main`; `CI` must succeed. The **Deploy
   UAT** workflow then deploys the exact CI `head_sha` to the isolated UAT
   Coolify and Cloudflare Pages resources and calls the reusable
   **Deterministic UAT quality** workflow. Set repository variable
   `UAT_DEPLOYMENT_ENABLED=true` only after the first manual baseline.
2. **Push to production:** manually dispatch **Promote revision to production**
   from `main` with a full 40-character SHA. The workflow re-deploys that SHA
   to UAT, re-runs the same deterministic UAT gate, and only then reaches the
   protected `production` GitHub environment. Approving that environment is
   the release action.
3. **Costly review:** `$review-repository`, Codex Security, and both Strix
   workflows remain separately and explicitly invoked. They never run because
   code was pushed or deployed.

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

---

## 1. DNS & hostnames

The SPA is static. The Go gateway, the Hocuspocus sidecar, the Python
retrieval service, the ingest worker, and the operator dashboard are separate
processes. Three services have public hostnames. Cloudflare Access protects the
operator hostname before traffic reaches its origin.

| Hostname           | Serves                                             | Public DNS | Proxied              |
| ------------------ | -------------------------------------------------- | ---------- | -------------------- |
| `abcd.com`         | SPA (Cloudflare Pages / static)                    | yes        | yes                  |
| `llm.abcd.com`     | optional; only if `VITE_LLM_RUNTIME_ORIGIN` is set | optional   | yes                  |
| `www.abcd.com`     | redirect to apex                                   | yes        | yes                  |
| `api.abcd.com`     | Go gateway (`server`, :8080)                       | yes        | yes                  |
| `collab.abcd.com`  | Hocuspocus WebSocket (`collaboration`, :1234)      | yes        | yes                  |
| `ops.evonotes.com` | Go ops API + static dashboard (`ops`, :8082)       | yes        | yes, Access required |
| retrieval :8001    | Python chat/generate                               | **no**     | —                    |
| ingest worker      | Modal parse + embed                                | **no**     | —                    |
| Postgres / Redis   | —                                                  | **no**     | —                    |

The browser talks to the gateway at same-origin `/api` (`src/api/client.ts`
hard-codes `API_BASE = '/api'`; `VITE_API_URL` is only the Vite **dev** proxy).
So the apex must reverse-proxy `/api/*` to the Go process, **and**
`api.abcd.com` must still exist as its own hostname for Clerk/Stripe webhooks
(`POST /webhooks/clerk`, `POST /webhooks/stripe`). Retrieval is reached only
from the gateway over the docker network (`PIPELINE_URL=http://retrieval:8001`).

If the domain is **already** on Cloudflare, skip nameserver migration.

1. **SPA.** Cloudflare Pages custom domain on `abcd.com` and `www.abcd.com`,
   or CNAME those names to whatever static host you use. Orange cloud on.
   Coolify does not serve the SPA in the topology below.
   The quiz judge is `llm-runtime.html`, usually same-origin as the SPA.
   Isolation headers live only on that document (`COOP`/`COEP` plus
   `Document-Isolation-Policy: isolate-and-credentialless`). The SPA stays
   unisolated so Clerk, Google Picker, Stripe, and PDF.js keep working.
   Chrome 137+ isolates that iframe and gives it SharedArrayBuffer / extra
   CPU threads even when the parent is not isolated. COOP/COEP alone
   cannot. Safari and Firefox stay single-thread. A second hostname
   (`llm.abcd.com`, `VITE_LLM_RUNTIME_ORIGIN`) is optional. If you use one,
   add the SPA origin to `frame-ancestors` and set `VITE_APP_URL`. Do not
   set `Cross-Origin-Resource-Policy: same-origin` on the runtime document
   or the parent cannot embed it.
2. **API + collab.** Pick one of §1.1 Coolify (typical), §1.2 bare compose, or
   §1.3 public A records. Retrieval, worker, Postgres, and Redis stay off
   public DNS in every option.
3. **Apex `/api` rewrite.** Worker or origin rule on `abcd.com`:

   ```
   If  http.host eq "abcd.com"
   and starts_with(http.request.uri.path, "/api")
   Then reverse-proxy to https://api.abcd.com  (same path, Host: api.abcd.com)
   ```

   A 302 redirect is not enough — `fetch('/api/...')` would leave the SPA
   origin. Do **not** proxy `/webhooks/` via the apex; those URLs are configured
   in Clerk/Stripe as `https://api.abcd.com/webhooks/...`.

4. **Always Use HTTPS** and **HSTS** (start with a short max-age). SSL/TLS mode
   depends on how the origin is reached — see the option you picked.

> **Both the SPA and the API must be proxied.** Proxying only the SPA leaves
> `api.abcd.com` publicly resolvable, which is where the rate limiting, the WAF,
> and the origin's anonymity actually matter.

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
   Leave **Base Directory** empty (repository root). Contexts are relative to
   the compose file (`../server` is `server/` in the repo).
4. **Environment Variables:** paste `deploy/.env.prod.example`, fill values,
   and mark passwords/keys as secrets. Do **not** set `COMPOSE_PROFILES=ops`
   on the first deploy — ops needs the §8 roles first. Do **not** set
   `AUTH_DISABLED=true` or `MIGRATE=true`. In Advanced settings, enable
   **Include Source Commit in Build** so Coolify supplies `SOURCE_COMMIT` to
   the Compose build and runtime; the release verifier depends on it.
5. **Deploy.** Coolify runs `docker compose up --build`. `migrate` applies
   pending `NNNN_*.sql` files and exits 0; `server` / `worker` / `retrieval`
   wait on `service_completed_successfully`. An exited `migrate` container
   is expected. Open its logs and look for `applying 0001_init.sql` (first
   deploy) or only `migrations applied` (later deploys).
6. **Domains** on the resource, after the first successful deploy (Coolify
   has to parse the compose file first). Enter **`http://`** — Cloudflare
   terminates TLS. Include the container port if the UI asks for one:

   | Service                                         | Domain field                   |
   | ----------------------------------------------- | ------------------------------ |
   | `server`                                        | `http://api.abcd.com:8080`     |
   | `collaboration`                                 | `http://collab.abcd.com:1234`  |
   | `ops` (after step 8)                            | `http://ops.evonotes.com:8082` |
   | `db`, `redis`, `migrate`, `worker`, `retrieval` | no domain                      |

   Redeploy or wait for the proxy to pick up the domains.

7. Disable Coolify **Auto Deploy**. The GitHub deployment workflow updates
   `git_commit_sha`, starts the deployment through the Coolify API, polls its
   result, and verifies the reported commit. A native Coolify webhook would
   bypass the UAT and production gates.
8. After §8 grants and Access are ready: add the two Ops database URLs
   values, Access issuer/audience, `VITE_CLERK_PUBLISHABLE_KEY`, then
   `COMPOSE_PROFILES=ops`, and redeploy. Assign the ops domain. A
   `VITE_*` change rebuilds the ops image; runtime-only env does not.

CLI equivalent (same file, from the repo root):

```bash
cp deploy/.env.prod.example deploy/.env.prod
# fill deploy/.env.prod — never commit it
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod logs migrate
```

Enable ops on a later CLI deploy with `COMPOSE_PROFILES=ops` in `.env.prod`.
Storage and Stripe reconciliation is scheduled and claimed by the gateway's
database-backed runner; no Coolify task is required. To ensure today's runs are
queued and drain any pending work from a one-off container, use:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod --profile reconcile run --rm reconcile
```

The command and gateway share `reconcile_runs`, so concurrent invocations are
safe and do not create a second run for the same UTC schedule slot.

Do **not** point the tunnel at `:8080` / `:1234`. Coolify already runs Traefik
or Caddy on the host; the tunnel should hit that proxy and let it route by
`Host`. Follow [Coolify: access all resources via tunnels](https://coolify.io/docs/integrations/cloudflare/tunnels/all-resource), with these bindings:

| Hostname                     | Tunnel service                                                                                                | Coolify domain field                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `api.abcd.com`               | `http://localhost:80` (or `http://coolify-proxy:80` if `cloudflared` is a container on the `coolify` network) | `http://api.abcd.com` on the **server** service |
| `collab.abcd.com`            | same `:80`                                                                                                    | `http://collab.abcd.com` on **collaboration**   |
| `ops.evonotes.com`           | same `:80`                                                                                                    | `http://ops.evonotes.com` on **ops**            |
| retrieval, worker, db, redis | none                                                                                                          | no domain                                       |

Details that are easy to get wrong:

- Run `cloudflared` as a **Coolify service** (or systemd on the host), not as a
  service in either compose file. A compose restart must not drop every
  hostname on the server.
- Enable the compose `ops` profile in Coolify (`COMPOSE_PROFILES=ops`) only
  after §8. Set the `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SENTRY_DSN_OPS`, and
  `RELEASE_SHA` / `SOURCE_COMMIT` build values before that ops image build.
  Runtime-only changes do not rebuild the static dashboard.
- Enter Coolify domains as **`http://`**. Cloudflare terminates TLS. `https://`
  here makes Traefik request Let's Encrypt and usually 301-loops.
- App env vars still use `https://` / `wss://` — those are what browsers, Clerk,
  and Stripe see (see the block below).
- Cloudflare SSL/TLS **Full** is enough: the tunnel is already encrypted, and
  the last hop is HTTP to the proxy. **Full (strict)** needs origin certs —
  Coolify's [full TLS guide](https://coolify.io/docs/integrations/cloudflare/tunnels/full-tls).
- Do not publish `8080` / `1234` / `8001` on the host. Traefik + the tunnel is
  the public path. `:8001` must stay private.
- Chat SSE and collab WebSockets both pass through Traefik. If streams die at
  ~60–100s, raise the proxy read timeout on `api.abcd.com`. Cloudflare Tunnel
  itself is not subject to the 100s orange-cloud proxy timeout; Traefik still
  is.

In the tunnel's Public Hostnames page, add `ops.evonotes.com` with service
`http://localhost:80`, or the Coolify proxy address from the table. Cloudflare
creates the proxied CNAME to the tunnel. Do not also create an A or AAAA record
for `ops.evonotes.com`.

### 1.2 Bare docker compose + Tunnel

On a host running `deploy/docker-compose.yml` without Coolify's proxy,
`cloudflared` publishes the app ports directly. Cloudflare creates the DNS
records; do **not** also point A records at the VPS IP.

```
api.abcd.com     → http://localhost:8080  (the `server` container)
collab.abcd.com  → http://localhost:1234  (the `collaboration` container)
ops.evonotes.com → http://localhost:8082  (the `ops` container)
```

SSL/TLS **Full (strict)** is appropriate here if the origin speaks TLS.
Leave :8001, Postgres and Redis unpublished. Bind :8082 to localhost as shown
in compose so the tunnel can reach it but the internet cannot bypass Access.
This is the origin lockdown in §3.

### 1.3 A/AAAA instead of a tunnel

`A`/`AAAA` for `api.abcd.com` and `collab.abcd.com` to the VPS, **orange cloud
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
120/minute editor class are not env-overridable.

Gateway env once those hostnames exist:

```
APP_URL=https://abcd.com
CORS_ALLOWED_ORIGINS=https://abcd.com,https://www.abcd.com
COLLABORATION_URL=wss://collab.abcd.com
COLLABORATION_ALLOWED_ORIGINS=https://abcd.com
```

Ops uses one read/auth role and one shared admin-actions role. The admin pool
opens lazily only after the application authorizes a registry Save or a
reconciliation request:

```
OPS_DATABASE_URL=postgres://evo_ops:<password>@<private-postgres-host>:5432/evo?sslmode=require
OPS_ADMIN_DATABASE_URL=postgres://evo_ops_admin:<password>@<private-postgres-host>:5432/evo?sslmode=require
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
queue writes, and `model_configs` DELETE. Missing required column grants also
stop startup. Local owner URLs are accepted only with
`APP_ENV=development` and `OPS_UNSAFE_DEVELOPMENT=true`. Auth bypasses also
require their individual `OPS_ACCESS_DISABLED=true` or
`OPS_AUTH_DISABLED=true` switch. None of these unsafe settings is accepted
outside development.

Set `VITE_CLERK_PUBLISHABLE_KEY` at image build time and `CLERK_SECRET_KEY` at
runtime. They must belong to the same Clerk instance as the product. Start the
service with the compose `ops` profile. Do not set any database URL in browser
build arguments.

In Clerk, add `https://ops.evonotes.com` to the production instance's allowed
origins and redirect URLs. Keep `https://abcd.com` and `https://www.abcd.com`
if the product uses both. Do not create a second Clerk instance: the Clerk
subject must continue to match `users.id` and `operators.user_id`. The Clerk
webhook remains `https://api.abcd.com/webhooks/clerk`; ops does not accept
webhooks. Stripe remains `https://api.abcd.com/webhooks/stripe`. B2 CORS
`allowedOrigins` is the SPA origin, not `api.` or `ops.`.

---

## 2. Cloudflare — rules

**Rate limiting rules** (free tier allows one; Pro allows several). The edge
layer only handles volumetric floods — semantic limits are in the gateway.

```
Rule:  (
         (http.host eq "api.abcd.com")
         or (http.host eq "abcd.com" and starts_with(http.request.uri.path, "/api"))
       )
       and not starts_with(http.request.uri.path, "/webhooks/")
Rate:  100 requests per 10 seconds per IP
Action: Block, 60s timeout
```

The window on the free tier is fixed at 10 seconds, which is why anything
expressed in requests-per-hour lives in the application instead.

**Excluding `/webhooks/` is not optional.** Stripe and Clerk burst deliveries
and retries from a small set of IPs. Rate limiting them produces subscription
and identity state that silently drifts out of sync, and the failure surfaces
days later as a user on the wrong plan.

**WAF custom rules:**

```
Skip all security rules for:
  starts_with(http.request.uri.path, "/webhooks/")
```

**Do not enable Bot Fight Mode.** It cannot be skipped per-path, so it
challenges webhook deliveries, which cannot solve a JavaScript challenge.

**Cache rules:** bypass cache for `api.abcd.com`, `collab.abcd.com`, and
`ops.evonotes.com` entirely. A cached SSE or WebSocket response breaks
streaming. Cached operator responses can disclose one operator's data to
another.

For `ops.evonotes.com`, add a response-header rule with
`Cache-Control: private, no-store` and
`X-Robots-Tag: noindex, nofollow, noarchive`. Keep the dashboard's HTML
`robots` meta tag too. These headers prevent accidental cache and search
indexing; they are not access controls.

### 2.1 Cloudflare Access for ops

Create a self-hosted Access application for `https://ops.evonotes.com/*`.
Use an Allow policy that names each operator email, or a company identity
provider group that contains only operators. Do not use `Emails ending in` for
a mixed-use domain, and do not add a Bypass or Everyone policy. A short session
duration, such as eight hours, limits a forgotten browser session.

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

Test both failure paths before granting an operator row:

1. An email outside the Access policy must stop at Cloudflare.
2. An allowed Access identity without a Clerk session can load the sign-in
   shell, but `/api/ops/session` must receive `401`.
3. A valid Clerk user missing from `operators` must receive `403`.
4. A `viewer` without `write_registry` must receive `403` from registry Save
   without opening the writer database pool.

**Timeouts:** the default 100 s orange-cloud proxy read timeout will cut long
chat streams and Modal parse waits. A Cloudflare Tunnel is not subject to it.
Coolify's Traefik/Caddy in front of the tunnel still has its own read timeout —
raise that on `api.abcd.com` if streams die around a minute.

### 2.2 Drive import Queue relay

Drive and OneDrive imports require the paid Workers plan. The relay buffers one
bounded file per isolate so its queue consumer is intentionally pinned to batch
size 1 and concurrency 1. Do not raise concurrency until production memory
telemetry shows enough headroom at the plan's largest upload.
The main queue retries every five minutes up to 20 times so temporary provider
or ingest-capacity pressure does not discard an accepted import. The DLQ also
retries every five minutes up to 50 times; its retry window must remain longer
than the gateway's 12-minute attempt lease before terminal cleanup can succeed.

Create both queues once, then deploy the Worker:

```sh
cd workers/drive-import-relay
pnpm exec wrangler queues create evo-drive-imports
pnpm exec wrangler queues create evo-drive-imports-dlq
pnpm exec wrangler secret put IMPORT_RELAY_SECRET
pnpm exec wrangler deploy
```

Before deploy, replace `API_BASE_URL` in `wrangler.jsonc` with the public gateway
origin, for example `https://api.abcd.com`. Generate the shared secret with
`openssl rand -hex 32`; give the exact same value to the Worker secret and the
gateway's `IMPORT_RELAY_SECRET`. Set the gateway's
`IMPORT_RELAY_ENQUEUE_URL` to the deployed Worker URL plus `/enqueue`.
Both gateway variables must be present or both absent; the latter disables new
imports with `503` instead of creating stranded reservations.

The Worker enqueue endpoint is public but accepts only a timestamped
HMAC-SHA256 request. Worker callbacks use the same canonical signature, and
each import attempt also has a short database lease. The Queue message contains
only an opaque job id. Microsoft downloads use a one-file preauthenticated URL;
the Microsoft OAuth bearer is never sent to Worker execution.
Every attempt receives a distinct incoming object key. A stale presigned PUT
therefore cannot replace bytes uploaded by a newer lease.

Keep the DLQ consumer configured. It calls the gateway's terminal cleanup route,
which marks the job failed and releases its upload reservation. As a backstop,
the normal upload-session sweeper expires any job that never reaches the DLQ.
The same minute worker reopens expired attempt leases. It reopens pending
deliveries after six hours, beyond the roughly four-hour DLQ retry horizon, so
a live DLQ callback cannot fail a newly dispatched generation. Losing both a
Queue delivery and its DLQ callback therefore does not strand a job for a day.
Gateway-to-Worker dispatch uses capped exponential backoff and fails
non-retryable 4xx responses immediately.
An unsigned `POST /enqueue` must return `401`; a signed import should move
`source_import_jobs.status` from `pending` to `running` and then `succeeded`.

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

---

## 4. Backblaze B2

1. Create the bucket **private**. Public buckets make every presigned URL
   pointless.
2. Create an application key **scoped to that bucket only**, with
   `listBuckets`, `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`.
   Record `B2_KEY_ID` / `B2_APP_KEY` — the secret is shown once.
3. Set `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, and `B2_PRESIGN_TTL` (default
   900 s).
4. **CORS rules on the bucket.** The browser uploads directly to B2 via
   presigned PUT, so B2 itself must allow the SPA origin:

   ```
   allowedOrigins: ["https://abcd.com"]
   allowedOperations: ["s3_put", "s3_get", "s3_head"]
   allowedHeaders: ["*"]
   exposeHeaders: ["etag"]
   maxAgeSeconds: 3600
   ```

   `etag` must be exposed or upload completion cannot verify what was stored.

5. **Lifecycle rule:** delete unfinished large-file uploads after 1 day. An
   aborted multipart upload is billed indefinitely and is invisible in the
   bucket listing.
6. Leave file versioning off, or set versions to expire after 1 day. With
   versioning on, the blob reaper's deletes only hide objects and storage grows
   without bound.

Do **not** put a B2 lifecycle rule on `parsed/` or `captions/`. Those prefixes
are owned by `artifact_cache` and the blob reaper: a lifecycle rule would
delete objects the `blobs` table still believes are live. Caption entries
expire by TTL-since-last-use (default 90 days); parse zips are dropped on
successful ingest, with the same sweeper as an orphan reaper.

Both TTLs come from `EVO_CAPTION_CACHE_TTL_DAYS` and `EVO_PARSE_ZIP_TTL_HOURS`.
The gateway and the ingest worker each run the same sweep, so give both services
the same values — whichever process sweeps first applies its own, and a
disagreement means the configured TTL is not the one in effect. The worker
sweeps on a 5-minute timer while the queue is idle, not on every 2-second poll.

### Ingest worker replicas

`WORKER_REPLICAS` in `deploy/docker-compose.yml` (default 1) is the number of
ingest worker containers. `claim_job` uses `FOR UPDATE SKIP LOCKED`, so replicas
share the queue without extra coordination. Each replica runs one job at a time.
Parse has its own cap (72 HTTP / ~24 OCR); extra parse jobs stay `pending`
instead of opening more Modal boxes. Replicas above that cap mostly wait.

Connection budget after the worker's sync pool (`max_size=4`) plus the async
retrieval pool (`max_size=8`): **12 connections per replica**. Against default
Postgres `max_connections=100`, and alongside the gateway, retrieval service,
and collaboration:

- 3 replicas (36 worker connections) is comfortable.
- Beyond ~5 replicas, raise `max_connections` or put pgbouncer in front.

Provider rate limits scale with replica count. `EVO_CAPTION_CONCURRENCY` is 8
_per job_, so N replicas means up to 8N concurrent vision calls.

Do not scale above 1 until the worker running in production includes
lease-keyed content-claim steal. A waiter on a second replica can otherwise
delete a live creator's `rag_contents` row.

> B2 egress is **not** in `usage_events` — the browser fetches presigned URLs
> directly and the gateway never sees the transfer. B2's own reporting is the
> only source. Set a spend alert.

---

## 5. Sentry

1. Add `ops` as the fifth compose-service project beside `gateway`,
   `retrieval`, `worker`, and `collaboration`. Keep the existing SPA browser
   project separate. Operator failures must not share product alert rules.
2. Set `SENTRY_DSN_OPS` for the Go process and `VITE_SENTRY_DSN_OPS` for the
   ops browser build. A browser DSN is public. It must never contain a server
   auth token.
3. Set `RELEASE_SHA` / `VITE_RELEASE_SHA` in CI, and upload SPA source maps —
   without them every browser stack trace is minified and useless.
4. Set an **inbound filter** for `AbortError` as a second line of defence
   behind the client-side `ignoreErrors`.
5. Set a spend cap. Default sampling can burn a month's quota in a day during
   an incident, which is exactly when reporting must not stop.

---

## 6. PostHog

1. Create a project; use the **EU** host if any user is in the EU.
2. Set `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`.
3. Under project settings, **enable "Authorized URLs"** for `https://abcd.com`
   only, or anyone can post events into your project with the public key.
4. Do **not** enable autocapture or session replay defaults in the UI; both are
   configured in code and the UI settings will override intent silently.

---

## 7. Dedicated parser VM

The Netcup VM runs the ingest workers, parser, and host sampler. Uploaded bytes
move from the Cloudflare relay to B2 and from B2 to this VM; they do not traverse
the Go application process.

1. Apply `deploy/ansible/app-host/playbook.yml` to build the app side of the
   point-to-point WireGuard service network, then put its displayed public key
   in the parser inventory. The app host uses `10.77.0.1/32` and the parser VM
   uses `10.77.0.2/32`. Netcup's
   [community WireGuard guide](https://community.netcup.com/en/tutorials/how-to-setup-wireguard-ubuntu)
   covers the provider-specific setup and applies to Debian. Do not add a
   default route, DNS override, NAT, or forwarding: this tunnel carries only
   parser HTTP, Postgres, and Redis.
2. On the app host, set `EVO_PRIVATE_BIND_ADDRESS=10.77.0.1` before deploying
   this branch. The app-host playbook stops the confirmed-unused native
   PostgreSQL cluster but preserves its files under `/var/lib/postgresql`.
   `deploy/docker-compose.prod.yml` publishes Evo Postgres and Redis only on
   WireGuard. The default bind address is loopback, never the public interface.
3. Copy `deploy/ansible/parser-vm/inventory.example.yml` to the ignored
   `inventory.yml`, encrypt it with Ansible Vault, and follow that directory's
   README. The first pass keeps password SSH enabled. Verify key login in a
   second terminal before setting `parser_harden_ssh: true`.
4. Store the values from `deploy/parser-vm.env.example` in encrypted
   `parser_env`. The parser binds only to `PARSER_BIND_ADDRESS`; its bearer token
   remains defense in depth. The measured default is generous selective OCR.
   Initial limits are eight queued HTTP requests, four digital Marker slots, and
   two OCR-heavy slots. All-page OCR remains an explicit benchmark/retry mode.
5. Apply the app migration before starting `host-sampler`, because it writes
   `parse_host_samples`. Start `evo-parser.service`, wait for model warmup, and
   verify `/healthz` through WireGuard. No parser port may listen on the public
   address.
6. Run `bench/parsers/accuracy_report.py` across representative PDF, image,
   DOCX, PPTX, and XLSX inputs in all three modes. Review every rejected row and
   the rendered page comparisons. Run the 1/2/4/6/8 sweep; production remains
   at two OCR-heavy jobs unless four preserves at least 3 GiB headroom, uses
   no swap, and materially improves throughput.
7. Disable the app host's `legacy-modal-worker` profile only after a real ingest
   succeeds from the VM. Main retains the Modal deployment. Rollback stops
   `evo-parser.service`, redeploys `main`, and re-enables its worker; different
   parser versions and mode fingerprints prevent artifact confusion.

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
   once so `users.id` exists. Copy their Clerk user id, then use a database
   owner session:

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

3. Create two roles with independent random passwords. The grants name every
   readable column. In particular, neither role can read `messages`, file
   `content` or blob paths, job `payload`, email recipients or `payload`, or
   `usage_events.metadata`:

   ```sql
   CREATE ROLE evo_ops LOGIN NOINHERIT PASSWORD '<read-password>';
   CREATE ROLE evo_ops_admin LOGIN NOINHERIT PASSWORD '<admin-password>';

   GRANT CONNECT ON DATABASE evo
     TO evo_ops, evo_ops_admin;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   GRANT USAGE ON SCHEMA public
     TO evo_ops, evo_ops_admin;

   GRANT SELECT (
     user_id, period_start, used_micros, reserved_micros
   ) ON user_credits TO evo_ops;
   GRANT SELECT (
     id, actor_user_id, trace_id, surface, paid_by, status,
     created_at, expires_at, settled_at
   ) ON provider_sessions TO evo_ops;
   GRANT SELECT (
     id, reservation_id, actor_user_id, kind, purpose, status, thinking,
     cached_read_tokens, cache_write_tokens, reasoning_tokens, cache_anomaly,
     context_system_tokens, context_tool_tokens,
     context_conversation_tokens, context_total_tokens,
     context_window_tokens, context_counting_method,
     context_counting_version, opened_at, applied_at
   ) ON provider_calls TO evo_ops;
   GRANT SELECT (
     id, job_type, trigger, status, requested_by_id, requested_by_name,
     requested_at, started_at, finished_at, scanned_count, repaired_count,
     error_count, error
   ) ON reconcile_runs TO evo_ops;
   GRANT SELECT (
     id, run_id, event_type, subject_type, subject_id, actor_user_id,
     metadata, created_at
   ) ON reconciliation_report TO evo_ops;
   GRANT SELECT (
     id, occurred_at, actor_user_id, actor_role, action,
     target_type, target_id, outcome, trace_id, metadata
   ) ON operator_audit_events TO evo_ops;
   GRANT SELECT (
     user_id, used_bytes, reserved_bytes
   ) ON user_storage TO evo_ops;
   GRANT SELECT (
     user_id, delta_bytes
   ) ON user_storage_deltas TO evo_ops;
   GRANT SELECT (
     id, name, email, plan_tier, deletion_requested_at, purge_after,
     deleted_at, suspended_at, suspended_reason, created_at
   ) ON users TO evo_ops;
   GRANT SELECT (user_id, current_period_end)
     ON user_subscriptions TO evo_ops;
   GRANT SELECT (
     id, user_id, name, embedding_provider_slug, embedding_model_slug,
     embedding_model_version,
     embedding_dim, last_accessed_at
   ) ON workspaces TO evo_ops;
   GRANT SELECT (user_id, role) ON operators TO evo_ops;
   GRANT SELECT (role, permission) ON ops_permissions TO evo_ops;
   GRANT SELECT (
     version, provider_name, model_name, provider_slug, model_slug,
     platform_enabled, byok_enabled, thinking_levels, default_thinking,
     context_window_tokens, params, surfaces, micros_per_input_token,
     micros_per_cached_input_token, micros_per_output_token, enabled,
     is_default_for, created_at, updated_at, created_by, updated_by
   ) ON model_configs TO evo_ops;
   GRANT SELECT (id, version, updated_at) ON model_registry_state TO evo_ops;
   GRANT SELECT ON ops_assistant_turns TO evo_ops;
   GRANT SELECT (id, workspace_id)
     ON files TO evo_ops;
   GRANT SELECT (
     status, locked_at, lease_expires_at, updated_at
   ) ON jobs TO evo_ops;
   GRANT SELECT (
     status, updated_at
   ) ON email_outbox TO evo_ops;
   GRANT SELECT (
     id, trace_id, actor_user_id, kind, surface, provider, model,
     thinking, catalog_provider_slug, catalog_model_slug, model_version,
     input_tokens, output_tokens, units, unit,
     parse_pages, parse_ocr_pages, parse_cpu_milliseconds,
     parse_elapsed_milliseconds,
     credit_micros, reservation_id, provider_call_id, created_at
   ) ON usage_events TO evo_ops;

   GRANT EXECUTE ON FUNCTION touch_operator_seen(text) TO evo_ops;
   GRANT EXECUTE ON FUNCTION request_reconciliation(text, text, text)
     TO evo_ops_admin;
   GRANT EXECUTE ON FUNCTION record_registry_audit(
     text, bigint, bigint, bigint, bigint, bigint, text
   )
     TO evo_ops_admin;

   GRANT SELECT (
     version, provider_name, model_name, provider_slug, model_slug,
     platform_enabled, byok_enabled, thinking_levels, default_thinking,
     context_window_tokens, params, surfaces, micros_per_input_token,
     micros_per_cached_input_token, micros_per_output_token, enabled,
     is_default_for, created_at, updated_at, created_by, updated_by
   ) ON model_configs TO evo_ops_admin;
   GRANT SELECT (id, version, updated_at)
     ON model_registry_state TO evo_ops_admin;
   GRANT SELECT (
     id, embedding_provider_slug, embedding_model_slug,
     embedding_model_version, embedding_dim
   ) ON workspaces TO evo_ops_admin;
   GRANT SELECT (
     id, email, locale,
     chat_model_provider_slug, chat_model_slug,
     generate_model_provider_slug, generate_model_slug,
     editor_model_provider_slug, editor_model_slug,
     quiz_model_provider_slug, quiz_model_slug
   ) ON users TO evo_ops_admin;
   GRANT SELECT (
     user_id, email_workspace_invite, email_membership, email_billing
   ) ON notification_prefs TO evo_ops_admin;
   GRANT SELECT (
     id, user_id, kind, data, href, workspace_id, workspace_invite_id,
     at, read_at
   ) ON notifications TO evo_ops_admin;
   GRANT SELECT (idempotency_key) ON email_outbox TO evo_ops_admin;
   GRANT SELECT (user_id, provider_slug)
     ON user_llm_credentials TO evo_ops_admin;

   GRANT INSERT (
     version, provider_name, model_name, provider_slug, model_slug,
     platform_enabled, byok_enabled, thinking_levels, default_thinking,
     context_window_tokens, params, surfaces, micros_per_input_token,
     micros_per_cached_input_token, micros_per_output_token, enabled,
     is_default_for, created_by, updated_by
   ) ON model_configs TO evo_ops_admin;
   GRANT UPDATE ON model_configs TO evo_ops_admin;
   GRANT EXECUTE ON FUNCTION model_configs_thinking_ok(text[], text[], text)
     TO evo_ops_admin;
   GRANT UPDATE (version, updated_at)
     ON model_registry_state TO evo_ops_admin;
   GRANT UPDATE (
     chat_model_provider_slug, chat_model_slug,
     generate_model_provider_slug, generate_model_slug,
     editor_model_provider_slug, editor_model_slug,
     quiz_model_provider_slug, quiz_model_slug,
     updated_at
   ) ON users TO evo_ops_admin;
   GRANT INSERT (
     id, user_id, kind, data, href, workspace_id, workspace_invite_id, at
   ) ON notifications TO evo_ops_admin;
   GRANT INSERT (
     id, user_id, to_email, template, locale, payload, idempotency_key
   ) ON email_outbox TO evo_ops_admin;
   ```

   `ops_assistant_turns` exposes only an assistant message id, owning user id,
   lifecycle status, trace id, and timestamp. Do not replace that view grant
   with `SELECT` on `messages`.
   `touch_operator_seen`, `request_reconciliation`, and
   `record_registry_audit` are `SECURITY DEFINER`.
   The read/auth role cannot update `operators` directly. The admin-actions
   role cannot write the reconciliation queue or `operator_audit_events`
   directly. The two action functions check the operator token again and append
   the audit event inside the mutation transaction. Audit triggers reject
   `UPDATE`, `DELETE`, and `TRUNCATE`, including attempts by the database owner.
   `model_configs_thinking_ok` is the CHECK helper for registry inserts; grant
   EXECUTE to `evo_ops_admin` only. Do not grant `UPDATE` on `operators`,
   `DELETE` on `model_configs`, audit-table writes, schema creation, sequence access, or generic
   `ALL TABLES IN SCHEMA` privileges.

   PostgreSQL grants function execution to `PUBLIC` by default. The two
   `REVOKE EXECUTE` statements above close that path for existing and future
   functions. Database owners keep their implicit privileges. If another
   production service uses a non-owner database role, grant that role the exact
   functions it calls before applying the global revoke.

4. Put the two URLs in `OPS_DATABASE_URL` and `OPS_ADMIN_DATABASE_URL`. Restart
   ops, verify `current_user` through both pools, and check that neither role
   belongs to a broader role. Viewer mutation requests must fail before the
   application opens the admin pool.

---

## 9. Changing models in the registry

Most surfaces are safe to retarget from the ops dashboard: chat, generate,
editor, ingest and vision all resolve a pin per request or per job, so a new
default applies to the next one and everything in flight keeps what it had.

The dashboard deliberately disallows aliases: each grid row is the natural
`(provider_slug, model_slug)` identity. Each surface cell may still select a
different immutable version of that identity. User preferences store the same
two slugs, so there is no second hidden key namespace.

Embedding is not one of those, and neither is deleting any row.

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
  `enabled=false`, `DELETE`, stripping or adding the embedding surface, and
  in-place changes to the pin, `model_slug`, or `params`
  (`protect_embedding_model_configs`). Same width from another model is a
  different space and a different table. Add a `rag_chunk_vectors_*` table,
  an allowlist entry in both languages, a `model_configs` row with
  `params.vector_table`, then in one transaction clear the old
  `is_default_for` and mark the new row (Postgres refuses two defaults for
  the same surface). Bump `model_registry_state.version`. Old workspaces
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

| Check                                                                          | Expected                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `curl -sI https://api.abcd.com/healthz`                                        | `x-request-id` header present                    |
| Send a chat turn, then `SELECT * FROM usage_events ORDER BY id DESC LIMIT 5`   | rows with non-zero `output_tokens`               |
| Same `trace_id` searched in Sentry and in gateway logs                         | both return the request                          |
| `SELECT * FROM provider_sessions WHERE status='open' AND expires_at < now()` | empty after a minute (sweeper is running)        |
| Open Ops Overview after sending a chat turn                                   | current-month usage appears within 30 seconds    |
| `curl -sI https://ops.evonotes.com` without Access credentials                 | Cloudflare Access login or denial, never the app |
| Sign in through Access + Clerk as a user absent from `operators`               | `403` from the ops service                       |
| Sign in as an operator with `role='viewer'`, then submit registry Save         | `403`; registry writer pool remains unopened     |
| `curl -sI http://127.0.0.1:8082/healthz` on the host                           | `200`; :8082 is not reachable from another host  |
| Fire >200 AI requests in an hour, or 16 in a minute                            | `429` with `code: "ai_rate_limited"`             |
| Open 6 platform-paid AI calls at once                                          | 6th returns `429 too_many_streams`               |
| Hit the origin IP directly                                                     | connection refused                               |
| Coolify: `ss`/`docker ps` shows `:8080`/`:1234`/`:8082` bound on `0.0.0.0`     | wrong: only Traefik `:80` should be public       |

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
2. On the Clerk Google connection, add extra scope
   `https://www.googleapis.com/auth/drive.file`.
3. Create a Microsoft Entra web app (or reuse one) for Clerk. Add Graph
   delegated `Files.Read` and `offline_access`.
4. On the Clerk Microsoft connection, add extra scopes `Files.Read` and
   `offline_access`.

The Go gateway downloads with Clerk's token wallet. Same Google Cloud project
must own the Picker API key, the Picker app id, and the Clerk Google client.
`setAppId` is what lets `drive.file` open a file the user just picked.

### Google Picker

1. Enable **Google Picker API** and **Google Drive API** on that project.
2. Create an API key. Restrict it to the Picker API.
3. Copy the **project number** (not the project id). That is the app id.
4. Set on the SPA build:

```
VITE_GOOGLE_PICKER_API_KEY=...
VITE_GOOGLE_PICKER_APP_ID=...
```

Missing either variable shows a toast instead of a blank picker. `drive.file`
is a restricted Google scope. A verification review may be required before
unverified users can connect.

### OneDrive File Picker v8 (MSAL)

Create a **second** Entra app. This is a single-page application, not the Clerk
web app.

1. Authentication. Platform **Single-page application**. Redirect URIs are
   `{SPA origin}/msal-redirect.html`, for example
   `http://localhost:5173/msal-redirect.html` and
   `https://abcd.com/msal-redirect.html`. Enable access tokens and ID tokens.
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

This section is the manual counterpart to the repository's review automation.
There is no deployed UAT system yet, so complete it only when rapid local
development has settled enough to keep an environment running. Until then,
source review and local tests work normally; remote smoke, authenticated
authorization tests, and Strix UAT scans must remain disabled.

Start the guided setup from the repository root:

```bash
scripts/review/setup-uat.sh
```

The wizard records local values in ignored `review/.env.uat` with mode `0600`.
When the GitHub CLI is authenticated, it can also populate the repository
variables and `uat` environment secrets listed below. It cannot create Clerk,
Stripe, Coolify, DNS, database, or bucket resources; those remain deliberate
human actions.

### 12.1 Isolation model

UAT should resemble production without sharing state or credentials with it.

| Resource            | Local development    | UAT                                             | Production                                   |
| ------------------- | -------------------- | ----------------------------------------------- | -------------------------------------------- |
| App compute         | local compose        | separate Coolify environment/resource           | production Coolify environment/resource      |
| Postgres and Redis  | disposable/local     | dedicated UAT instances/volumes                 | production instances/volumes                 |
| Blob storage        | local/test bucket    | dedicated private UAT bucket and key            | production private bucket and key            |
| Clerk               | development instance | separate Clerk application, Production instance | production application's Production instance |
| Stripe              | sandbox/test data    | named UAT sandbox                               | live mode                                    |
| Users and content   | developer fixtures   | synthetic accounts and fixtures only            | real users and content                       |
| Scanner credentials | local only           | GitHub `uat` environment                        | never supplied to scanners                   |

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
3. Create a separate private B2 bucket and bucket-scoped key. Apply the same
   CORS and lifecycle policy described in §4, substituting only the UAT SPA
   origin. Do not point UAT at the production bucket.
4. Choose explicit hostnames, for example `uat.example.com`,
   `api.uat.example.com`, `collab.uat.example.com`, and optionally
   `ops.uat.example.com`. Configure DNS, Cloudflare, tunnel routing, origin
   lockdown, cache bypass, WebSocket support, and `/api` reverse proxy using
   §§1–3. Do not use wildcard host authorization for review tooling.
5. Copy `deploy/.env.prod.example` into the UAT resource and fill it with only
   UAT values. Set `APP_ENV=production`; UAT must exercise production safety
   checks. Use the UAT origins in `APP_URL`, CORS, collaboration, OAuth, Sentry,
   and browser build variables.
6. Create a separate Cloudflare Pages project for the UAT SPA. Either create it
   as Direct Upload or disable builds on an existing Git-integrated project;
   GitHub Actions deploys `dist/` with Wrangler. Set its production branch to
   `main` and attach only the UAT domains.
7. Deploy once, inspect the `migrate` container, and verify all public routes
   resolve through Cloudflare. This initial deployment may use a unique random
   temporary Clerk webhook secret until the public UAT webhook URL exists.
   Replace it with Clerk's actual endpoint signing secret and redeploy before
   creating fixtures.

Give UAT a visible banner and separate Sentry/PostHog projects if practical.
Budget alerts and conservative rate limits belong on UAT too: automated
security exploration can generate more traffic and LLM work than a human test.

### 12.3 Clerk: a separate UAT application

Create a separate Clerk application named `Evo Notes UAT`. Use its Production
instance for UAT so custom domains, production-key behavior, cookies, webhook
verification, and browser restrictions match production. This does not mean
sharing the real production Clerk application: UAT and production must have
different user directories and keys. Within the real production environment,
the product and ops dashboard still use the same production Clerk instance as
required by §1.4.

In the Clerk dashboard:

1. Activate the UAT application's Production instance and configure the UAT
   application domain. Complete any required Clerk DNS records.
2. Enable the same sign-in methods, session lifetime, organization settings,
   and restrictions intended for production. If Google or Microsoft OAuth is
   enabled, create separate UAT OAuth credentials and UAT redirect URLs.
3. Add the UAT SPA and ops origins to the instance's allowed origins and
   redirect URLs. Do not add production origins unless the provider explicitly
   requires them.
4. Create `https://api.uat.example.com/webhooks/clerk`, selecting the same
   events as production. Copy its signing secret into UAT
   `CLERK_WEBHOOK_SECRET` and redeploy.
5. Put the UAT publishable key in the SPA build as
   `VITE_CLERK_PUBLISHABLE_KEY`, and the UAT secret key in the server as
   `CLERK_SECRET_KEY`. The GitHub authenticated tests receive the same values
   as `CLERK_PUBLISHABLE_KEY` and the protected `CLERK_SECRET_KEY` environment
   secret. Never put the secret key in a repository variable or browser build.

Create five synthetic accounts. Dedicated inbox aliases are sufficient if the
mail provider routes them separately:

- owner: creates the private fixture;
- editor: invited with edit access;
- commenter: invited with comment access;
- viewer: invited with view access;
- other: never invited, used to check cross-tenant denial.

Use no real customer identity or content. Playwright uses the Clerk Backend API
to mint a short-lived, one-time sign-in token for the selected synthetic user;
CI does not need account passwords and the Clerk secret never enters the
browser. Keep MFA requirements consistent with production, but verify that the
sign-in-token flow works before enabling unattended runs. Suspended and
over-quota accounts are useful future fixtures but are not required by the
initial UAT workflow.

### 12.4 Stripe: a persistent UAT sandbox

Stripe's dashboard view switch does not turn a live integration into a test
integration. Live mode and sandboxes/test data have separate API keys,
customers, products, prices, events, and webhook secrets. Keep production in
live mode and create a named, persistent `Evo Notes UAT` sandbox for the UAT
deployment. Local development may use the same sandbox at first, but a separate
developer sandbox is preferable once tests mutate subscriptions concurrently.

In the UAT sandbox:

1. Create the Pro and Team products and recurring prices with the same billing
   intervals and entitlements intended for production. Record the UAT price
   IDs; they are not interchangeable with live price IDs.
2. Create a webhook endpoint at
   `https://api.uat.example.com/webhooks/stripe` with the same event selection
   as production. Record this endpoint's UAT signing secret.
3. Put only `sk_test_…`, the UAT webhook secret, and UAT price IDs in the UAT
   Coolify resource as `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_TEAM`. Set the matching sandbox
   publishable key in `VITE_STRIPE_PUBLISHABLE_KEY` if the frontend needs it.
4. Exercise one successful subscription, update, cancellation, failed payment,
   duplicate webhook delivery, and out-of-order delivery using synthetic
   customers. Confirm plan state, idempotency, and reconciliation before the
   first production release.

Stripe credentials are deployment secrets, not review-runner secrets. The
wizard keeps them locally only to reduce transcription mistakes; paste them
into Coolify yourself. Do not add them to GitHub Actions unless a future test
has a narrow, documented reason to call Stripe directly.

### 12.5 Create the authorization fixture

After Clerk webhooks are healthy and the UAT deployment is stable:

1. Sign in as the synthetic owner and create one private workspace and one
   small, non-sensitive material.
2. Invite the editor, commenter, and viewer with their matching roles. Sign in
   as each account and accept every invitation.
3. Leave the `other` account uninvited. It must receive the same not-found
   response as any unrelated tenant rather than learning that the fixture
   exists.
4. Record the workspace and material IDs in the wizard. Do not put fixture
   content, session cookies, invitation tokens, or passwords in GitHub.
5. Reset or recreate the fixture whenever a scanner changes it. Keep the IDs
   current; stale IDs are failed setup, not passing authorization tests.

The authenticated UAT suite checks read visibility, owner-only statistics, and
collaboration token modes for all five roles. Extend this fixture later for
suspension, over-quota, deletion, billing, import, and asynchronous lifecycle
tests; each extension should use bounded synthetic data and deterministic
cleanup.

### 12.6 GitHub Actions configuration

Create Actions environments named `uat` and `production`, both restricted to
`main`. Do not add required reviewers to `uat`, because successful `main` CI is
supposed to deploy there unattended. Add the available approval protection to
`production`. The agent-driven Strix workflows remain manual dispatch only.

Repository variables used by UAT validation and activation:

```text
UAT_DEPLOYMENT_ENABLED=false
UAT_TARGET_AUTHORIZED=true
UAT_APP_URL=https://uat.example.com
UAT_API_URL=https://api.uat.example.com
UAT_COLLAB_URL=wss://collab.uat.example.com
UAT_OPS_URL=https://ops.uat.example.com
UAT_ALLOWED_HOSTS=uat.example.com,api.uat.example.com,collab.uat.example.com,ops.uat.example.com
CLERK_PUBLISHABLE_KEY=<UAT publishable key>
UAT_OWNER_EMAIL=<synthetic owner>
UAT_EDITOR_EMAIL=<synthetic editor>
UAT_COMMENTER_EMAIL=<synthetic commenter>
UAT_VIEWER_EMAIL=<synthetic viewer>
UAT_OTHER_EMAIL=<synthetic unrelated user>
UAT_FIXTURE_WORKSPACE_ID=<fixture id>
UAT_FIXTURE_MATERIAL_ID=<fixture id>
STRIX_LLM=openai/gpt-5.4
STRIX_UAT_MAX_BUDGET=40
STRIX_SOURCE_MAX_BUDGET=40
```

Variables on the `uat` environment:

```text
COOLIFY_API_URL=https://coolify.example.com/api/v1
COOLIFY_RESOURCE_UUID=<UAT Coolify application UUID>
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_PAGES_PROJECT=<UAT Pages project>
CLOUDFLARE_PAGES_BRANCH=main
DEPLOYMENT_APP_URL=https://uat.example.com
DEPLOYMENT_API_URL=https://api.uat.example.com
DEPLOYMENT_COLLAB_URL=wss://collab.uat.example.com
DEPLOYMENT_OPS_URL=https://ops.uat.example.com
CLERK_PUBLISHABLE_KEY=<UAT publishable key>
# Optional public VITE_* values: Sentry, PostHog, picker/OAuth, feature flags
```

Protected secrets on the `uat` environment:

```text
COOLIFY_API_TOKEN=<token able to update, deploy, and read the UAT application>
CLOUDFLARE_API_TOKEN=<token with Cloudflare Pages Edit for the UAT project>
CLERK_SECRET_KEY=<UAT Clerk secret key>
LLM_API_KEY=<key accepted by STRIX_LLM>
STRIX_UAT_AUTH_INSTRUCTIONS=<optional synthetic-only instructions>
```

Configure the `production` environment with the same deployment variable names,
but production URLs, the production Coolify UUID, the production Pages project,
and the production Clerk publishable key. Add separate
`COOLIFY_API_TOKEN` and `CLOUDFLARE_API_TOKEN` environment secrets. Do not add
Clerk, Stripe, database, B2, or LLM server secrets to GitHub: those stay in the
production Coolify resource. Disable native Git auto-deploy on both production
resources so the protected workflow is the only release path.

Keep `STRIX_UAT_AUTH_INSTRUCTIONS` limited to synthetic accounts and the
minimum navigation needed. If authenticated autonomous exploration is worth
the extra coverage, it may contain a dedicated synthetic password; rotate that
password after the scan and inspect artifacts for accidental disclosure. The
workflow writes the value to a mode-`0600` temporary file and removes that file
after the scan. The short-lived Clerk-token Playwright suite covers the fixed
authorization matrix even when Strix remains unauthenticated.

### 12.7 Baseline, automation, and release gate

1. Leave `UAT_DEPLOYMENT_ENABLED=false` initially. This prevents successful CI
   runs from deploying to a half-configured target. It does not control Strix:
   both Strix workflows are permanently manual dispatch only.
2. Manually dispatch **Deploy UAT** from `main`. It deploys the selected SHA and
   automatically calls **Deterministic UAT quality**. Inspect Coolify, Pages,
   smoke, and Playwright evidence, including release-SHA, accessibility, and
   320 CSS-pixel reflow checks.
3. Repair the fixture and tune only documented budgets or exclusions. Do not
   weaken authorization assertions or allow-host guards to make a run green.
4. After a stable baseline, set `UAT_DEPLOYMENT_ENABLED=true`. Every successful
   `CI` run for `main` then deploys its exact SHA to UAT and calls the same gate.
   Editor performance remains manual; no review workflow has a schedule.
5. When you explicitly want the costly scanner baseline, manually dispatch
   **Manual repository security review** and **Manual UAT review with Strix**
   with enforcement off. Triage candidates rather than suppressing unexplained
   results. Neither workflow has a schedule.
6. When the release warrants the costly review, explicitly invoke
   `$review-repository` in `release` mode and manually dispatch both Strix
   workflows for the exact candidate revision with `enforce_findings=true`.
   Review medium findings and coverage gaps manually. This remains a human
   release decision, not an automatic production prerequisite.
7. Perform the manual Stripe sandbox sequence in §12.4 plus the release checks
   for over-quota/suspension, ingest/index/search, cleanup, reconciliation,
   collaboration revocation, and recovery until dedicated synthetic fixtures
   automate them.
8. Dispatch **Promote revision to production** with the exact full SHA. The
   workflow re-stages UAT, re-runs the deterministic gate, waits for production
   approval, deploys both production resources, and verifies the public release
   SHA and health. Then perform the bounded login, upload, collaboration,
   webhook, and observability checks in §10. Production is not a penetration-
   test target.

Set `UAT_DEPLOYMENT_ENABLED=false` immediately if UAT is being rebuilt, its
fixture is invalid, or allowed-host ownership changes. Manual deployment and
quality dispatch remain available for repair. Strix cannot run until a person
dispatches it. Rotate Clerk and LLM secrets after exposure or personnel
changes. Delete stale artifacts under the repository's retention policy; they
should contain sanitized evidence, but they are still security-sensitive.
