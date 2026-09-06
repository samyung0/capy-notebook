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
   Coolify and Cloudflare Worker resources and calls the reusable
   **Deterministic UAT quality** workflow. Set repository variable
   `UAT_DEPLOYMENT_ENABLED=true` only after the first manual baseline.
2. **Push to production:** manually dispatch **Promote revision to production**
   from `main` with a full 40-character SHA. The workflow re-deploys that SHA
   to UAT, re-runs the deterministic UAT gate and the editor perf budgets, and
   requires the `source/codex-security` and `uat/strix` commit statuses to be
   `success` on that SHA. Only then does it reach the protected `production`
   GitHub environment. Approving that environment is the release action.
3. **Agent-driven review:** `$review-repository`, the Codex Security source
   scan, and the Strix UAT scan run only on a developer machine when a person
   starts them. They post the commit statuses above; GitHub Actions never runs
   them. See `review-automation.md`.

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

One Cloudflare Worker serves the static SPA and live `/w/{workspaceId}` summaries. The Go gateway, the Hocuspocus sidecar, the Python
retrieval service, the ingest worker, and the operator dashboard are separate
processes. Three services have public hostnames. Cloudflare Access protects the
operator hostname before traffic reaches its origin.

| Hostname           | Serves                                             | Public DNS | Proxied              |
| ------------------ | -------------------------------------------------- | ---------- | -------------------- |
| `abcd.com`         | SPA and workspace SSR (Cloudflare Worker)                    | yes        | yes                  |
| `llm.abcd.com`     | optional; only if `VITE_LLM_RUNTIME_ORIGIN` is set | optional   | yes                  |
| `office.abcd.com`  | isolated Office file runtime                       | yes        | yes                  |
| `www.abcd.com`     | redirect to apex                                   | yes        | yes                  |
| `api.abcd.com`     | Go gateway (`server`, :8080)                       | yes        | yes                  |
| `collab.abcd.com`  | Hocuspocus WebSocket (`collaboration`, :1234)      | yes        | yes                  |
| `ops.capynotebook.com` | Go ops API + static dashboard (`ops`, :8082)       | yes        | yes, Access required |
| retrieval :8001    | Python chat/generate                               | **no**     | —                    |
| ingest host        | parser + ingest worker + embed                     | **no**     | —                    |
| Postgres / Redis   | —                                                  | **no**     | —                    |

The browser talks to the gateway at same-origin `/api` (`src/api/client.ts`
hard-codes `API_BASE = '/api'`; `VITE_API_URL` is only the Vite **dev** proxy).
So the apex must reverse-proxy `/api/*` to the Go process, **and**
`api.abcd.com` must still exist as its own hostname for Clerk/Stripe webhooks
(`POST /webhooks/clerk`, `POST /webhooks/stripe`). Retrieval is reached only
from the gateway over the docker network (`PIPELINE_URL=http://retrieval:8001`).

If the domain is **already** on Cloudflare, skip nameserver migration.

1. **Site.** Deploy `wrangler.jsonc` with `--env uat` or `--env production`.
   The Worker serves `dist/`, renders `/w/{workspaceId}` from the live Go summary
   endpoint, and proxies `/api/*` to the configured `API_ORIGIN`. `APP_ORIGIN`
   is the canonical browser origin. CI supplies both from the GitHub deployment
   URLs. Attach the corresponding custom domain to that Worker.
   When replacing the old UAT Pages project, deploy and verify the Worker first,
   then detach the Pages custom domain and attach it to the Worker. Verify the
   public release before deleting the retired Pages project.
   On this first cutover, the workflow's public revision check cannot pass while
   the domain still serves Pages. Once the Worker publish step succeeds, move
   the domain and rerun the failed site job; the successfully activated backend
   and ingest release stays in place.
   Coolify serves the backend, not the site. Summary responses and errors are
   `no-store`; link summaries are `noindex, nofollow`. There is no KV/R2 cache.
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
   The Office viewer/editor is different: production requires a separate
   cookie-less hostname such as `office.abcd.com`. Serve only the built
   `office-runtime.html` and its `/assets/*` there (404 other routes), set
   `VITE_OFFICE_RUNTIME_ORIGIN=https://office.abcd.com` when building the SPA,
   and set `OFFICE_ALLOWED_PARENT_ORIGINS` to the exact comma-separated HTTPS
   parent origins in GitHub. `workers/office` stages the runtime HTML and assets
   from the same build as the SPA, replaces inherited headers, and publishes
   before the SPA. UAT uses `uat-office.capynotebook.com` and allows
   `https://uat.capynotebook.com,https://dev-sam.uat.capynotebook.com`; add each
   future developer origin explicitly. Production requires its own Office custom
   domain configured in `wrangler.office.jsonc` before first rollout. The Worker
   supplies the matching `frame-ancestors` policy and allows embedded blob fonts. Do not proxy `/api`, issue authentication cookies, or set
   parent-domain cookies on this hostname. The Office host transfers protected
   bytes by exact-origin `postMessage`; it does not need CORS access to the API.
2. **API + collab.** Pick one of §1.1 Coolify (typical), §1.2 bare compose, or
   §1.3 public A records. Retrieval, worker, Postgres, and Redis stay off
   public DNS in every option.
3. **Same-origin API.** The site Worker forwards `/api/*` only to its explicit
   `API_ORIGIN` and streams request/response bodies. It passes Go's file redirects
   back to the browser without following them with credentials. `/webhooks/*`
   stays on the API hostname. Do not attach the cookie-less Office hostname to
   this Worker; it must expose only Office assets as described above.

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
   and mark passwords/keys as secrets. Ops has its own application, described
   below, and needs the §8 roles first. Do **not** set
   `AUTH_DISABLED=true` or `MIGRATE=true`. In Advanced settings, enable
   **Include Source Commit in Build** so Coolify supplies `SOURCE_COMMIT` to
   the Compose build and runtime; the release verifier depends on it.
