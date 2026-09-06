# UAT activation checklist

What to verify once the Coolify resource for `capy-notebook-uat` has real values and
has deployed at least once. Ordered by dependency: a failure at one step makes
every later step meaningless. Setup instructions live in
[`deployment-runbook.md`](deployment-runbook.md); this file is only the
verification pass.

Hostnames are the ones recorded in `deploy/.env.uat`. Never print secrets from
that file.

## 1. The stack is actually up

```bash
pnpm review:uat:smoke
```

Probes the SPA, `uat-api/healthz`, `uat-collab/healthz`, and the ops edge, and
fails loudly on anything outside the accepted status range. It reads
`deploy/.env.uat` and requires `UAT_TARGET_AUTHORIZED=true`.

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
| Gateway refuses to start with Clerk configured | `CLERK_SECRET_KEY` or `CLERK_WEBHOOK_SECRET` is blank. Both are required unless `AUTH_DISABLED` or `E2E_AUTH` is on. |
| Variables changed but the container behaves as before | Coolify's compose parse is cached and only refreshes on deploy. Redeploy rather than restart. |
| Retrieval or an ingest worker exits naming `CAPY_MODEL_CONCURRENCY` | The variable is required under `APP_ENV=production`; set UAT's own per-model caps (see the runbook §1.4). |

## 2. Clerk webhook

The endpoint is `https://uat-api.capynotebook.com/webhooks/clerk` on the UAT
application's **production** instance, subscribed to `user.created`,
`user.updated`, `user.deleted`. Nothing else is handled
(`server/internal/httpapi/webhooks.go`); other events are verified, claimed and
marked processed as no-ops.

Set its signing secret as GitHub `uat` secret `CLERK_WEBHOOK_SECRET`, or upload
the updated ignored `.env.uat` through `env:push`, then redeploy.

Verify with a real signup, not with the dashboard's test button alone:

1. Sign up a synthetic account on `uat.capynotebook.com`.
2. Clerk's delivery log shows `200` for the `user.created` delivery.
3. `select type, processed_at, error from webhook_events order by created_at desc limit 5;` shows the event processed with no error.

The user row and default workspace appear either way, because the first
authenticated request provisions them (`server/internal/auth/middleware.go`
`syncClerkAccount`). A `200` in the delivery log is the only proof the webhook
itself works. Until it does, profile edits made in Clerk never reach the
database and deleted identities are never purged.

A `401` from the endpoint means the signing secret does not match the instance
that sent the delivery. A `503` means `CLERK_WEBHOOK_SECRET` is still blank.

The Clerk development instance has its own endpoint, pointed at a developer's
tunnel (`https://dev-<name>.uat.capynotebook.com/webhooks/clerk`) rather than
at `uat-api`. The two instances never share a signing secret, and a gateway
verifies with exactly one.

## 3. Stripe webhook

`https://uat-api.capynotebook.com/webhooks/stripe`, sandbox account
`acct_1U8Djl2ZZopeANOe`, with the sandbox signing secret in
`STRIPE_WEBHOOK_SECRET` and `sk_test_…` in `STRIPE_SECRET_KEY`. UAT price IDs
are not interchangeable with live ones.

Confirm the edge does not rate-limit or challenge `/webhooks/`. Both providers
burst on retry and will trip a WAF rule written for browser traffic.

## 4. The local development lane

Two entries have to name each developer's dev hostname
(`dev-<name>.uat.capynotebook.com`):

- `COLLABORATION_ALLOWED_ORIGINS` on the gateway, then redeploy. The collab
  server matches the browser `Origin` against an exact set
  (`collaboration/src/config.ts`).
- Nothing in Clerk, unless the instance has the subdomain allowlist enabled.
  Sessions are shared across subdomains of the primary domain by default.

`deploy/b2-cors.uat.json` already covers every such hostname with
`https://*.uat.capynotebook.com`. Re-apply it to the bucket if it was applied
before that wildcard existed.

Then, from a developer machine running `pnpm dev:tunnel` and `pnpm dev:public`:

| Check | Proves |
| --- | --- |
| Sign in on `https://dev-<name>.uat.capynotebook.com` | Clerk subdomain session sharing, and that `VITE_CLERK_PUBLISHABLE_KEY` is the UAT `pk_live` the gateway validates against |
| Open a note and type | Collab websocket accepted the origin |
| Upload a file | Presigned PUT passed bucket CORS, `complete` recorded the object |
| Open a citation preview | Gateway-served preview path and B2 read credentials |

A `401` on every API call with sign-in working means the browser key belongs to
a different Clerk instance than the gateway's secret key.

## 5. Data and money

- Uploads land in the UAT bucket, not production. Check the bucket name in the
  Coolify variables against `deploy/.env.uat`.
- `user_storage` moves after an upload and after a delete. Quota accounting is
  described in [`backend-storage-quota.md`](backend-storage-quota.md).
- `APP_URL` is `https://uat.capynotebook.com`. Stripe returns and product email
  links follow it, so they will point at the deployed SPA even when the person
  clicking is on a dev hostname. That is expected.
- Provider keys are UAT keys with their own budget. Inference and parse metering
  is in [`observability-metering.md`](observability-metering.md).

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
- Public and link summaries return `Cache-Control: no-store`. Link summaries
  include `X-Robots-Tag: noindex, nofollow`. Changing to private immediately
  returns the same 404 as a missing workspace. Full file/material/quiz routes
  reject anonymous requests.
- GitHub configuration sync/readback passed before deployment. Managed Coolify
  variables are literal, non-preview and readable for verification; unset ones
  are blank. Neither values nor fingerprints appear in runner logs.
- Backend `X-Capy-Release`, SPA `capy-release` and all selected ingest container
  revision labels match the release. The state's `active` agrees, `current`
  resolves to its snapshot and `pending` is absent after success.
- An ingest-only run verifies the already deployed backend SHA. An unfinished
  Coolify job leaves recovery pending rather than resuming incompatible workers.
- Local UI plus UAT still renders the same summary through Vite. Full-local
  Compose uses `deploy/.env` with the renamed `CAPY_*` keys.
