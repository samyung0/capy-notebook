# Deployment Runbook — manual actions

Everything that cannot be done from this repository. Each step says what breaks
if it is skipped, because several of them fail silently.

Order matters: DNS before Cloudflare rules, Cloudflare before origin lockdown,
origin lockdown before trusting `CF-Connecting-IP`.

Code-side configuration lives in `observability-metering.md` §9.

---

## 1. DNS & hostnames

The SPA is static. The Go gateway, the Hocuspocus sidecar, the Python
retrieval service, the ingest worker, and the operator dashboard are separate
processes. Three services have public hostnames. Cloudflare Access protects the
operator hostname before traffic reaches its origin.

| Hostname | Serves | Public DNS | Proxied |
| --- | --- | --- | --- |
| `abcd.com` | SPA (Cloudflare Pages / static) | yes | yes |
| `llm.abcd.com` | optional; only if `VITE_LLM_RUNTIME_ORIGIN` is set | optional | yes |
| `www.abcd.com` | redirect to apex | yes | yes |
| `api.abcd.com` | Go gateway (`server`, :8080) | yes | yes |
| `collab.abcd.com` | Hocuspocus WebSocket (`collaboration`, :1234) | yes | yes |
| `ops.evonotes.com` | Go ops API + static dashboard (`ops`, :8082) | yes | yes, Access required |
| retrieval :8001 | Python chat/generate | **no** | — |
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

