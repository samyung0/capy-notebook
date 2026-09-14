# UAT critical paths

Run these nine journeys deliberately through **Deterministic UAT quality**.
Its `critical_paths` input defaults to true for manual dispatch and false for
the lightweight deploy check. **Promote revision to production** requires it.
Normal pull-request CI does not contact UAT or these providers.

See [setup status](setup-status.md) for the applied UAT configuration and the
verification results and remaining deployment steps.

The browser performs registration, direct uploads, Office/text edits and
collaboration. Assertions read application APIs, PostgreSQL, exact B2 object
bytes/versions, Clerk, Stripe, Resend and Sentry. Selecting an editor input or
button is allowed; layout, nesting, toolbar order and screenshots are not
asserted. The existing authorization suite remains separate. Accessibility scans
run in the local `pnpm e2e:quality` suite and are excluded from the UAT gate.

## Current coverage

| Journey | Verified outcome |
| --- | --- |
| Account | Real signup with fixed Clerk code, verified identity, processed `user.created`, durable profile, 30-day deletion grace, session revocation, Resend delivery, real Clerk deletion and processed `user.deleted` purge. |
| Checkout | App-created sandbox customer/session/reservation, expected price and return URLs, session expiration. |
| Billing | Sandbox subscription, paid renewal using a test clock, webhook-backed plan projection, deletion blocker and cancellation. Hosted payment-form entry is not covered. |
| DOCX, XLSX, PPTX | Browser reserve/PUT/complete, exact source hash, parse/index facts and vectors, saved native edits from two accounts, first open by a third account, native export, reprocessing, trash/restore/purge. Spreadsheet formulas and document content survive. |
| UTF-8 text | Browser edit, persisted Y.Text, automatic indexing and exact published bytes. |
| Digital PDF | Upload/index and unchanged bytes; API-based private annotation isolation. Pointer gestures and visual rendering are outside this assertion policy. |
| Invalid CSV | Direct-ingest cell limit fails terminally, no index/model spend publishes, exact expected error reaches Sentry. |

