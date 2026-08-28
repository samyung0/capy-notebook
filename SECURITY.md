# Security review contract

This file defines the threat model and reportability rules for automated and
human reviews. The detailed product rules remain in `openwiki/`; this file
identifies the claims a security scan must try to disprove.

## Scope

Review all first-party code and deployment configuration in this repository:

- React/Vite product and operator frontends
- Go product gateway, operator API, migrations, and background jobs
- Python ingest and retrieval services
- Hocuspocus/Yjs collaboration service
- Cloudflare Workers, Docker Compose, Modal integration, and CI workflows

Generated clients, recorded test cassettes, vendored code, and build artifacts
are evidence about first-party behavior but are not primary finding locations.
Report the first-party generator, caller, configuration, or trust decision that
creates the problem.

## Assets

- Account identity, sessions, OAuth tokens, and encrypted user LLM keys
- Private workspace content, files, editor state, comments, and conversations
- Object storage bytes and presigned upload/download capabilities
- Storage quota, inference credits, subscription state, and usage ledgers
- Provider credentials, webhook secrets, internal service secrets, and database
  credentials
- Operator privileges, registry changes, and reconciliation actions
- Availability of the gateway, collaboration rooms, retrieval, ingest, Redis,
  Postgres, and object storage

## Actors and trust boundaries

Treat anonymous visitors, signed-in shared visitors, explicit workspace roles,
workspace owners, operators, provider webhooks, internal services, and
background workers as distinct actors. Do not infer permission at one boundary
from permission at another.

The important boundaries are:

- Browser to product gateway
- Browser to Clerk, Stripe, object storage, and collaboration WebSocket
- Cloudflare to public origins
- Gateway to retrieval, import relay, collaboration, Redis, Postgres, and B2
- Worker to Modal, model providers, B2, Redis, and Postgres
- Provider webhooks to unauthenticated webhook routes
- Operator browser through Cloudflare Access and Clerk to the operator API
- Operator API to its four least-privilege database roles
- User-controlled documents, files, URLs, prompts, and provider responses to
  parsers, renderers, model calls, logs, and storage

## Security invariants

### Authorization and visibility

- Private resources do not reveal whether they exist. Unauthorized private
  reads normally return the same result as a missing resource.
- Anonymous users never mutate data. Signed-in shared roles apply only to
  material collaboration, never workspace structure, files, membership, chat,
  generation, statistics, transfer, or sharing settings.
- Workspace membership grants never become weaker because of a share role.
  Share roles never become structural workspace membership.
- Only owners manage members, sharing, workspace settings, statistics,
  deletion, and ownership transfer.
- Conversations, schedules, notifications, billing records, provider keys,
  quiz attempts, mistakes, and integrations remain scoped to their actor.
- A collaboration token grants only the computed `write`, `comment`, `shrink`,
  or read behavior for that material at mint time. Membership, sharing, account
  state, or quota changes evict or constrain existing room access.

### Account lifecycle

- Deleted, suspended, and deletion-pending accounts cannot retain product or
  operator access.
- Over-quota accounts retain read and recovery operations but cannot create
  additional owned storage, widen exposure, or grow owned material.
- Deletion, transfer-away, shrink, rename, refile, and reorder remain available
  when they are needed for quota recovery.
- Product account locks still apply to operators.

### Storage and billing

- Workspace storage is always charged to the workspace owner. Inference,
  parse, embedding, GPU, and mail costs are charged to the actor who caused
  them.
- Storage admission locks used and reserved bytes in one transaction. Upload
  reservations prevent concurrent overspend and release on expiry or failure.
- Shared blobs are deleted only after the last durable reference disappears.
  Cleanup workers recheck references before deleting an object.
- Provider spend requires a durable authorization before the provider call.
  Settlement is idempotent for a stable call id and does not silently reuse a
  newer model or price.
- Stripe and Clerk webhook signatures are verified before state changes.
  Replays, duplicates, and out-of-order Stripe events cannot roll state back.

### Service and deployment isolation

- Retrieval, ingest workers, Postgres, and Redis have no public route.
- Internal gateway and retrieval routes require the shared pipeline secret.
- Operator access requires Cloudflare Access, Clerk, operator membership, and
  the permission token for the requested operation.