Do **not** point the tunnel at `:8080` / `:1234`. Coolify already runs Traefik
or Caddy on the host; the tunnel should hit that proxy and let it route by
`Host`. Follow [Coolify: access all resources via tunnels](https://coolify.io/docs/integrations/cloudflare/tunnels/all-resource), with these bindings:

| Hostname | Tunnel service | Coolify domain field |
| --- | --- | --- |
| `api.abcd.com` | `http://localhost:80` (or `http://coolify-proxy:80` if `cloudflared` is a container on the `coolify` network) | `http://api.abcd.com` on the **server** service |
| `collab.abcd.com` | same `:80` | `http://collab.abcd.com` on **collaboration** |
| `ops.evonotes.com` | same `:80` | `http://ops.evonotes.com` on **ops** |
| retrieval, worker, db, redis | none | no domain |

Details that are easy to get wrong:

- Run `cloudflared` as a **Coolify service** (or systemd on the host), not as a
  service in `deploy/docker-compose.yml`. A compose restart must not drop every
  hostname on the server.
- Enable the compose `ops` profile in Coolify (`COMPOSE_PROFILES=ops`). Set the
  `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SENTRY_DSN_OPS`, and `RELEASE_SHA` build
  values before the first image build. Runtime-only changes do not rebuild the
  static dashboard.
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

Ops uses one read role, one execute-only session role, and opens the registry
writer only after the application has authorized an `admin`:

```
OPS_DATABASE_URL=postgres://evo_ops:<password>@<private-postgres-host>:5432/evo?sslmode=require
OPS_AUTH_DATABASE_URL=postgres://evo_ops_auth:<password>@<private-postgres-host>:5432/evo?sslmode=require
OPS_REGISTRY_DATABASE_URL=postgres://evo_ops_registry:<password>@<private-postgres-host>:5432/evo?sslmode=require
OPS_CF_ACCESS_ISSUER=https://<team-name>.cloudflareaccess.com
OPS_CF_ACCESS_AUDIENCE=<Access application AUD>
OPS_ACCESS_DISABLED=false
OPS_AUTH_DISABLED=false
OPS_UNSAFE_DEVELOPMENT=false
```

`OPS_REGISTRY_DATABASE_URL` is stored as configuration at startup but its pool
is opened lazily by the admin-only Save handler. Viewer requests are rejected
before that credential is used.

Use `db` as the Postgres host only when the ops container shares the compose
network with `db`. A managed database must use its private hostname. Do not add
a public Postgres DNS record or a Coolify domain. The ops process does not run
migrations and must never receive the database owner URL. Deploy the gateway
migration first, then start ops.

Startup verifies all three database sessions against their privilege contracts.
It rejects superusers, owner sessions with broad writes, inherited roles,
customer-content reads, direct operator-table access on the auth session, and
`model_configs` DELETE on the registry session. Missing required column grants
also stop startup. Local owner URLs are accepted only with
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
audience, and time claims. It then verifies Clerk and checks the `operators`
table. A request must pass all three checks.

The Access identity and Clerk identity are intentionally independent. Access
decides who may reach the origin. Clerk supplies the product user id checked
against `operators`. Their email addresses are not required to match, so either
gate can be revoked without coupling the two identity systems.

Keep the Access application in front of static files and `/api/*`. Do not
add a bypass policy for `/healthz` at Cloudflare. Docker calls the health route
on the private container network. The public hostname still requires Access.

Test both failure paths before granting an operator row:

1. An email outside the Access policy must stop at Cloudflare.
2. An allowed Access identity without a Clerk session must receive `401`.
3. A valid Clerk user missing from `operators` must receive `403`.
4. A `viewer` must receive `403` from registry Save without opening the writer
   database pool.

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
*per job*, so N replicas means up to 8N concurrent vision calls.

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

## 7. Modal

1. Set `modal_parse_token` and keep the parse endpoints authenticated. An
   unauthenticated parse endpoint is a free bill for whoever finds it.
2. Deploy the parse app: `pnpm run deploy:modal`. Point
   `MODAL_FAST_PARSE_URL` at
   `https://<workspace>--evo-mineru-fast.modal.run`. The old
   `evo-mineru-accurate` app can be stopped.
3. Set a **spend limit** on the workspace. A parse loop on a malformed document
   is the most expensive failure mode in the system.
4. Optionally enable Modal's OpenTelemetry export for queue wait and cold start
   — the two numbers the ledger cannot see.

---

## 8. Database

1. Apply migrations through the gateway (`MIGRATE=true`) before deploying ops.
   The ops service does not run migrations.
2. **Grant operator access by hand.** Have the operator sign in to the product
   once so `users.id` exists. Copy their Clerk user id, then use a database
   owner session:

   ```sql
   INSERT INTO operators (user_id, role, note)
   VALUES ('user_2abc...', 'admin', 'initial operator');
   ```

   Use `viewer` unless the person must save registry changes. Revoke access with
   `DELETE FROM operators WHERE user_id='user_2abc...'`. There is no operator
   membership API by design.
3. Create three roles with independent random passwords. The grants name every
   readable column. In particular, none of these roles can read `messages`, file
   `content` or blob paths, job `payload`, email recipients or `payload`, or
   `usage_events.metadata`:

   ```sql
   CREATE ROLE evo_ops LOGIN NOINHERIT PASSWORD '<read-password>';
   CREATE ROLE evo_ops_auth LOGIN NOINHERIT PASSWORD '<auth-password>';
   CREATE ROLE evo_ops_registry LOGIN NOINHERIT PASSWORD '<registry-password>';

   GRANT CONNECT ON DATABASE evo
     TO evo_ops, evo_ops_auth, evo_ops_registry;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   GRANT USAGE ON SCHEMA public
     TO evo_ops, evo_ops_auth, evo_ops_registry;

   GRANT SELECT (
     day, actor_user_id, kind, surface, provider, model,
     events, input_tokens, output_tokens, units, credit_micros
   ) ON usage_daily TO evo_ops;
   GRANT SELECT (
     user_id, period_start, used_micros, reserved_micros
   ) ON user_credits TO evo_ops;
   GRANT SELECT (
     status, expires_at, settled_at
   ) ON credit_reservations TO evo_ops;
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
     id, user_id, name, embedding_model_key, embedding_model_version,
     embedding_dim, last_accessed_at
   ) ON workspaces TO evo_ops;
   GRANT SELECT (user_id, role) ON operators TO evo_ops;
   GRANT SELECT (
     model_key, version, display_name, provider_slug, base_url,
     provider_model_id, auth_mode, context_window_tokens, params, surfaces,
     micros_per_input_token, micros_per_cached_input_token,
     micros_per_output_token, enabled, is_default_for, created_at
   ) ON model_configs TO evo_ops;
   GRANT SELECT (id, version, updated_at) ON model_registry_state TO evo_ops;
   GRANT SELECT (id, last_run_at) ON usage_rollup_state TO evo_ops;
   GRANT SELECT ON ops_completed_assistant_messages TO evo_ops;
   GRANT SELECT (id, workspace_id)
     ON files TO evo_ops;
   GRANT SELECT (
     status, locked_at, lease_expires_at, updated_at
   ) ON jobs TO evo_ops;
   GRANT SELECT (
     status, updated_at
   ) ON email_outbox TO evo_ops;
   GRANT SELECT (
     trace_id, actor_user_id, kind, surface, provider, model,
     model_key, model_version, input_tokens, output_tokens, units, unit,
     credit_micros, created_at
   ) ON usage_events TO evo_ops;

   GRANT EXECUTE ON FUNCTION touch_operator_seen(text) TO evo_ops_auth;

   GRANT SELECT (
     model_key, version, display_name, provider_slug, base_url,
     provider_model_id, auth_mode, context_window_tokens, params, surfaces,
     micros_per_input_token, micros_per_cached_input_token,
     micros_per_output_token, enabled, is_default_for, created_at
   ) ON model_configs TO evo_ops_registry;
   GRANT SELECT (id, version, updated_at)
     ON model_registry_state TO evo_ops_registry;
   GRANT SELECT (
     id, embedding_model_key, embedding_model_version, embedding_dim
   ) ON workspaces TO evo_ops_registry;
   GRANT SELECT (
     id, email, locale, chat_model_key, generate_model_key,
     editor_model_key, quiz_model_key
   ) ON users TO evo_ops_registry;
   GRANT SELECT (
     user_id, email_workspace_invite, email_membership, email_billing
   ) ON notification_prefs TO evo_ops_registry;
   GRANT SELECT (
     id, user_id, kind, data, href, workspace_id, workspace_invite_id,
     at, read_at
   ) ON notifications TO evo_ops_registry;
   GRANT SELECT (idempotency_key) ON email_outbox TO evo_ops_registry;

   GRANT INSERT (
     model_key, version, display_name, provider_slug, base_url,
     provider_model_id, auth_mode, context_window_tokens, params, surfaces,
     micros_per_input_token, micros_per_cached_input_token,
     micros_per_output_token, enabled, is_default_for
   ) ON model_configs TO evo_ops_registry;
   GRANT UPDATE (
     provider_slug, base_url, enabled, is_default_for
   ) ON model_configs TO evo_ops_registry;
   GRANT UPDATE (version, updated_at)
     ON model_registry_state TO evo_ops_registry;
   GRANT UPDATE (
     chat_model_key, generate_model_key, editor_model_key, quiz_model_key,
     updated_at
   ) ON users TO evo_ops_registry;
   GRANT INSERT (
     id, user_id, kind, data, href, workspace_id, workspace_invite_id, at
   ) ON notifications TO evo_ops_registry;
   GRANT INSERT (
     id, user_id, to_email, template, locale, payload, idempotency_key
   ) ON email_outbox TO evo_ops_registry;
   ```

   `ops_completed_assistant_messages` exposes only an id, trace id, and
   timestamp. Do not replace that view grant with `SELECT` on `messages`.
   `touch_operator_seen` is `SECURITY DEFINER`; it is the auth role's only
   privilege beyond connecting and schema usage. Do not grant `UPDATE` on
   `operators`, `DELETE` on `model_configs`, schema creation, sequence access,
   or generic
   `ALL TABLES IN SCHEMA` privileges.

   PostgreSQL grants function execution to `PUBLIC` by default. The two
   `REVOKE EXECUTE` statements above close that path for existing and future
   functions. Database owners keep their implicit privileges. If another
   production service uses a non-owner database role, grant that role the exact
   functions it calls before applying the global revoke.

4. Put the three URLs in the matching `OPS_*_DATABASE_URL` variables. Restart
   ops, verify `current_user` through all three pools, and check that no role
   belongs to a broader role. A viewer registry Save must fail before the
   application uses `OPS_REGISTRY_DATABASE_URL`.

---

## 9. Changing models in the registry

Most surfaces are safe to retarget from the ops dashboard: chat, generate,
editor, ingest and vision all resolve a pin per request or per job, so a new
default applies to the next one and everything in flight keeps what it had.

The first dashboard version deliberately disallows aliases: a grid row key must
equal every catalog pin's `model_key`. Each surface cell may still select a
different immutable version of that key. This keeps stable user preferences
without adding a second hidden key namespace.

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
  in-place changes to the pin, `provider_model_id`, or `params`
  (`protect_embedding_model_configs`). Same width from another model is a
  different space and a different table. Add a `rag_chunk_vectors_*` table,
  an allowlist entry in both languages, a `model_configs` row with
  `params.vector_table`, then in one transaction clear the old
  `is_default_for` and mark the new row (Postgres refuses two defaults for
  the same surface). Bump `model_registry_state.version`. Old workspaces
  stay on the old pin. If a vendor drops the model, change `base_url` /
  `provider_slug` only and serve the **same weights** from elsewhere.
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

| Check | Expected |
| --- | --- |
| `curl -sI https://api.abcd.com/healthz` | `x-request-id` header present |
| Send a chat turn, then `SELECT * FROM usage_events ORDER BY id DESC LIMIT 5` | rows with non-zero `output_tokens` |
| Same `trace_id` searched in Sentry and in gateway logs | both return the request |
| `SELECT * FROM credit_reservations WHERE status='open' AND expires_at < now()` | empty after a minute (sweeper is running) |
| `SELECT * FROM usage_daily` | populated within 5 minutes (rollup is running) |
| `curl -sI https://ops.evonotes.com` without Access credentials | Cloudflare Access login or denial, never the app |
| Sign in through Access + Clerk as a user absent from `operators` | `403` from the ops service |
| Sign in as an operator with `role='viewer'`, then submit registry Save | `403`; registry writer pool remains unopened |
| `curl -sI http://127.0.0.1:8082/healthz` on the host | `200`; :8082 is not reachable from another host |
| Fire >200 AI requests in an hour, or 16 in a minute | `429` with `code: "ai_rate_limited"` |
| Open 6 platform-paid AI calls at once | 6th returns `429 too_many_streams` |
| Hit the origin IP directly | connection refused |
| Coolify: `ss`/`docker ps` shows `:8080`/`:1234`/`:8082` bound on `0.0.0.0` | wrong: only Traefik `:80` should be public |

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