5. **Deploy.** Coolify runs `docker compose up --build`. `migrate` applies
   pending `NNNN_*.sql` files and exits 0; `server` / `worker` / `retrieval`
   wait on `service_completed_successfully`. An exited `migrate` container
   is expected. Open its logs and look for `pending 0001_init.sql` (first
   deploy) or only `migrations applied` (later deploys).
6. **Domains** on the resource, after the first successful deploy (Coolify
   has to parse the compose file first). Enter **`http://`** — Cloudflare
   terminates TLS. Include the container port if the UI asks for one:

   | Service                                         | Domain field                   |
   | ----------------------------------------------- | ------------------------------ |
   | `server`                                        | `http://api.abcd.com:8080`     |
   | `collaboration`                                 | `http://collab.abcd.com:1234`  |
   | `ops` (separate application, after step 8)       | `http://ops.capynotebook.com:8082` |
   | `db`, `redis`, `migrate`, `worker`, `retrieval` | no domain                      |

   Redeploy or wait for the proxy to pick up the domains.

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
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod logs migrate
```

Ops uses `deploy/docker-compose.ops.yml` with a distinct Compose project name
and database URLs pointing to the existing application database.
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
  ~60–100s, raise the proxy read timeout on `api.abcd.com`. Cloudflare Tunnel
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
api.abcd.com     → http://localhost:8080  (the `server` container)
collab.abcd.com  → http://localhost:1234  (the `collaboration` container)
ops.capynotebook.com → http://localhost:8082  (the `ops` container)
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
120/minute editor class are not env-overridable. `CAPY_MODEL_CONCURRENCY` is
required on both the app host (retrieval) and the ingest host (workers): the
retrieval service and the ingest worker refuse to start under
`APP_ENV=production` without it. Production runs
`deepinfra:zai-org/GLM-5.3-Flash=200/120,deepinfra:Qwen/Qwen3-Embedding-4B=200/80`;
UAT sets its own values against its own DeepInfra account.

`ELEVENLABS_API_KEY` is needed only by the Netcup ingest worker. Audio sends the
model and presigned source URL as multipart fields and waits for the synchronous
Scribe response, so there is no ElevenLabs webhook ID, secret, or gateway
callback. Do not add the key to any `VITE_*` variable.

Disable provider training in the ElevenLabs Data Use settings. Starter does not
offer zero-retention mode: the app privacy policy must disclose ElevenLabs as an
audio transcription processor and its retention before audio upload is enabled.
Capy Notebook does not persist a provider transcript ID or webhook payload, but must
not claim that provider logs or backups are
immediately erased. Do not process PHI without an enterprise agreement.

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
and retries from small sets of IPs. Rate limiting them can lose subscription or
identity events.

**WAF custom rules:**

```
Skip all security rules for:
  starts_with(http.request.uri.path, "/webhooks/")
```

**Do not enable Bot Fight Mode.** It cannot be skipped per-path, so it
challenges webhook deliveries, which cannot solve a JavaScript challenge.

**Cache rules:** bypass cache for `api.abcd.com`, `collab.abcd.com`, and
`ops.capynotebook.com` entirely. A cached SSE or WebSocket response breaks
streaming. Cached operator responses can disclose one operator's data to
another.

For `ops.capynotebook.com`, add a response-header rule with
`Cache-Control: private, no-store` and
`X-Robots-Tag: noindex, nofollow, noarchive`. Keep the dashboard's HTML
`robots` meta tag too. These headers prevent accidental cache and search
indexing; they are not access controls.

### 2.1 Cloudflare Access for ops

Create a self-hosted Access application for `https://ops.capynotebook.com/*`.
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
chat streams. Parser traffic stays on WireGuard and does not cross Cloudflare.
Coolify's Traefik/Caddy in front of the tunnel still has its own read timeout —
raise that on `api.abcd.com` if streams die around a minute.

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

