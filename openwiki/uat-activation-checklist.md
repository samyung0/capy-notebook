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
| Gateway refuses to start with Clerk configured | `CLERK_SECRET_KEY` or `CLERK_WEBHOOK_SECRET` is blank. Both are required unless `AUTH_DISABLED` or `E2E_AUTH` is on. |
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
`syncClerkAccount`). A `200` in the delivery log is the only proof the webhook
itself works. Until it does, profile edits made in Clerk never reach the
database and deleted identities are never purged.

A `401` from the endpoint means the signing secret does not match the instance
that sent the delivery. A `503` means `CLERK_WEBHOOK_SECRET` is still blank.

The Clerk development instance has its own endpoint, pointed at a developer's
tunnel (`https://dev-<name>.uat.capynotebook.com/webhooks/clerk`) rather than
at `uat-api`. The two instances never share a signing secret, and a gateway
verifies with exactly one.

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
- `user_storage` moves after an upload and after a delete. Quota accounting is
  described in [`backend-storage-quota.md`](backend-storage-quota.md).
- `APP_URL` is `https://app.uat.capynotebook.com`. Stripe returns and product email
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


## Manual critical-path gate

After app and nonproduction ingest are on the same candidate SHA, run **Deterministic UAT quality** with `critical_paths: true`. Verify all nine journeys and both cleanup/release checks passed. Review the retained-resource report, including delayed B2 deletions and provider history. Production promotion reruns this gate. Prerequisites and cleanup retry commands are in the [journey guide](../e2e/uat/journeys/README.md); this has not been validated by a live run during implementation.
