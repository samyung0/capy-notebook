# Security todo

Living list from the UAT and local probe runs. Updated as tests run; entries move
from open to verified or fixed.

Scope: `uat-api.capynotebook.com`, `app.uat.capynotebook.com`, the Cloudflare zone,
the Docker e2e stack, and the deploy configuration in this repository. Production
was not touched.

Method: deterministic request batteries against the local e2e gateway and UAT with
real Clerk sessions, plus static review of the gateway, auth middleware and store
access predicates. ARTEX ran against the local stack; it is not trusted with a
session token.

## Open

### P0

- [ ] **Coolify control panel is publicly reachable.**
  `uat-coolify.capynotebook.com` serves the Coolify login page to the internet with
  no Cloudflare Access in front. Confirmed: `/login` returns 200 with a valid
  `coolify_session` cookie, `/api/health` returns `OK`. Access policies exist for
  `uat-ops` and `playground` only. Coolify is the deployment control plane for the
  UAT host, so its login is a credential-stuffing target and a future-CVE target
  with server-level consequences.
  Fix: add an Access application for `uat-coolify.capynotebook.com` with the same
  operator policy as `uat-ops`, or delete the DNS record and reach it over the
  tunnel only.

- [ ] **Root SSH keys for prod, UAT and ingest are unencrypted on the workstation.**
  `~/.ssh/id_ed25519_capy_{prod,uat,ingest}` all report `cipher=none`, mode 600, no
  passphrase. Any process running as the user owns all three machines.
  Fix: `ssh-keygen -p -f` on each, load only into an interactive agent, and keep
  `SSH_AUTH_SOCK` out of containers and agent runs.

### P1

- [ ] **API documentation is public on the UAT API.**
  `GET /openapi.json` returns 200 with 233,622 bytes and 161 paths, listing
  `/api/billing/*`, `/api/account/deletion`, `/api/workspaces/{id}` and the rest of
  the surface. `GET /docs` returns the docs page. Same behavior on the local e2e
  build. Confirmed by ARTEX independently, then by hand.
  Fix: gate `/docs` and `/openapi.json` behind the same auth as the API, or serve
  them only when `APP_ENV != production`.

- [ ] **Persistent tunnel record for a developer machine.**
  `dev-sam.uat.capynotebook.com` is a CNAME to a `cfargotunnel.com` hostname,
  currently returning 1033 because the tunnel is down. The record outlives the
  tunnel, so starting a local tunnel republishes a development environment under
  the production zone without any further change.
  Fix: remove the record, or put it behind Access with an operator policy.

### P2

- [ ] **CORS defaults to wildcard when the allowlist is unset.**
  `corsOrigins` in `server/internal/httpapi/server.go:41` returns `["*"]` for an
  empty configuration. Prod compose makes `CORS_ALLOWED_ORIGINS` mandatory, and UAT
  is correctly locked down (a hostile Origin gets no `Access-Control-Allow-Origin`),
  but the code default is open. Local e2e confirms the behavior: preflight for
  `DELETE` from `https://evil.test` returns `Access-Control-Allow-Origin: *`.
  Fix: return an empty list and let the middleware deny.

- [ ] **Anonymous rate limits are unproven.**
  40 rapid requests to `/api/public/quizzes/...` on local and 25 on UAT produced
  only 404s, never a 429. Either the limit is above that or the anonymous path
  isn't limited. Not proven either way.
  Fix: confirm the configured limit, then test at that threshold.

- [ ] **`/healthz` publishes the release SHA.**
  `server/internal/httpapi/server.go:280` sets `X-Capy-Release` from
  `cfg.ReleaseSHA`. UAT returned only `ok` without the header, so it depends on the
  build. Fingerprinting only.

- [ ] **Event delete returns success for resources you do not own.**
  `DELETE /api/events/{id}` as a second user returns 204 and leaves the owner's
  event intact. Scoped delete, unchecked `RowsAffected`. No data impact; it hides
  the distinction between "deleted" and "not yours".

## Verified, no issue

- [ ] Cross-tenant reads, updates, deletes, clones, transfers, sharing flips and
  collaboration-token minting all return 404 on UAT and local. 19 of 22 attempts
  denied on UAT; the three that succeeded were the caller's own workspace list,
  empty search results and empty trash.
- [ ] The E2E identity bypass is disabled on UAT. `X-E2E-User-Id` with no
  credentials returns 401, and supplying a real user id does not authenticate.
- [ ] `AUTH_DISABLED` refuses to boot outside `APP_ENV=development`
  (`server/cmd/api/main.go:126`). `E2E_AUTH` requires `APP_ENV=e2e`, a secret and a
  user allowlist.
- [ ] Webhooks verify signatures and fail closed when the secret is missing:
  Stripe via `webhook.ConstructEvent`, Clerk via svix `Verify`.