- The operator service cannot read note bodies, file bytes, email payloads, or
  other customer content through its routine database role.
- Production never enables `AUTH_DISABLED`, E2E authentication, rate-limit
  bypasses, unsafe operator mode, owner database credentials, or local demo
  seeds.
- CORS, collaboration origins, OAuth redirects, and Clerk production domains
  use explicit allowlists.
- Logs, traces, analytics, reports, and CI artifacts do not contain prompts,
  note bodies, tokens, passwords, API keys, webhook signatures, or test account
  secrets.

### Untrusted content

- File names, MIME declarations, archives, parsed text, URLs, document nodes,
  Markdown, Mermaid, HTML, model output, citations, and provider errors are
  untrusted.
- URL fetching resists SSRF, redirect-based allowlist bypass, private address
  access, and DNS rebinding.
- Rendering and export paths do not execute stored script or unsafe URLs.
- Model instructions found in user files or retrieved material never acquire
  tool, authorization, billing, or operator authority.

## High-priority attack paths

Review these paths even when broad discovery does not select them:

1. Cross-workspace and cross-account object access through guessed IDs.
2. Shared-link role escalation into structure, files, chat, or generation.
3. Collaboration token reuse, stale permissions, origin bypass, and growth by
   an editor when the storage owner is over quota.
4. Upload reservation races, late finalize, clone/delete reference races, and
   object cleanup of still-referenced bytes.
5. Source import URL or provider metadata reaching internal networks or another
   user's connected drive.
6. Stripe checkout, webhook replay, subscription ordering, and reconciliation
   changing the wrong user's plan.
7. Clerk identity deletion, webhook ordering, session revocation, and operator
   membership after account locks.
8. LLM credential encryption, actor/provider confusion, prompt injection,
   unmetered provider calls, and cross-user conversation retrieval.
9. Operator database role expansion, Access bypass, registry writes, and
   reconciliation execution.
10. Production configuration that exposes a private service or enables a test
    bypass.

## Reportability

Report a finding only when it has a plausible attacker, affected asset,
reachable path, violated invariant, and first-party remediation. Include the
exact evidence and state what was not verified.

Do not report these as vulnerabilities without a concrete escape from their
guardrails:

- E2E-only authentication under `APP_ENV=e2e`
- Synthetic credentials in committed example files
- Redis rate limiting failing open while edge limits and credit gates remain
- Local development modes explicitly guarded from production
- Intended `404` responses that hide private-resource existence
- Disabled features or unreachable test fixtures

Treat a missing test, weak defense in depth, or uncertain configuration as a
coverage gap unless it creates a reachable exploit.

## Severity

- Critical: unauthenticated or low-privilege compromise of many accounts,
  operator control, arbitrary code execution, broad secret theft, or material
  financial loss.
- High: cross-account private-data access or mutation, reliable privilege
  escalation, meaningful payment abuse, or a production isolation bypass.
- Medium: constrained data exposure or mutation, stored client-side execution,
  exploitable denial of service, or a security control bypass with strong
  prerequisites.
- Low: narrow impact with difficult prerequisites and no sensitive data or
  durable privilege gained.

## Validation rules

- Static suspicion is not enough. Trace attacker input to the violated control
  or sink and test the smallest safe proof when possible.
- Never test a production target. Dynamic testing requires exact authorized
  UAT hosts and synthetic accounts.
- Do not perform denial of service, destructive bulk actions, persistence,
  external-account takeover, or data extraction beyond the minimum proof.
- Redact credentials, tokens, personal data, document contents, and webhook
  payloads from findings and artifacts.
- Preserve uncertainty. A clean scan means no validated issue was found within
  the recorded coverage and budget.

## Canonical design references

- `openwiki/authorization-permissions-lifecycles.md`
- `openwiki/backend-storage-quota.md`
- `openwiki/agentic-retrieval.md`
- `openwiki/frontend/plate-editor.md`
- `openwiki/observability-metering.md`
- `openwiki/deployment-runbook.md`
- `openwiki/test-catalog.md`