Retry scheduling lives on the `jobs` row (four attempts, 30 s doubling
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
   presigned PUT (`VITE_DIRECT_B2_UPLOAD`, on by default in every deployed
   build), so B2 itself must allow the SPA origin. Apply the file for the
   bucket's environment rather than hand-writing rules:

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

Do **not** put a B2 lifecycle rule on `captions/`, `derived-text/`, `previews/`,
or `parse-bundles/`. Those prefixes are owned by `artifact_cache` and the blob
reaper. A bucket lifecycle rule would delete objects the database still
believes are live. They expire by TTL-since-last-use, which defaults to 90 days.

The required parse ZIP handoff remains in the parser/worker shared local volume.
`CAPY_PARSE_ZIP_TTL_HOURS` controls those local fingerprint bundles, and
`CAPY_PARSE_SOURCE_TTL_HOURS` controls abandoned job-scoped source files. The
worker sweeps both on a 5-minute timer while the queue is idle. After verifying
a local parse ZIP, the coordinator makes up to three attempts to copy it to the
separate `parse-bundles/` B2 prefix for later identical-source reuse. A failed
copy does not fail the current job and creates no cache row. A job retains its
verified source across capacity waits and retries, then deletes it after
committed success or terminal failure.

### Ingest worker replicas

The dedicated-host Compose file defaults to four `worker` containers. Each
claims only `ingest` rows and runs exactly one direct-route or post-parse job.
Each has a 1 CPU, 1 GiB RAM, 1.25 GiB memory-plus-swap, and 128-process hard
ceiling. `CAPY_CAPTION_CONCURRENCY=4` caps embedded-figure fan-out inside each
job, so four workers can make at most sixteen uncached figure-caption calls at
once. Embedding and summary calls remain sequential inside each job;
their host-wide concurrency is at most four. These are limits, not reserved
capacity; idle containers use little CPU or memory. The legacy app-host
debugging profile still defaults to one worker.

One `parse-coordinator` container supervises four child processes, each
claiming one `parse` row. Its container limit is 1 CPU, 512 MiB RAM, 768 MiB
memory-plus-swap, and 128 processes. A child spends most of its lifetime
waiting on MinerU. It has two-connection sync and async pool ceilings; each
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

---

## 6. PostHog

No project exists for local or UAT, and none is needed: an unset
`VITE_POSTHOG_KEY` leaves capture, identify, pageviews, and flags inert. Do this
at production launch.

1. Create a project on the **EU** host. A region move afterwards is a support
   ticket on a paid tier.
2. Set `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`.
3. Under project settings, **enable "Authorized URLs"** for `https://abcd.com`
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
   point-to-point WireGuard service network, then put its displayed public key
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
   worker and `ELEVENLABS_API_KEY` for
   uploaded-audio transcription. The worker also needs `DEEPINFRA_API_KEY` for the seeded Qwen
   embedding route and the exact ZAI GLM routing exception used by
   standalone-image captions. Those calls happen on this ingest host after it
   downloads the B2 object, never in Go. The parser binds only to
   `PARSER_BIND_ADDRESS`; its bearer token remains defense in depth. The
   measured default is MinerU pipeline with OCR `auto`. Synchronous audio calls
   use `CAPY_ELEVENLABS_SYNC_TIMEOUT_S` (12 hours by default) so the documented
   10-hour source limit is not cut off by the ordinary 20-minute ingest timeout.
   The worker also requires `CAPY_MODEL_CONCURRENCY` (§1.4) and exits at
   startup without it.
   Initial limits are four coordinator processes, four admitted document jobs,
   and four active 26-page slices. The default time hierarchy is a 600-second
   per-slice execution deadline, 40-minute parser request, 45-minute Redis slot,
   and 60-minute parse job. Its ingest continuation has a separate 20-minute
   bound. Queue wait does not spend a slice's 600-second budget. The process
   rejects contradictory overrides. The coordinator writes the raw source to
   `parse_spool` while hashing it, the parser atomically publishes the
   fingerprint zip there, and an ingest worker extracts it locally. Explicit
   `txt` and `ocr` modes remain benchmark/retry options.
5. Provision a persistent 24 GiB swapfile as emergency headroom for four-slice
   parsing. The steady-state target is still zero swap use:

   ```bash
   fallocate -l 24G /swapfile
   chmod 600 /swapfile
   mkswap /swapfile
   swapon /swapfile
   grep -q '^/swapfile none swap sw 0 0$' /etc/fstab || \
     printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

   Verify with `swapon --show --bytes` and `free -h`. Do not interpret available
   swap as permission to raise the four-slice cap.

6. On the first coordinated app deployment, select `bootstrap_ingest`. The
   workflow builds and warms the parser, deploys/migrates the backend, then
   activates its matching coordinator, ingest worker, import worker and sampler.
   Verify parser `/healthz` through WireGuard. It must return HTTP 200 with `ok=true`,
   `state=ready`, and a `release_sha` equal to the app's deployed revision. No
   parser port may listen on the public address.
7. Run `bench/parsers/accuracy_report.py` across representative PDF, DOC/DOCX,
   PPT/PPTX, and XLS/XLSX inputs in `auto`, `txt`, and `ocr` modes. Review every
   rejected row and the rendered page comparisons. A 610-page PDF should yield
   24 slices at the 26-page default. Record wall time, peak RAM, swap, and
   ordering/geometry accuracy at one and four concurrent slices.
8. App deployment builds the site before pausing ingest, prepares the candidate
   parser, applies GitHub config to Coolify, deploys the backend, then activates
   matching queue consumers. It publishes the Worker last. A Worker failure
   cannot resume old ingest against the new backend. Recovery before backend
   deployment can restore the previous ingest snapshot. If backend deployment
   has started, recovery must know that Coolify's exact deployment is terminal
   and identify the live backend SHA. Unknown or still-running provider state
   leaves consumers paused with pending evidence for investigation.

Each stack has its own checkout and durable release state:

| Target | Checkout | State |
| --- | --- | --- |
| Production | `/opt/capy-ingest/app` | `/opt/capy-ingest/releases/production` |
| UAT | `/opt/capy-ingest/app-nonprod` | `/opt/capy-ingest/releases/nonprod` |

`active` contains the committed SHA. `current` points to an immutable
`config-<run-id-attempt>` directory. `pending` records its owner, candidate,
previous SHA and snapshot links; `operation.lock` serializes mutations. The
workflow never invents a previous SHA or prunes another stack's images/volumes.
Bootstrap only clones into an absent/empty checkout and records active after
verification. A failed bootstrap stops candidate services and retains evidence.

Docker `restart: unless-stopped` restarts the deployed containers with their
existing images and environment after a reboot. There is no second systemd
Compose launcher. The per-stack watchdog checks the same active/pending state
and lock before restarting an unhealthy existing parser.

For a failed or canceled deployment, inspect the exact Coolify deployment and
live backend revision before invoking recovery with the original run owner.
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
only one parse job, one MinerU slice, and one ingest job can run at a time. A
consumer that cannot take its role lock leaves the database row pending. The
lock descriptor closes automatically if its process or container dies.

Compose hard-codes parser concurrency, per-consumer coordinator concurrency,
and Redis admission to one. It also hard-codes the shared capacity-lock path,
so environment files cannot raise the global parse or ingest limit. The parser
gets 2 CPUs, 6 GiB RAM, and 8 GiB total memory plus swap. Each coordinator gets
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

The current MinerU capacity and failure-injection record is
[`bench/parsers/netcup-2026-08-31-stress.md`](../bench/parsers/netcup-2026-08-31-stress.md).
Keep both the Redis document admission cap and the parser slice concurrency at
four. Eight concurrent slices completed, but filled the parser's 14 GiB memory
cgroup, used 5.32 GiB of swap, left about 450 MiB available on the host, and
processed fewer pages per second than four slices.

Each of the four production ingest workers has a 1 CPU, 1 GiB RAM, 1.25 GiB
total memory-plus-swap, and 128-process ceiling. Four-job 26-page digital,
mixed, mostly-OCR, and all-OCR bursts measured at most 83 MB worker RSS on the
old combined path. A separate 120 MiB content-list edge test needed about 518
MiB and failed under a 512 MiB no-swap cgroup. The 1 GiB ceiling leaves room for
that allowed shape while bounding the four-worker pool to 4 GiB of resident
memory. A 48 MiB no-swap fault injection killed worker
PID 1 with exit 137 and Docker restarted it. The lease reaper retries that
post-parse job once from its artifact; an OOM never quarantines the file.

The production parse coordinator is a separate 512 MiB/768 MiB-total container
with four child processes and no LLM credentials. A coordinator timeout durably
requeues its claim and exits that child; the supervisor replaces only that
child. If the kernel kills a coordinator child, its lease expires and follows
the same one-retry rule. This differs from a MinerU child OOM: the parser's
cgroup OOM watcher terminates and replaces the parser container.

The four parser lanes are asyncio tasks backed by threads, not independently
killable operating-system processes. Restart the whole parser container after
a slice timeout, a broken MinerU process-pool error, or a dead slice worker.
Killing one MinerU multiprocessing child is
not a safe lane-recovery mechanism. The parser now treats a broken MinerU pool
as fatal, changes `/healthz` to HTTP 503, fails the request, and exits so Docker
starts a clean process.

`restart: unless-stopped` recovered PID 1 kills, cgroup OOM kills, a Docker
daemon restart, and a full VM reboot in testing. The parser health route was
available on the first successful probe about 32 seconds after reboot was
issued, with cold models. Ansible installs `capy-ingest-watchdog@.service` for explicitly selected stacks.
It restarts an existing parser after three unhealthy Docker health observations. Per-slice execution deadlines own stuck-work
detection; the watchdog does not independently time active work. It skips
absent containers and planned release cutovers. A restart
drops in-flight connections, but ordinary parser errors get one retry and the
client recovers an atomically published spool artifact when publication
completed before the disconnect.

Each parser slice has a 600-second execution limit that begins after it leaves
the fair queue. A timed-out slice quarantines the whole document and restarts
the parser so its sibling slices stop too. Hard-timeout and OOM fingerprints
are terminal without a retry. An OOM marker covers only documents that had an
executing slice when the cgroup counter changed. Queued documents and all other
retryable failures get one retry.

Once parsing publishes an artifact and hands off an `ingest` row, all timeout,
OOM, provider, database, and worker-death failures use the ingest job's one
retry. Exhaustion fails that job but creates no problematic-file marker, so a
later operator/user re-ingest remains valid. A missing or corrupt handoff bundle
is removed and sent through parsing once; a second invalid bundle is terminal
to prevent a repair loop.

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
   CREATE ROLE capy_ops LOGIN NOINHERIT PASSWORD '<read-password>';
   CREATE ROLE capy_ops_admin LOGIN NOINHERIT PASSWORD '<admin-password>';

   GRANT CONNECT ON DATABASE capy
     TO capy_ops, capy_ops_admin;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   GRANT USAGE ON SCHEMA public
     TO capy_ops, capy_ops_admin;

   GRANT SELECT (
     user_id, period_start, used_micros, reserved_micros
   ) ON user_credits TO capy_ops;
   GRANT SELECT (
     plan_tier, storage_limit_bytes, credit_limit_micros,
     source_file_max_bytes, material_revision_limit,
     owned_workspace_limit, files_per_workspace, files_per_upload
   ) ON plan_limits TO capy_ops;
   GRANT SELECT (
     id, actor_user_id, trace_id, surface, paid_by, status,
     created_at, expires_at, settled_at
   ) ON provider_sessions TO capy_ops;
   GRANT SELECT (
     id, reservation_id, actor_user_id, job_attempt_id, job_stage,
     kind, purpose, status, thinking, input_tokens, output_tokens,
     cached_read_tokens, cache_write_tokens, reasoning_tokens, cache_anomaly,
     context_system_tokens, context_tool_tokens,
     context_conversation_tokens, context_total_tokens,
     context_window_tokens, context_counting_method,
     context_counting_version, opened_at, applied_at, abandoned_at,
     error_category, error_code, provider_status, provider, model, credit_micros
   ) ON provider_calls TO capy_ops;
   GRANT SELECT (
     id, job_type, trigger, status, requested_by_id, requested_by_name,
     requested_at, started_at, finished_at, scanned_count, repaired_count,
     error_count, error
   ) ON reconcile_runs TO capy_ops;
   GRANT SELECT (
     id, run_id, event_type, subject_type, subject_id, actor_user_id,
     metadata, created_at
   ) ON reconciliation_report TO capy_ops;
   GRANT SELECT (
     id, occurred_at, actor_user_id, actor_role, action,
     target_type, target_id, outcome, trace_id, metadata
   ) ON operator_audit_events TO capy_ops;
   -- Retrieval telemetry: features and ids only, no text columns exist.
   GRANT SELECT ON rag_search_events TO capy_ops;
   GRANT SELECT (
     user_id, used_bytes, reserved_bytes
   ) ON user_storage TO capy_ops;
   GRANT SELECT (
     user_id, delta_bytes
   ) ON user_storage_deltas TO capy_ops;
   GRANT SELECT (
     id, name, email, plan_tier, subscription_status,
     deletion_requested_at, purge_after,
     deleted_at, suspended_at, suspended_reason,
     session_revoke_pending, session_revoke_attempts,
     session_revoke_not_before, session_revoke_last_error, created_at
   ) ON users TO capy_ops;
   -- AccountAccess computes the active user's lifecycle state on this pool.
   GRANT SELECT (
     user_id, status, plan_tier, current_period_end, ended_at,
     canceled_at, stripe_event_created, updated_at
   )
     ON user_subscriptions TO capy_ops;
   GRANT SELECT (
     id, user_id, name, embedding_provider_slug, embedding_model_slug,
     embedding_model_version,
     embedding_dim, last_accessed_at
   ) ON workspaces TO capy_ops;
   GRANT SELECT (user_id, role) ON operators TO capy_ops;
   GRANT SELECT (role, permission) ON ops_permissions TO capy_ops;
   GRANT SELECT (
     version, provider_name, model_name, provider_slug, model_slug,
     platform_enabled, byok_enabled, thinking_levels, default_thinking,
     context_window_tokens, params, slots, capabilities, micros_per_input_token,
     micros_per_cached_input_token, micros_per_output_token, enabled,
     is_default_for, created_at, updated_at, created_by, updated_by
   ) ON model_configs TO capy_ops;
   GRANT SELECT (
     resource_key, version, unit, credit_micros_per_unit, active, created_at
   ) ON resource_credit_rates TO capy_ops;
   GRANT SELECT (id, version, updated_at) ON model_registry_state TO capy_ops;
   GRANT SELECT ON ops_assistant_turns TO capy_ops;
   GRANT SELECT (id, workspace_id)
     ON files TO capy_ops;
   GRANT SELECT (
     type, status, not_before, locked_at, lease_expires_at, queued_at, updated_at
   ) ON jobs TO capy_ops;
   GRANT SELECT (
     status, updated_at
   ) ON email_outbox TO capy_ops;
   GRANT SELECT (
     id, trace_id, actor_user_id, kind, surface, provider, model,
     thinking, catalog_provider_slug, catalog_model_slug, model_version,
     input_tokens, output_tokens, units, unit,
     parse_pages, parse_ocr_pages, parse_cpu_milliseconds,
     parse_elapsed_milliseconds, parse_queue_milliseconds,
     parse_download_milliseconds, parse_upload_milliseconds,
     parse_worker_rss_bytes, parse_worker_pss_bytes,
     parse_io_read_bytes, parse_io_write_bytes,
     credit_micros, reservation_id, provider_call_id, created_at
   ) ON usage_events TO capy_ops;
   GRANT SELECT (
     sampled_at, environment, host_id, release_sha, host_metrics_available,
     active_jobs, queued_jobs,
     active_slices, queued_slices, oldest_active_slice_ms,
     oldest_queued_slice_ms, last_slice_completed_age_ms,
     parser_oom_kill_events, cpu_percent, load_1,
     memory_total_bytes, memory_used_bytes, swap_used_bytes,
     parser_memory_bytes, parser_pss_bytes, parser_memory_peak_bytes,
     network_rx_bytes, network_tx_bytes, parse_ready_jobs,
     parse_delayed_jobs, parse_running_jobs, ingest_ready_jobs,
     ingest_delayed_jobs, ingest_running_jobs, expired_leases,
     oldest_queued_job_ms, disk_free_bytes, spool_bytes, spool_files
   ) ON ingest_host_samples TO capy_ops;
   GRANT SELECT (
     sampled_at, environment, host_id, worker_instance_id, role, release_sha,
     state, stage, job_attempt_id, cpu_cores, memory_bytes, memory_limit_bytes,
     pids_current, pids_limit, oom_events, oom_kill_events
   ) ON ingest_worker_samples TO capy_ops;
   GRANT SELECT (
     id, job_id, operation_id, attempt, job_type, environment, status, stage,
     error_category, error_code, retryable, route, source_format, claimed_at,
     finished_at, next_retry_at, queue_milliseconds, duration_milliseconds,
     stage_timings,
     parse_pages, parse_ocr_pages, parse_slices, figures_selected, figures_cached,
     figures_captioned, figures_failed, chunks_created
   ) ON ingest_job_attempts TO capy_ops;

   GRANT EXECUTE ON FUNCTION touch_operator_seen(text) TO capy_ops;
   GRANT EXECUTE ON FUNCTION request_reconciliation(text, text, text)
     TO capy_ops_admin;
   GRANT EXECUTE ON FUNCTION record_registry_audit(
     text, bigint, bigint, bigint, bigint, bigint, text
   )
     TO capy_ops_admin;
   GRANT EXECUTE ON FUNCTION save_resource_credit_rate(
     text, text, bigint, text
   ) TO capy_ops_admin;

   GRANT SELECT (
     version, provider_name, model_name, provider_slug, model_slug,
     platform_enabled, byok_enabled, thinking_levels, default_thinking,
     context_window_tokens, params, slots, capabilities, micros_per_input_token,
     micros_per_cached_input_token, micros_per_output_token, enabled,
     is_default_for, created_at, updated_at, created_by, updated_by
   ) ON model_configs TO capy_ops_admin;
   GRANT SELECT (id, version, updated_at)
     ON model_registry_state TO capy_ops_admin;
   GRANT SELECT (
     id, embedding_provider_slug, embedding_model_slug,
     embedding_model_version, embedding_dim
   ) ON workspaces TO capy_ops_admin;
   GRANT SELECT (
     id, email, locale,
     chat_model_provider_slug, chat_model_slug,
     generate_model_provider_slug, generate_model_slug,
     editor_model_provider_slug, editor_model_slug,
     quiz_model_provider_slug, quiz_model_slug
   ) ON users TO capy_ops_admin;
   GRANT SELECT (
     user_id, email_workspace_invite, email_membership, email_billing
   ) ON notification_prefs TO capy_ops_admin;
   GRANT SELECT (
     id, user_id, kind, data, href, workspace_id, workspace_invite_id,
     at, read_at
   ) ON notifications TO capy_ops_admin;
   GRANT SELECT (idempotency_key) ON email_outbox TO capy_ops_admin;
   GRANT SELECT (user_id, provider_slug)
     ON user_llm_credentials TO capy_ops_admin;

   GRANT INSERT (
     version, provider_name, model_name, provider_slug, model_slug,
     platform_enabled, byok_enabled, thinking_levels, default_thinking,
     context_window_tokens, params, slots, capabilities, micros_per_input_token,
     micros_per_cached_input_token, micros_per_output_token, enabled,
     is_default_for, created_by, updated_by
   ) ON model_configs TO capy_ops_admin;
   GRANT UPDATE (enabled, is_default_for, updated_at, updated_by)
     ON model_configs TO capy_ops_admin;
   GRANT EXECUTE ON FUNCTION model_configs_thinking_ok(text[], text[], text)
     TO capy_ops_admin;
   GRANT UPDATE (version, updated_at)
     ON model_registry_state TO capy_ops_admin;
   GRANT UPDATE (
     chat_model_provider_slug, chat_model_slug,
     generate_model_provider_slug, generate_model_slug,
     editor_model_provider_slug, editor_model_slug,
     quiz_model_provider_slug, quiz_model_slug,
     updated_at
   ) ON users TO capy_ops_admin;
   GRANT INSERT (
     id, user_id, kind, data, href, workspace_id, workspace_invite_id, at
   ) ON notifications TO capy_ops_admin;
   GRANT INSERT (
     id, user_id, to_email, template, locale, payload, idempotency_key
   ) ON email_outbox TO capy_ops_admin;
   ```

   Ops validates the eight `plan_limits` column grants before it loads the
   startup catalog. A missing grant therefore fails as a role-contract error,
   rather than as a later plan-catalog query error.

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

---

## 9. Changing models in the registry

Most slots are safe to retarget from the ops dashboard: chat, generate,
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
| `curl -sI https://api.abcd.com/healthz`                                      | `x-request-id` header present                    |
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
is non-sensitive: it is the per-file scope Google recommends so that Picker
apps skip the restricted-scope verification and security assessment. The key
itself only needs the Picker API; Drive calls are made server-side with the
user's OAuth token, which never uses an API key.

### OneDrive File Picker v8 (MSAL)

Create a **second** Entra app. This is a single-page application, not the Clerk
web app.

1. Authentication. Platform **Single-page application**. Redirect URIs are
   `{SPA origin}/msal-redirect.html`, for example
   `http://localhost:5173/msal-redirect.html` and
   `https://abcd.com/msal-redirect.html`. Leave **Implicit grant and hybrid
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
| Stripe              | `Stable Studio Dev` sandbox, `stripe listen` | named UAT sandbox with a registered endpoint                                             | live mode                                       |
| Product mail        | log backend, no credentials          | Resend `uat.capynotebook.com`, domain-scoped key                                            | Resend on the production domain                 |
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
4. Choose explicit hostnames one level below the zone, for example
   `uat.example.com`, `uat-api.example.com`, `uat-collab.example.com`, and
   optionally `uat-ops.example.com`. Cloudflare's free Universal certificate
   covers only `example.com` and `*.example.com`; a name like
   `api.uat.example.com` fails the TLS handshake at the edge unless the zone
   pays for Advanced Certificate Manager. Configure DNS, Cloudflare, tunnel
   routing, origin lockdown, cache bypass, WebSocket support, and `/api`
   reverse proxy using §§1–3. Do not use wildcard host authorization for
   review tooling.
5. Copy `deploy/.env.uat.example` to ignored `deploy/.env.uat`, fill only UAT
   values and upload them to the GitHub `uat` environment using §12.7. Set `APP_ENV=production`; UAT must exercise production safety
   checks. Set `SENTRY_ENVIRONMENT=uat`, which is the only thing keeping UAT
   errors out of production's Sentry bucket. Set
   `OPS_INGEST_PRIMARY_ENVIRONMENT=uat` and leave
   `OPS_INGEST_UAT_DATABASE_URL` unset. The standalone Ops renderer requires the
   primary environment to match the deployment target (§8). Use the UAT origins in `APP_URL`, CORS, collaboration, OAuth, Sentry,
   and browser build variables.
6. The deployment publishes Worker `capy-notebook-uat` with the built assets and
   live summary handler. Attach only the UAT site domain after verifying it,
   following the Pages cutover order in §1. No summary storage service is needed.
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

1. Activate the UAT application's Production instance and configure the UAT
   application domain. Complete any required Clerk DNS records.
2. Enable the same sign-in methods, session lifetime, organization settings,
   and restrictions intended for production. If Google or Microsoft OAuth is
   enabled, create separate UAT OAuth credentials and UAT redirect URLs.
3. Add the UAT SPA and ops origins to the instance's allowed origins and
   redirect URLs. Do not add production origins unless the provider explicitly
   requires them.
4. Create `https://uat-api.example.com/webhooks/clerk`, selecting the same
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
exemptions.

#### Running the SPA locally against UAT

A Clerk production instance does not authenticate on `localhost`, so a local
`pnpm dev` that talks to the UAT gateway has to be served from a real origin.
`pnpm dev:tunnel` publishes the dev server through its own Cloudflare tunnel,
created on the developer's machine and unrelated to the `capy-uat` tunnel on
the VM, at the hostname in `VITE_DEV_HOST`. The DNS record points at that
laptop; only the API calls Vite proxies reach the VM. `pnpm dev:public` then
serves it (plain `pnpm dev` stays on localhost).

The hostname is one label under the instance's Clerk primary domain,
`dev-<name>.uat.capynotebook.com`. Clerk shares sessions across subdomains of
the primary domain with no SPA configuration; a sibling such as
`dev.capynotebook.com` would be a satellite domain instead, needing its own
Clerk registration, a `clerk.` CNAME per developer, and `isSatellite` props in
`AppAuthProvider`. Two labels is past the free Universal certificate, so the
zone carries an Advanced Certificate Manager pack for `uat.capynotebook.com`
and `*.uat.capynotebook.com`. The tunnel script derives the expected domain by
decoding `VITE_CLERK_PUBLISHABLE_KEY` and refuses a hostname that would land
outside it.

Per developer, the only entry that is not already a wildcard is the collab
origin: append `https://dev-<name>.uat.capynotebook.com` to
`COLLABORATION_ALLOWED_ORIGINS` and redeploy, or no note connects to the
editor websocket. `deploy/b2-cors.uat.json` covers every such hostname with
`https://*.uat.capynotebook.com`, and Clerk needs nothing unless the instance
has the subdomain allowlist enabled.

The browser key must belong to the instance the gateway validates against:
`VITE_API_URL=https://uat-api.capynotebook.com` requires the UAT `pk_live` in
`VITE_CLERK_PUBLISHABLE_KEY`. A `pk_test` there is a 401 on every request.

The same tunnel carries `/webhooks/` to a locally-run gateway on port 8080,
ahead of the catch-all rule that serves Vite. That is how the Clerk
**development** instance reaches a developer's machine, which it otherwise
cannot: point its webhook at
`https://dev-<name>.uat.capynotebook.com/webhooks/clerk` with the same three
events, and put that endpoint's signing secret in the developer's
`CLERK_WEBHOOK_SECRET`. Those deliveries return 502 whenever no local gateway
is running, which is the normal state in this lane. The UAT production
instance keeps delivering to `uat-api` and is unaffected.

Endpoints are per developer, never shared: a hostname reaches exactly one
laptop, and each endpoint carries its own signing secret. The development
instance fans every subscribed event out to all of them, so a second
developer's signup arrives at everyone's local gateway and lands in each local
database. Create an endpoint only while actually working on webhook handling,
and disable it afterwards, or Clerk eventually disables it for sustained
delivery failures anyway.

This lane shares one UAT database and bucket, and it cannot change the
backend. The migrator records a checksum per migration and refuses to run when
an applied file changes (`server/internal/store/migrate.go`), so schema work
needs a database the developer can drop or migrate forward: the gateway,
Postgres and Redis run locally on the Clerk development instance for that.

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

| Lane       | Stripe environment                                | Delivery                     |
| ---------- | ------------------------------------------------- | ---------------------------- |
| production | live mode                                         | registered endpoint          |
| UAT        | `Stable Studio UAT`, `acct_1U8Djl2ZZopeANOe`      | registered endpoint          |
| local dev  | `Stable Studio Dev`, `acct_1UC8tXFKth3QfmPW`      | `stripe listen`, no endpoint |

**UAT sandbox.** `Capy Notebook Pro` (`prod_VBvlTdsu2tTdkK`) with a monthly
USD 8.00 price, `price_1UBXuV2ZZopeANOehrbUr1Qx`. The endpoint is
`we_1UBtgI2ZZopeANOeoftHsYMT` at
`https://uat-api.capynotebook.com/webhooks/stripe`. Put the sandbox
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
needs no tunnel — unlike Clerk, whose development instance can only reach a
laptop through the `dev-<name>` hostname (§12.3). Nothing persists in the
dashboard, so there is no endpoint to auto-disable while a laptop is off and
no per-developer secret to rotate. Other developers' events still arrive,
because the fan-out is per environment; only per-developer sandboxes would
stop that, and that is not worth the setup today.

The event selection in every lane is exactly what the handler switches on:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, and
`invoice.payment_failed`. Anything else is delivery the gateway discards.

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

### 12.5 Resend: one UAT sending domain

Resend has no sandbox. Isolation is per sending domain, and both reputation
and the suppression list follow the domain, so UAT and production must never
share one. UAT sends from `uat.capynotebook.com`; production takes
`capynotebook.com`, or a `mail.` subdomain under it, when it exists.

Local development needs no Resend credentials. `newEmailSender`
(`server/cmd/api/email.go`) falls back to the log backend when
`RESEND_API_KEY` is empty and refuses `resend` outright under `APP_ENV=e2e`,
so local keeps `EMAIL_BACKEND=log` and leaves the key blank. Setting
`EMAIL_BACKEND=resend` without a key fails gateway startup rather than
degrading.

DNS for `uat.capynotebook.com` goes in the `capynotebook.com` Cloudflare zone.
Cloudflare appends the zone to the name, so enter these exactly as written;
TXT and MX are never proxied, so there is no orange-cloud decision:

| Type | Name                    | Value                                          | Priority |
| ---- | ----------------------- | ---------------------------------------------- | -------- |
| TXT  | `resend._domainkey.uat` | the DKIM `p=…` value from the Resend dashboard | —        |
| MX   | `send.uat`              | `feedback-smtp.us-east-1.amazonses.com`        | 10       |
| TXT  | `send.uat`              | `v=spf1 include:amazonses.com ~all`            | —        |

All three resolve and the domain is verified. Set `EMAIL_BACKEND=resend`,
`RESEND_API_KEY` to the domain-scoped `Capy Notebook UAT (sending)` key,
`EMAIL_FROM=Capy Notebook <notifications@uat.capynotebook.com>`, and a fresh
32-byte `EMAIL_UNSUBSCRIBE_SECRET` in the UAT Coolify resource. A
sending-scoped key restricted to this domain cannot send from production's
domain even if it leaks.

Neither `capynotebook.com` nor the UAT subdomain publishes DMARC. Low-volume
authenticated mail is accepted without it, so this does not block UAT, but
`_dmarc.uat.capynotebook.com` as `v=DMARC1; p=none;` is worth adding before any
real volume. Mind the inheritance when production arrives: a subdomain with no
record of its own falls back to the organizational domain's policy, so
publishing `p=reject` at `capynotebook.com` starts rejecting UAT's failures too
unless that record carries an explicit `sp=`.

Resend does have webhooks — `email.sent`, `email.delivered`, `email.bounced`,
`email.complained`, and the open/click pair. The gateway subscribes to none of
them and there is no `RESEND_WEBHOOK_SECRET` anywhere in the tree, so no
endpoint is registered and no cross-environment fan-out exists. Adding bounce
or complaint handling reopens the same per-environment question Stripe has.

`bounced@resend.dev` and `complained@resend.dev` exercise the failure paths
without touching a real inbox or the domain's suppression list.

### 12.6 Create the authorization fixture

After Clerk webhooks are healthy and the UAT deployment is stable:

1. Sign in as the synthetic owner and create one private workspace and one
   small, non-sensitive material.
2. Invite the editor, commenter, and viewer with their matching roles. Sign in
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
and derived release values remain local. `VITE_DEV_HOST` also stays local. Double-quoted `\n` escapes can hold
an SSH private key. Do not put actual multiline shell fragments in the file.

Every deployment reads GitHub's environment values afresh, renders private
runner files, and applies/reads back all managed Coolify variables. Empty
optional values remain literal blanks. After successful replacement readback, the sync removes only the corresponding old `EVO_*` names and retired `EVO_QUERY_MODEL`, `IMPORT_RELAY_ENQUEUE_URL` / `IMPORT_RELAY_SECRET`, verifies their absence, and preserves unrelated normal variables. The sync disables preview entries and
uses `is_literal=true`, `is_shown_once=false`; it prints neither values nor
fingerprints. Coolify's token needs sensitive-read access for verification.
The Cloudflare token needs Worker scripts/assets deployment access. Retire
`CLOUDFLARE_PAGES_PROJECT` and `CLOUDFLARE_PAGES_BRANCH` in GitHub before the
first new deployment; they are rejected as unknown inputs.

Required families include application origins, Clerk/webhook keys, Postgres,
B2, collaboration/pipeline secrets, actual provider/mail/billing keys, Coolify
and Cloudflare credentials, and ingest SSH/token/network settings. Runtime
DSNs derive from the selected environment's private address and URL-encoded
Postgres password. Never copy a development bucket or production secret into
UAT merely to fill a missing input.

Deterministic quality URLs, authorization flag, synthetic account emails and
fixture IDs belong in the GitHub `uat` environment and use the same upload
path. Keep `UAT_DEPLOYMENT_ENABLED=false` as a separate **repository** variable
until the first manual baseline passes. The local scanner authorization flag
still requires explicit permission to scan that UAT target.

Use **Deploy UAT** for the coordinated app/backend/ingest/site release,
**Deploy ingest** for an ingest-only run against an already matching backend
SHA, and **Deploy Ops** for the independent dashboard and its Go backend. All
apply their selected GitHub configuration on every run. Native Coolify
Git auto-deploy stays disabled. Production promotion retains UAT, editor-perf,
source-security, Strix, and protected-environment gates.

### Independent Ops application

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
   or leave it blank for the selected main revision. Successful CI is required.

Each run verifies that its target is a different Coolify application with the
Ops Compose file and a shared Coolify destination with predefined networking
enabled on both applications, synchronizes and reads back GitHub configuration, and deploys
that exact commit. The provider deployment result verifies the commit, and the
container health check probes the Ops Go process. Verify dashboard sign-in and
an authenticated read after the first deployment. Ops does not run migrations
or redeploy the main app, ingest workers, or frontend Workers.

Production additionally requires a successful **Deploy Ops uat** run for the
same SHA, the existing source-security/Strix commit statuses, and the GitHub
production environment protection. The workflow shares the main promotion
concurrency group so it cannot restart Ops during an app migration. Ops may
use a newer code revision than the main app for schema-compatible changes;
changes requiring new database tables/columns must deploy the main migrations
first. Roll back compatible Ops changes by selecting a previous passing SHA.

### 12.8 Baseline, automation, and release gate

1. Leave `UAT_DEPLOYMENT_ENABLED=false` initially. This prevents successful CI
   runs from deploying to a half-configured target.
2. Manually dispatch **Deploy UAT** from `main`. It deploys the selected SHA and
   automatically calls **Deterministic UAT quality**. Inspect Coolify, Worker,
   smoke, and Playwright evidence, including release-SHA, accessibility, and
   320 CSS-pixel reflow checks.
3. Repair the fixture and tune only documented budgets or exclusions. Do not
   weaken authorization assertions or allow-host guards to make a run green.
4. After a stable baseline, set `UAT_DEPLOYMENT_ENABLED=true`. Every successful
   `CI` run for `main` then deploys its exact SHA to UAT and calls the same gate.
   Dispatch **Editor perf** once so later runs have a baseline to diff. No
   workflow has a schedule.
5. Before a promotion, on the developer machine with `gh auth login` done:
   run `pnpm review:source:codex` on the clean candidate checkout, and
   `pnpm review:uat:strix` while UAT serves that SHA. Each posts its commit
   status (`source/codex-security`, `uat/strix`) on the SHA. Triage candidates
   rather than suppressing unexplained results. When the release warrants the
   full review, invoke `$review-repository` in `release` mode; it runs both
   scans as part of its procedure.
6. Perform the manual Stripe sandbox sequence in §12.4 plus the release checks
   for over-quota/suspension, ingest/index/search, cleanup, reconciliation,
   collaboration revocation, and recovery until dedicated synthetic fixtures
   automate them.
7. Dispatch **Promote revision to production** with the exact full SHA. The
   workflow re-stages UAT, re-runs the deterministic gate and editor perf on
   that SHA, refuses the SHA unless both scanner statuses are `success`, waits
   for production approval, deploys both production resources, and verifies
   the public release SHA and health. Then perform the bounded login, upload,
   collaboration, webhook, and observability checks in §10. Production is not
   a penetration-test target.

Set `UAT_DEPLOYMENT_ENABLED=false` immediately if UAT is being rebuilt, its
fixture is invalid, or allowed-host ownership changes. Manual deployment and
quality dispatch remain available for repair. Rotate Clerk and LLM secrets
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
  --ssh-key ~/.ssh/id_ed25519_evo_uat \
  --db-container <actual-UAT-Postgres-container>
```

Find the exact Postgres container name in the UAT Coolify resource or with
`ssh -i ~/.ssh/id_ed25519_evo_uat root@159.195.250.206 docker ps`.
The script targets only this UAT host and checks the database schema before
creating accounts. The ignored environment file must select the UAT URLs and
contain the UAT Clerk backend key. The script also verifies the key's primary
Clerk domain before changing accounts.

The approved emails are `capy-uat-{owner,editor,commenter,viewer,other}+clerk_test@stablestudio.org`.
Missing users are created through Clerk's backend API with verified email
addresses and no password or invitation. Existing users must remain active with
the matching verified primary email. UAT browser tests use short-lived sign-in
tickets; the seed stores no reusable login tokens.

The SQL transaction inserts missing application users, private workspace
`ws_uat_authorization_v1`, and note `note_uat_authorization_v1`, assigning owner,
editor, commenter and viewer membership. The other account remains uninvited.
Repeated runs preserve content and revision history. Identity, lifecycle,
ownership or permission drift stops the transaction; it never resets accounts,
restores deleted data or overwrites existing note content. Storage is accounted
through the normal database triggers.

To prepare or verify only the Clerk accounts while the backend is unavailable:

```sh
pnpm uat:seed --file deploy/.env.uat --accounts-only
```

GitHub UAT variables `UAT_OWNER_EMAIL`, `UAT_EDITOR_EMAIL`,
`UAT_COMMENTER_EMAIL`, `UAT_VIEWER_EMAIL`, `UAT_OTHER_EMAIL`,
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