Each test registers a disposable primary account. Collaborators use real Clerk
accounts and short-lived sign-in tickets. No test writes the database, bypasses
app authorization, fabricates signed webhooks, or changes shared parser settings.
Browser setup follows [Clerk's Playwright testing helper](https://github.com/clerk/javascript/blob/main/packages/testing/src/playwright/setupClerkTestingToken.ts):
it sends an instance testing token and overrides only the Clerk client CAPTCHA
flag. The token alone does not prevent the browser from waiting for a challenge.
The initial suite does not yet cover every feature or file type. Image/audio
codecs, scans, legacy Office, structural Office edits, native citation paint,
study tools, account restoration and actual OAuth consent remain gaps.

Google/OneDrive downloads are fixture-backed isolated tests in
`pipeline/tests/test_import_stage.py` and `server/internal/integrations/oauth_test.go`.
Google Docs/Sheets/Slides retain their DOCX/XLSX/PPTX export formats; Drawings
still export as PDF. Live imports are excluded from this unattended gate.

## Fixtures

Commit small synthetic inputs under `e2e/fixtures/files/`. The working set is
`basic/`, with exact contents and regeneration instructions in its README.
Use additional named directories for future sets, with a README documenting
each source, expected facts, editing capabilities and preserved content.
See `e2e/fixtures/files/README.md` for the full format matrix.

Office/text copies receive a unique run marker in memory before uploading;
committed originals are never changed by a run. The current runner explicitly
names its fixtures in `files.spec.ts`. To add a set, add parameterized cases
with explicit content/edit expectations there. Merely putting files in a
directory does not create coverage. Never commit real documents, credentials,
user data, screenshots, signed URLs or generated run reports.

## One-time setup

Use the isolated UAT services and deploy the same full Git SHA to the app,
gateway, collaboration, Office worker and the nonproduction ingest project.
Ingest deployment remains a separate manual operation. The suite verifies
app/Office release metadata, gateway/collaboration release headers, migration
0016, actual ingest image revisions and job attempt environment/revision.
Office uses native state and parser bundle v4; no retained PDF preview is
expected. Optional B2 parse caches are inspected when present.

Configure these GitHub **uat environment** values. Full mappings are in
`deploy/env-manifest.json`; never paste secret values into run artifacts.

| Variables | Setup |
| --- | --- |
| `UAT_TARGET_AUTHORIZED` | Exactly `true`. |
| `UAT_APP_URL`, `UAT_API_URL`, `UAT_COLLAB_URL` | Exactly `https://app.uat.capynotebook.com`, `https://uat-api.capynotebook.com`, `wss://uat-collab.capynotebook.com`. Office is `https://uat-office.capynotebook.com`. |
| `UAT_CLERK_TEST_MODE` | Exactly `true`, after enabling Clerk test emails/fixed code `424242` on the isolated UAT instance. Keys must resolve to its primary domain and `clerk.uat.capynotebook.com`. |
| `CLERK_PUBLISHABLE_KEY`, `UAT_ACTOR_EMAIL_DOMAIN` | UAT frontend key and a controlled domain accepting generated `uat-…+clerk_test` mailboxes. Clerk auth uses fixed codes; app Resend mail must actually deliver. |
| `UAT_DATABASE_NAME` | Actual dedicated UAT database. Apply `scripts/uat/verifier-role.sql` manually as its owner, with the explicit psql variables described in that file; then set the role password interactively. This is operational setup, not an app migration. |
| `B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION` | Dedicated bucket whose name contains a separated `uat` component, Backblaze HTTPS endpoint and region. Existing browser CORS and hidden-version lifecycle must be configured. |
| `UAT_STRIPE_ACCOUNT_ID`, `STRIPE_PRICE_PRO` | Exact sandbox account and active recurring Pro price. Existing UAT Stripe webhook subscription must deliver subscription and invoice events. |
| `UAT_RESEND_FROM` | Exact provider sender string, including display name if configured. |
| `UAT_SENTRY_URL`, `UAT_SENTRY_ORG`, `UAT_SENTRY_PROJECTS` | Sentry API origin, organization, comma-separated project slugs covering every UAT service. Services must report environment `uat` and trace/user tags. |
| `INGEST_HOST`, `INGEST_HOST_USER`, `INGEST_HOST_SSH_PORT` | Existing ingest host, explicit SSH user/port. Read-only inspection checks `/opt/capy-ingest/releases/nonprod` and actual running Docker image labels before/after. |

Required secrets: `CLERK_SECRET_KEY`, `UAT_DATABASE_URL`, `B2_KEY_ID`,
`B2_APP_KEY`, `STRIPE_SECRET_KEY`, `UAT_RESEND_READ_KEY`, `UAT_SENTRY_TOKEN`,
`INGEST_HOST_SSH_PRIVATE_KEY`, `INGEST_HOST_KNOWN_HOSTS`.

The database URL must use `capy_uat_verifier`. Remote connections require
`sslmode=verify-full`; otherwise use the optional SSH tunnel. Its variables
`UAT_DB_SSH_HOST`, `UAT_DB_SSH_USER`, `UAT_DB_SSH_PORT`,
`UAT_DB_SSH_KNOWN_HOSTS`, `UAT_DB_FORWARD_HOST`, `UAT_DB_FORWARD_PORT`,
`UAT_DB_LOCAL_PORT`, and secret `UAT_DB_SSH_PRIVATE_KEY` are all-or-none.
The tunneled URL must use `127.0.0.1:UAT_DB_LOCAL_PORT`. Obtain the SSH host key
out of band and pin it; the script never accepts an unknown host key.

B2 credentials need bucket/object reads and version listing. The verifier
has no storage-write operation. Resend delivery reads require a
**Full access** API key; a sending-only key cannot retrieve emails. UAT uses
the same authorized key for `RESEND_API_KEY` and `UAT_RESEND_READ_KEY`. Sentry
needs `org:read` for Explore and `project:read` for exact event details, scoped
to the listed projects. Stripe accepts only `sk_test_` keys and checks the
account ID before cleanup. Keep keys limited to UAT wherever the provider
supports it.

## Running and cleanup

The workflow uses one Chromium worker, no whole-test retries, a 45-minute
suite budget and a separate 10-minute cleanup step inside a 120-minute job. Office preparation has a separate 30-minute cap.
These initial budgets have not been calibrated against a full live run.
Missing configuration or failed required checks fail the gate.

Local operators need Node/pnpm, uv, the same BetterOffice Bun/Rust/WASM build
toolchain as CI, and Chromium. Export the same UAT configuration above, plus
`EXPECTED_REVISION` and a fresh lowercase `UAT_RUN_ID`. Then run:

```sh
export RUNNER_TEMP="$(mktemp -d /tmp/capy-uat.XXXXXX)"
pnpm office:prepare
scripts/uat/journey-tunnel.sh start
scripts/uat/verify-journey-releases.sh before
pnpm e2e:uat:journeys
pnpm e2e:uat:cleanup --run-id "$UAT_RUN_ID"
scripts/uat/verify-journey-releases.sh after
scripts/uat/journey-tunnel.sh stop
rmdir "$RUNNER_TEMP"
```

The local `RUNNER_TEMP` is a disposable directory for the SSH control files.
Keep this path short; macOS's default temporary path can exceed SSH's Unix
socket path limit.
Run cleanup and tunnel stop even if a preceding command fails. The manual
workflow does this automatically. Local Playwright alone does not inspect
the ingest host. Preserve `UAT_RUN_ID` across these commands.

Sanitized assertion evidence is persisted under the run directory’s `evidence/` folder.
Every creation records exact resource IDs under
`e2e/uat/journey-runs/<run-id>/manifest.json`, outside Playwright's cleared
output directory. Cleanup runs in Playwright teardown and again in an
`always()` workflow step. Download the artifact and restore that directory
to retry `pnpm e2e:uat:cleanup --run-id <run-id>` with the original revision
and UAT configuration. Existing run IDs cannot be reused for new tests.

Cleanup removes run-owned Clerk identities, expires Checkout sessions,
cancels/deletes sandbox customers and removes test clocks. Real signed Clerk
webhooks purge content. Read-only checks verify content removal, released
reservations, due deletion jobs and exact B2 versions. Recovery inventory must be saved before Clerk deletion; failed reads preserve
the accounts for a retry. Missing evidence, unreferenced live objects and
failed provider actions fail cleanup. It never
deletes by a broad prefix or directly mutates SQL/B2.

`cleanup.md` and `cleanup.json` list failures and retained resources with exact
IDs and follow-up actions. Expected retention includes:

- Late-upload deletion jobs until their recorded `not_before` deadline.
- Shared cache objects until configured unused TTL expiry; another live
  reference can retain an object. Inspect references before manual removal.
- Hidden B2 versions/delete markers under the bucket lifecycle policy.
- Parser spool and temporary native conversion files under existing host
  cleanup policies. The suite does not remove or inventory the shared host
  filesystem; use recorded job IDs for operator investigation.
- Scrubbed account tombstones and pseudonymous billing/usage/webhook/audit
  ledgers under product retention.
- Resend delivery history and copies in the controlled mailbox, Sentry events,
  and sandbox Stripe invoice/payment history.

Sentry queries use exact run trace and actor IDs, with a final delivery window.
Only the exact terminal CSV exception on its recorded failed-attempt trace is
allowed. This is bounded error-delivery verification, not a guarantee that an
event cannot arrive after the final query.

Hard cancellation, lost runners and uncertain provider responses can leave
resources. Re-run cleanup from the manifest, inspect failed actions and exact
provider IDs, and use the provider dashboards if automatic ownership recovery
cannot establish a match. Never remove the persistent authorization fixture
or another run's resources. Artifacts are retained for 30 days; save a failed
run's manifest before that window expires.

## Offline checks

```sh
pnpm test:deployment
pnpm test:uat:verifier
pnpm exec tsc --noEmit -p e2e/uat/tsconfig.json
pnpm e2e:uat:journeys --list
```

These checks contact no UAT services and do not certify a live gate run.