- [ ] `/api/internal/*` returns 401 without `X-Pipeline-Secret`; all 15
  `/internal/collaboration/*` handlers carry a constant-time secret check.
- [ ] Share links: forged tokens 404, and an asset id that does not belong to the
  shared material 404s. Asset scoping is enforced in SQL by `material_id`.
- [ ] Cloudflare Access covers `uat-ops` (email allowlist plus a service token for
  smoke tests) and `playground`. `uat-ops` redirects to the Access login.
- [ ] `CAPY_PRIVATE_BIND_ADDRESS=10.77.0.3`, so Postgres, Redis and the parser bind
  to the WireGuard address rather than `0.0.0.0`.
- [ ] Git history is clean. 2,207 refs scanned for provider keys, private key
  blocks and committed `.env` files; every hit was a `sk_test_fake` fixture.

## ARTEX goal brief

The goal text drives the planner's decomposition, so it carries scope, identity,
priorities, prohibitions and the evidence bar. Unauthenticated pass first, then the
authenticated pass with two fixture identities.

### Pass 1, unauthenticated

```
Authorized scope: https://app.uat.capynotebook.com, https://uat-api.capynotebook.com,
https://uat-collab.capynotebook.com. Disposable UAT environment. Never touch
capynotebook.com or any host not listed. Do not send email, do not start payments.

Goal: map and probe the entire unauthenticated surface.
1. Pull every path from https://uat-api.capynotebook.com/openapi.json and fetch each
   one without credentials. Record every non-401 response with its body.
2. Check /docs, /openapi.json, /healthz, /metrics, /.well-known, /robots.txt and
   common build artifacts for disclosure.
3. Probe /api/internal/* and /internal/collaboration/* for missing secret checks,
   timing differences and error-message leakage.
4. Test share links: valid token, forged token, token for resource A used on resource
   B, asset ids outside the shared resource.
5. Test webhooks /webhooks/stripe and /webhooks/clerk: unsigned, wrong signature,
   replayed event id, malformed body. Expect rejection; report any acceptance.
6. Open a WebSocket to uat-collab with no token, an expired token, and a token for a
   different room. Report anything that returns document content.
7. Upload hostile files through the source upload path where it is reachable without
   auth: zip bomb, PDF with external entities, DOCX with traversal filenames, SVG with
   script, oversized body.
8. Check CORS with a hostile Origin, TLS and security headers, and whether the API
   reveals stack traces or SQL on malformed input.

Evidence bar: every finding needs the exact request, the exact response, and a
statement of what an anonymous attacker gains. No speculative findings.
```

### Pass 2, authenticated

```
You have two bearer tokens for UAT: OWNER and OTHER. Both are real Clerk sessions on
this disposable environment. Use only these two. Never use any other credential.

Goal: find broken access control. Assume the gateway checks authentication correctly;
attack authorization.
1. As OWNER create one workspace with a chapter, a note, a quiz, a flashcard set, a
   conversation, an event, a label and an uploaded source.
2. As OTHER replay every route that takes an id from OWNER's objects: read, update,
   delete, clone, share, transfer, invite, mint a collaboration token, request export.
   Record anything that returns 2xx or leaks a field.
3. Role matrix: put OTHER in the workspace as viewer, then commenter, then editor.
   For each role test every mutation and every read. Report the first action a role
   can take that it should not.
4. Invites: accept an invite addressed to a different email, accept the same invite
   twice, accept after role downgrade, invite yourself to a workspace you can only
   read.
5. Share links: change privacy to link and public, then as OTHER and anonymously
   compare what each can read. Check whether a shared workspace exposes private
   children, and whether shareRole can be raised by the recipient.
6. Collaboration tokens: request a read token, use it for a write, use a token from
   room A on room B, reuse after expiry, reuse after access was revoked.
7. Billing and credits: check whether plan gates hold across the two identities, and
   whether usage or subscription state can be altered without a webhook.
8. Account lifecycle: request deletion as OTHER, confirm OWNER is unaffected and that
   a revoked session cannot reach any route.

Evidence bar: reproduce every finding with two requests, one as each identity. State
who gains what.
```

## Not yet tested

- [ ] Collaboration service (`uat-collab.capynotebook.com`): rooms, Yjs sync, source
  document bootstrap. The local Rust image failed to build under Docker's memory
  cap, so this path has never been exercised.
- [ ] B2 presigned uploads and downloads, including presign scope and TTL, against
  the UAT bucket.
- [ ] Billing routes. Needs Stripe test-mode confirmation before any request.
- [ ] Viewer-to-editor escalation through a workspace invite, which requires sending
  one email to a UAT fixture address.
- [ ] Ops API authorization behind Access (`uat-ops`), beyond the Access gate itself.
- [ ] Ingest host and parser host exposure.
