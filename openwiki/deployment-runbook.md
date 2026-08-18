# Deployment Runbook — manual actions

Everything that cannot be done from this repository. Each step says what breaks
if it is skipped, because several of them fail silently.

Order matters: DNS before Cloudflare rules, Cloudflare before origin lockdown,
origin lockdown before trusting `CF-Connecting-IP`.

Code-side configuration lives in `observability-metering.md` §9.

---

## 1. DNS & hostnames

The SPA is static. The Go gateway, the Hocuspocus sidecar, the Python
retrieval service, and the ingest worker are **not** one process. Only two of
them should have public DNS.

| Hostname | Serves | Public DNS | Proxied |
| --- | --- | --- | --- |
| `abcd.com` | SPA (Cloudflare Pages / static) | yes | yes |
| `www.abcd.com` | redirect to apex | yes | yes |
| `api.abcd.com` | Go gateway (`server`, :8080) | yes | yes |
| `collab.abcd.com` | Hocuspocus WebSocket (`collaboration`, :1234) | yes | yes |
| `ops.abcd.com` | operator dashboard, later | yes, later | yes |
| retrieval :8001 | Python chat/generate/transcribe | **no** | — |
| ingest worker | Modal parse + embed | **no** | — |
| Postgres / Redis | — | **no** | — |

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

Do **not** point the tunnel at `:8080` / `:1234`. Coolify already runs Traefik
or Caddy on the host; the tunnel should hit that proxy and let it route by
`Host`. Follow [Coolify: access all resources via tunnels](https://coolify.io/docs/integrations/cloudflare/tunnels/all-resource), with these bindings:

| Hostname | Tunnel service | Coolify domain field |
| --- | --- | --- |
| `api.abcd.com` | `http://localhost:80` (or `http://coolify-proxy:80` if `cloudflared` is a container on the `coolify` network) | `http://api.abcd.com` on the **server** service |
| `collab.abcd.com` | same `:80` | `http://collab.abcd.com` on **collaboration** |
| retrieval, worker, db, redis | none | no domain |

Details that are easy to get wrong:

- Run `cloudflared` as a **Coolify service** (or systemd on the host), not as a
  service in `deploy/docker-compose.yml`. A compose restart must not drop every
  hostname on the server.
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

### 1.2 Bare docker compose + Tunnel

On a host running `deploy/docker-compose.yml` without Coolify's proxy,
`cloudflared` publishes the app ports directly. Cloudflare creates the DNS
records; do **not** also point A records at the VPS IP.

```
api.abcd.com    →  http://localhost:8080     (the `server` container)
collab.abcd.com →  http://localhost:1234     (the `collaboration` container)
```

SSL/TLS **Full (strict)** is appropriate here if the origin speaks TLS.
Leave :8001, Postgres and Redis unpublished. This is the origin lockdown in §3.

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
`deploy/.env.example` (Clerk, Stripe, four Sentry DSNs, provider keys,
`WHISPER_API_KEY` for billed transcribe). `RATE_LIMIT_AI_PER_HOUR` defaults to
200; the 15/minute AI burst and 120/minute editor class are not env-overridable.

Gateway env once those hostnames exist:

```
APP_URL=https://abcd.com
CORS_ALLOWED_ORIGINS=https://abcd.com,https://www.abcd.com
COLLABORATION_URL=wss://collab.abcd.com
COLLABORATION_ALLOWED_ORIGINS=https://abcd.com
```

Clerk: allowed origins + redirect URLs = `https://abcd.com` (and `www` if you
use it); webhook `https://api.abcd.com/webhooks/clerk`. Stripe webhook
`https://api.abcd.com/webhooks/stripe`. B2 CORS `allowedOrigins` is the SPA
origin, not `api.`.

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

**Cache rules:** bypass cache for `api.abcd.com` and `collab.abcd.com` entirely.
A cached SSE or WebSocket response breaks streaming in ways that look like an
application bug.

**Timeouts:** the default 100 s orange-cloud proxy read timeout will cut long
chat streams and Modal parse waits. A Cloudflare Tunnel is not subject to it.
Coolify's Traefik/Caddy in front of the tunnel still has its own read timeout —
raise that on `api.abcd.com` if streams die around a minute.

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
share the queue without extra coordination. Each replica runs one job at a time,
so this is also the number of concurrent Modal parses.

Connection budget after the worker's sync pool (`max_size=4`) plus the async
retrieval pool (`max_size=8`): **12 connections per replica**. Against default
Postgres `max_connections=100`, and alongside the gateway, retrieval service,
and collaboration:

- 3 replicas (36 worker connections) is comfortable.
- Beyond ~5 replicas, raise `max_connections` or put pgbouncer in front.

Provider rate limits scale with replica count. `EVO_CAPTION_CONCURRENCY` is 8
*per job*, so N replicas means up to 8N concurrent vision calls.

Do not scale above 1 until the worker running in production includes
lease-keyed content-claim steal. A waiter on a second replica can otherwise
delete a live creator's `rag_contents` row.

> B2 egress is **not** in `usage_events` — the browser fetches presigned URLs
> directly and the gateway never sees the transfer. B2's own reporting is the
> only source. Set a spend alert.

---

## 5. Sentry

1. Create **four** projects: `gateway` (Go), `retrieval` (Python),
   `collaboration` (Node), `spa` (React). Separate projects keep alert routing
   and quotas per service.
2. Set `SENTRY_DSN` per service and `VITE_SENTRY_DSN` for the SPA. The SPA DSN
   is public and belongs to a browser-only project.
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

## 7. Modal

1. Set `modal_parse_token` and keep the parse endpoints authenticated. An
   unauthenticated GPU endpoint is a free GPU for whoever finds it.
2. Set a **spend limit** on the workspace. A parse loop on a malformed document
   is the most expensive failure mode in the system.
3. Optionally enable Modal's OpenTelemetry export for queue wait and cold start
   — the two numbers the ledger cannot see.

---

## 8. Database

1. Apply migrations (automatic on gateway boot with `MIGRATE=true`).
2. **Grant operator access by hand.** There is no API for this by design:

   ```sql
   INSERT INTO operators (user_id, role, note)
   VALUES ('user_2abc...', 'admin', 'founder');
   ```

   The id is the Clerk user id, which must already exist in `users` — sign in
   through the product once first.
3. Create a **read-only role** for the operator dashboard:

   ```sql
   CREATE ROLE evo_ops LOGIN PASSWORD '...';
   GRANT CONNECT ON DATABASE evo TO evo_ops;
   GRANT USAGE ON SCHEMA public TO evo_ops;
   GRANT SELECT ON usage_daily, usage_events, user_credits, credit_reservations,
                   user_storage, users, workspaces, operators,
                   model_configs, model_registry_state TO evo_ops;
   ```

   The dashboard is the least-hardened thing that will ever touch this
   database; it should not be able to write to it.

---

## 9. Changing models in the registry

Most surfaces are safe to retarget from the ops dashboard: chat, generate,
editor, ingest and vision all resolve a pin per request or per job, so a new
default applies to the next one and everything in flight keeps what it had.

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
  resolves it on every search and every upload. Its `model_configs` row must
  never be deleted, and its provider must stay reachable — including its exact
  `provider_model_id`. Deprecating an embedding *model* is fine only if you can
  serve the same one elsewhere.
- **Deprecating a dimension is not possible.** Widths are a schema commitment:
  `rag_chunk_vectors_<dim>` and the check constraints on
  `workspaces.embedding_dim` and `model_configs`. **Every width any workspace
  points at must always have at least one enabled, reachable embedding model
  behind it.** If a provider drops a model, replace it with another model of
  the same width (self-hosted counts) rather than retiring the width.
- **A new width is a migration, not a config change.** Add the
  `rag_chunk_vectors_<dim>` table and its HNSW index, extend both check
  constraints, and add the width to the allowlists in
  `pipeline/pipeline/retrieval/store.py` and `server/internal/store/queries.go`.
  Without the table, the check constraint rejects the model row — which is the
  intended failure, since discovering a missing width at ingest time would mean
  a workspace whose vectors have nowhere to go.

### Disabling or deleting rows

`enabled = false` is the safe control for chat/generate/editor: users holding
that preference fail with `model_unavailable` rather than being silently
downgraded, which is the intended behaviour. Rows are never deleted, because a
pinned `(key, version)` is resolved forever — by assistant messages, by queued
jobs, and by workspaces.

---

## 10. Post-deploy verification

| Check | Expected |
| --- | --- |
| `curl -sI https://api.abcd.com/healthz` | `x-request-id` header present |
| Send a chat turn, then `SELECT * FROM usage_events ORDER BY id DESC LIMIT 5` | rows with non-zero `output_tokens` |
| Same `trace_id` searched in Sentry and in gateway logs | both return the request |
| `SELECT * FROM credit_reservations WHERE status='open' AND expires_at < now()` | empty after a minute (sweeper is running) |
| `SELECT * FROM usage_daily` | populated within 5 minutes (rollup is running) |
| Fire >200 AI requests in an hour, or 16 in a minute | `429` with `code: "ai_rate_limited"` |
| Open 4 chat streams at once | 4th returns `429 too_many_streams` |
| Hit the origin IP directly | connection refused |
| Coolify: `ss`/`docker ps` shows `:8080`/`:1234` bound on `0.0.0.0` | wrong — only Traefik `:80` (tunnel target) should be public |

If `usage_events` stays empty while chat works, the usual cause is a streamed
completion without `stream_options={"include_usage": True}` — the request
succeeds and reports nothing.
