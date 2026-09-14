# UAT critical-path test plan

Investigation dated 2026-09-14. Based on the working tree at `2b366ee3acfbaf0faf72666249f2ca45c5b1838f`, including the preceding E2E cleanup and current OAuth edits. The investigation below is the original plan. The initial nine-journey implementation and its explicit remaining gaps are documented in `e2e/uat/journeys/README.md`. No UAT accounts, provider resources, deployments, or database rows were changed during this investigation.

The investigation covered workflow code, account/storage/source lifecycles, the test catalog, GitHub UAT secret and variable **names**, and current provider documentation. Secret presence does not establish validity or permissions. Live Clerk settings, B2 lifecycle application, inbox routing, and service revisions still need read-only verification during setup. Google consent verification applies if live imports are added later.

Agreed follow-up: exclude live cloud imports from the initial unattended gate when OAuth requires manual interaction. Use fixture-backed provider download mocks in isolated tests. Keep Stripe in its UAT sandbox, document run remnants, and shift local E2E coverage toward upload and processing failures as redundant happy paths move to UAT. Prepare committed file sets using the [fixture guide](/Users/sam/web/capy-notebook/e2e/fixtures/files/README.md).

Three requested Astra high agents checked Office, PDF/media, and text/import behavior, then re-audited the new native Office citation and Google export implementation. The current uncommitted implementation supersedes the earlier retained-preview and Google-PDF assumptions. Their updated findings are incorporated below and in the fixture guide. No deployed compatibility run was performed.

## 1. Recommendation

Extend the existing manually invoked **Deterministic UAT quality** workflow with a separate critical-path job. Keep Playwright as the runner. Use the browser to perform interactions that matter, especially registration, direct upload, source editing, and two-user collaboration. Verify outcomes through authenticated APIs, read-only database queries, downloaded bytes, and provider records. No layout, element-count, toolbar, or section-organization assertions.

Use several independent journeys with disposable resources, rather than one test containing every application feature. Share a small run manifest, authenticated clients, and cleanup functions. The existing Playwright, Clerk SDK, Yjs, Hocuspocus, and BetterOffice runtime cover much of the required machinery.

A database record alone cannot prove that the browser displays a file correctly. A browser edit followed by a durable-state assertion proves more: the browser loaded enough of the file and editor to submit the intended edit. Pure view-only cases can verify the authorized download and its contents, but will deliberately leave visual rendering unasserted.

## 2. How the workflow currently works

| Entry point | Current behavior |
| --- | --- |
| Normal CI | Local functional E2E and mocked editor tests; no remote UAT journeys. |
| Deploy UAT | Manual. Deploys the selected main-branch SHA, then calls the quality workflow with its default lightweight smoke checks. |
| Deterministic UAT quality | Manual dispatch defaults `browser_suite` to true. A reusable call defaults it to false. The authenticated job uses fixed seeded users, one Chromium worker, a 60-second test timeout, and one whole-test retry in CI. |
| Promote revision to production | Manual. Validates the SHA, restages it on UAT, reruns quality with `browser_suite: true`, runs editor performance checks, and deploys production only after both gates pass. It does not simply consume an earlier green manual run. |
| Deploy ingest | Separate manual workflow. It is not called by the app deployment or promotion workflow. |

Sources: [quality workflow](/Users/sam/web/capy-notebook/.github/workflows/uat-quality.yml), [promotion](/Users/sam/web/capy-notebook/.github/workflows/promote-production.yml), [UAT deployment](/Users/sam/web/capy-notebook/.github/workflows/deploy-uat.yml), [ingest deployment](/Users/sam/web/capy-notebook/.github/workflows/deploy-ingest.yml).

Proposed changes:

1. Add a `critical_paths` input. Default it on for manual quality dispatch, off for lightweight reusable deployment checks, and explicitly on in promotion.
2. Add `e2e/uat/journeys/` and a separate `playwright.journeys.config.ts`, invoked by `pnpm e2e:uat:journeys`. Exclude that directory from the existing lightweight UAT config. The root local E2E config already excludes `e2e/uat/`.
3. Use one worker and zero whole-journey retries. Give stages bounded polling deadlines for eventual state, and report the last observed job/provider state when a deadline expires. Polling an asynchronous result is different from repeating an upload or payment.
4. Run cleanup in `finally` and an `if: always()` workflow step, with a separate cleanup status that must pass. Upload sanitized evidence even when a test or cleanup fails.
5. Missing credentials, an unavailable required provider, or mismatched releases must produce an explicit failed prerequisite, not a skipped required test that leaves promotion green. Live OAuth/import checks are explicitly outside the initial gate. Report that exclusion separately from required tests that cannot run.

Start with a 60-minute job budget as a proposal, then calibrate from actual runs. There are no runtime or cost measurements yet. A complete format/provider matrix may need a larger budget; do not inherit the current 60-second per-test timeout.

### Release consistency needs strengthening

`verify-release.sh` checks the SPA and gateway SHA, but only collaboration health. It does not verify the deployed Office runtime or ingest/parser release. A green upload can otherwise exercise a worker from an older release.

Before and after a heavy run, record and verify the SPA, gateway, collaboration, Office assets/WASM, retrieval, ingest/import workers, parser image, and migrations. Use deployment image digests and the pinned BetterOffice commit where services do not expose revision metadata. `ingest_job_attempts.release_sha`, environment, host, and worker identity already provide execution evidence for claimed jobs.

The current candidate introduces processing-plan v2 with `office`, parser bundle v4, Office iframe protocol v4, and migration 0016. The verifier must use that schema and those contracts; mixed old/new workers or iframe assets are not a valid test of this release. Preview columns no longer exist, so remove them from verifier queries rather than expecting null values.

Keep the existing separate ingest deployment policy initially: stage the app candidate, deploy UAT ingest for that same candidate, then run full quality. Promotion restages that app candidate and must refuse if the ingest deployment no longer matches. Making ingest deployment reusable inside promotion would be a separate workflow change to agree upon.

Manual quality currently has a different concurrency group from app/ingest deployment. It can race a deployment. Serialize top-level UAT mutation workflows through one shared lock, while avoiding a parent and its reusable child waiting on the same concurrency group. End-of-run revision verification is still required.

Sources: [release verification](/Users/sam/web/capy-notebook/scripts/deploy/verify-release.sh), [worker claim evidence](/Users/sam/web/capy-notebook/pipeline/pipeline/ingest/worker.py:184), [attempt schema](/Users/sam/web/capy-notebook/server/migrations/0001_init.sql:1095).

## 3. First complete journey

Use two disposable accounts and small DOCX fixtures containing unique run markers. Add a third unrelated actor for denial checks. Do not delete or mutate the existing `ws_uat_authorization_v1` fixture or its four persistent users.

| Stage | Action | Authoritative assertions |
| --- | --- | --- |
| Register | Use the actual sign-up form and verification flow. | Clerk user and verified email exist; `user.created` was processed in `webhook_events`; the local user and starter workspace exist exactly once. Verify the webhook independently because request-time profile synchronization can also create the local user. |
| Onboard | Submit name/onboarding choices through the app. | `users` contains the chosen profile; Clerk onboarding metadata is updated. A repeated login does not overwrite the user-owned name or recreate a deleted starter workspace. |
| Upload | Use the deployed browser's reserve → B2 PUT → complete flow. | Correct `upload_sessions` state; source bytes/hash and size match B2; one file exists; reservation is released; storage is charged to the workspace owner. Browser upload exercises deployed B2 CORS, which a Node-only PUT would bypass. |
| Parse and ingest | Wait for the actual jobs created by that upload. | `jobs` and `ingest_job_attempts` reach success on the expected release; `files.indexed` is true; the file maps to ready `rag_contents`; chunks, matching-model vectors and summaries exist; native source bytes and parsed facts match the fixture. Validate the v4 Office bundle's identity and page-text/heading evidence, with no PDF member. Durable B2 bundle caching is optional; the validated local handoff is required. Verify usage and reservation settlement. |
| Open and edit | Open the DOCX and change a known sentence through the editor. | `source_documents.checkpoint` advances; decode the saved native state or export it through the pinned BetterOffice runtime and verify the edit. Downloaded published source may still be old before processing, which is expected. |
| Collaborate | Invite account B, accept, open two authenticated browser contexts, and make independent edits. | Membership and invitation records are correct; the durable merged checkpoint contains both edits. Reopen a fresh client and make a further edit to prove the merged state survives restoration. A viewer/stranger must not obtain a writable source token or mutate state. |
| Reprocess | Invoke `/api/files/{id}/process-changes` through the normal app/API action. | Candidate/job identifies the intended checkpoint; old publication remains readable while processing; published source hash/revision and index advance; both edits appear in downloaded source and indexed content. Verify candidate cleanup and residual pending edits according to the captured checkpoint. |
| Retrieve | Ask a controlled question about a fixture fact changed by the edits. | Source-scoped retrieval contains the changed evidence and no superseded value for that fact; citations identify the correct file and retain valid snippets/parser regions. Join file/index/publication evidence separately; citation payloads do not store a source checkpoint. Assert facts and identity, not an exact model sentence or chunk count. |
| Trash and restore | Delete the file, verify trash, restore once, then trash again. | Active access/search is denied while trashed; the row and referenced bytes still exist; storage remains charged; restoration returns the same content and permitted access. |
| Permanently delete | Use the owner's trash purge API with its episode/request identity. | Active file, source state, annotations and aliases disappear; unique unreferenced index content is removed; shared content remains if another file still references it; blob deletion is queued and later makes eligible keys inaccessible. |
| Delete account | Run deletion preflight and confirm the actual email and lifecycle generation. | `deletion_pending`, approximately 30-day `purge_after`, revoked Clerk sessions, closed collaboration access, cancelled work, hidden owned resources, and the deletion email's provider receipt. |
| Cleanup account | After verifying the normal deletion state, delete the disposable Clerk identity through Clerk BAPI. | Real signed `user.deleted` webhook is processed; immediate account purge produces a scrubbed tombstone, removes owned product data, and clears identity cleanup work. Record allowed ledger/cache/history retention separately. |

Use DOCX for the first parse/edit/reparse path. Text files skip document parsing, and PDFs support private annotations rather than shared source editing. Neither can replace the full Office journey.

A run-specific marker also prevents exact-source donor reuse from accidentally skipping parsing. Add a separate duplicate-upload case that deliberately verifies reuse and shared-reference retention.

Manual Office processing bypasses the existing automatic threshold. Automatic Office refresh needs at least 5,000 estimated net-change tokens and 60 seconds idle after a successful prior parse. Text auto-refresh requires enabled auto-reindex, saved pending effects, an eligible state and 15 seconds since the last requested refresh; that is not a typing-idle debounce. Manual processing is owner-only. Test those automatic paths separately with real thresholds, rather than lowering UAT-wide settings. Observe checkpoints, not sleeps alone.

Sources: [source endpoints](/Users/sam/web/capy-notebook/server/internal/httpapi/huma_source_documents.go:74), [source lifecycle](/Users/sam/web/capy-notebook/openwiki/frontend/office-files.md:207), [retrieval and refresh](/Users/sam/web/capy-notebook/openwiki/agentic-retrieval.md:1311), [trash API](/Users/sam/web/capy-notebook/server/internal/httpapi/huma_trash.go:45).

### Native citations and model page captures

Ordinary Office citation clicks open the current native saved file. They do not download or regenerate an Office PDF. The runtime matches the complete unique quote and uses current BetterOffice paragraph, text-box or cell geometry. Parser boxes remain historical extraction evidence, not coordinates to transform into the native viewer.

| Layer | Test and expected evidence |
| --- | --- |
| UAT file/citation journey | Persist real retrieved citations, click one to open the source, and exercise a known supported edit with a saved-content assertion. Verify file identity, actual source/session bytes and unchanged publication before processing. Do not claim database state proves painted highlights. |
| Native matching correctness | Feed current saved/exported bytes into the pinned native viewer engines and production matching functions. Use the actual persisted citation snippet for integration cases. Assert the known target and finite in-document geometry, or deliberate abstention for short, repeated, cross-group, changed or unsafe evidence. No DOM counts, pixel snapshots, fixed rectangles or equality with LibreOffice page geometry. |
| Explicit `capture_page` tool | Capture the current published Office source using its exact hash and size. The authenticated parser route converts temporarily and returns a bounded JPEG, without ODL parsing, a new parse receipt or retained PDF. Check authorization, page/crop bounds, source mismatch, timeout and temporary cleanup. Native PDF capture remains separate. |

The native matcher requires 12–4000 normalized characters, while final citation snippets are currently limited to the first 400 characters. DOCX matches within a paragraph group, PPTX within a text box, and XLSX within one displayed cell. A numeric cell or a reconstructed multi-cell passage is not a reliable positive fixture. Validate at least one simple actual snippet per format before making it a required positive case. Duplicate text on different slides remains ambiguous even with a parser page hint.

After edits, an unchanged historical quote can resolve in its new current location; a removed or duplicated quote should abstain. Historical snippets and parser regions stay unchanged. Pending saved edits can already affect native matching, while `capture_page` still uses the last published source. Neither path guarantees that old coordinates remain accurate after source or converter/font changes.

Use focused native runtime tests for matching. The existing `verify_native_viewers.ts` benchmark checks DOM overlays and canvas pixels; do not copy those assertions into this UAT gate or add persisted highlight records solely for tests. Sources: [matching](/Users/sam/web/capy-notebook/src/office-runtime/citations.ts), [spreadsheet matching](/Users/sam/web/capy-notebook/src/office-runtime/xlsxCitation.ts), [Office capture](/Users/sam/web/capy-notebook/pipeline/pipeline/retrieval/capture.py:118), [bundle validation](/Users/sam/web/capy-notebook/pipeline/pipeline/parse/parser_client.py:538).

## 4. Credentials, access, and provider setup

### Database and runner

Run Chromium on the GitHub-hosted runner, not the small UAT VM. The current quality workflow has no database connection setup. Add a dedicated UAT SSH tunnel or equivalent private connection and a read-only verifier role with explicitly selected tables/columns. Keep Postgres private and pin the SSH host key. The existing local seed script proves the SSH-to-UAT pattern, but its root/database-owner privileges should not become the ordinary assertion client.

The existing Ops database role deliberately cannot read file names/blob paths, document contents, job payloads, or email recipients. It cannot supply all these assertions. Add a separate verifier role instead of widening Ops access. A narrowly scoped maintenance credential may also be needed for cache cleanup; keep it separate from the read-only client.

GitHub UAT already has the Clerk, B2, Stripe, Resend, ingest SSH, and Sentry secret names. The quality job currently only injects Clerk credentials. Add verifier credentials and their `quality` entries in `deploy/env-manifest.json`, then sync through the existing environment workflow. Do not expose the entire deployment secret collection to a test process.

Sources: [seed](/Users/sam/web/capy-notebook/scripts/uat/seed.py), [Ops grants](/Users/sam/web/capy-notebook/deploy/ops-roles.sql:10), [environment manifest](/Users/sam/web/capy-notebook/deploy/env-manifest.json).

### Clerk registration and email verification

UAT uses the Production instance of its own Clerk application. Its live-format key is expected and must be validated against the UAT instance/domain, not rejected merely for being `sk_live`.

The existing `support.ts` mints sign-in tickets for precreated accounts. That is useful for secondary actors but does not test registration, verification, password handling, or OAuth. Existing `+clerk_test` users were created through BAPI with verified addresses; their existence does not prove production-instance test mode is enabled.

Recommended: use a dedicated receiving domain/inbox with a read API and unique addresses per run. Read the actual Clerk verification code and submit it through the app. Verify Clerk and Capy independently. Clerk sends these authentication emails; Capy's Resend outbox is not evidence for them.

Alternative: enable Clerk test mode only on this isolated UAT instance and use `+clerk_test` addresses with code `424242`. That is a deliberate reduction in authentication-email coverage. Clerk supports production testing tokens for bot protection, but documents limitations for code-based production test helpers. Do not assume a testing token alone enables fixed OTPs. [Clerk test emails](https://clerk.com/docs/guides/development/testing/test-emails-and-phones), [testing tokens and limitations](https://clerk.com/docs/guides/development/testing/overview).

An inbound Resend domain could supply the inbox API, but it requires receiving/MX configuration and should be distinct from the SPA/sending domain. The current sending-domain setup does not establish an inbox. [Resend receiving](https://resend.com/docs/knowledge-base/forward-emails-with-resend-inbound).

### Google Drive and Microsoft OneDrive

The initial unattended gate excludes live OAuth and cloud imports. Local integration tests can return committed bytes through the existing Go `providerHTTP` fake transport and Python `pinned_http.open_download` fake stream. These cover gateway analysis downloads and worker transfers respectively. Browser route interception alone cannot replace either fetch. Do not add a UAT-wide provider mock switch or describe mocked downloads as verified live OAuth. Existing Google/Microsoft folder, OAuth, import-content and replay tests provide the starting points. Tests that also fake blob writes do not prove real B2 persistence, reservations or downstream ingestion.

Google Docs export DOCX, Sheets export XLSX, and Slides export PPTX. Drawings still exports PDF. Pair genuine native fixture bytes with fake provider name/MIME metadata and verify the resulting canonical suffix, kind, content type and export URL. Native size starts unknown; inspection/reservation use an estimate and completion settles actual bytes. Imported native Office copies use the same editing/collaboration/refresh/citation checks as direct uploads, without synchronizing edits back to Google. Existing binary Office and normal OneDrive imports retain their format.

Google acquire now rejects a changed export MIME relative to the reservation. Test a reserved Doc/DOCX becoming Sheet/XLSX before acquire, with no completed object that could trigger resume-complete. Require `410 provider_file_unavailable`, no download grant, and the corresponding failure/cleanup state. This equality guard currently applies to Google, not OneDrive. Also cover analysis overflow, transfer overflow, native suffix handling and actual-byte quota settlement. Browser analysis intentionally responds with `application/octet-stream`; canonical MIME checks belong to inspection/acquire metadata and B2 HEAD, not those browser response headers. Use small case tables beside the fixtures rather than a new export-wrapper format. See [native Google mapping](/Users/sam/web/capy-notebook/server/internal/integrations/oauth.go:466), [acquire guard](/Users/sam/web/capy-notebook/server/internal/httpapi/internal_import.go:223), and [worker download tests](/Users/sam/web/capy-notebook/pipeline/tests/test_import_stage.py:32).

The following setup is for later live coverage. Keep persistent, dedicated provider accounts and a small immutable cloud fixture library. Use new Capy workspaces/files per run; cleanup removes the imported copies, not the cloud originals. Disposable email signup accounts cannot impersonate Google test users.

Google setup must include the test accounts in the OAuth audience, custom Clerk Google credentials, Drive and Picker APIs, the correct UAT callbacks, and matching Google project ownership for OAuth client, Picker API key and numeric app ID. The app now requests `drive.readonly`/`drive` at import time; identity-only login does not prove import permission.

Google Testing allows up to 100 listed users and its non-identity authorizations and refresh tokens expire after seven days. Retaining a browser profile or Clerk user does not remove that limit. Check consent before dispatch; support a supervised renewal step when needed. Production publishing and restricted-scope verification are separate decisions, not automatic prerequisites for UAT. [Google audience rules](https://support.google.com/cloud/answer/15549945?hl=en).

OneDrive has two distinct authentication paths: Clerk's Graph download grant and the MSAL SPA picker grant. Verify both apps, supported account type, tenant/admin consent, `Files.Read`, SharePoint `MyFiles.Read`, and `{UAT origin}/msal-redirect.html`. MSAL SPA refresh tokens normally last 24 hours; a permanently saved browser state is not an unattended-auth guarantee. [Microsoft refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).

If live coverage is added later, separate tests for provider login/consent, Picker selection, and already-authorized import. Calling Capy's import API with known cloud IDs exercises real token retrieval, download, B2 storage and ingestion, but does not test the Picker. Any supervised OAuth/Picker check is optional follow-up coverage, not a prerequisite of the initial automated gate.

Repository setup: [provider integration runbook](/Users/sam/web/capy-notebook/openwiki/deployment-runbook.md:1293).

### Stripe

Use the existing `Stable Studio UAT` sandbox and verify its account identity and test mode before any mutation. A `sk_test` prefix alone does not distinguish it from the separate local sandbox.

Automate Capy's Checkout session creation and verify customer/session metadata, price, mode, return URLs and local reservation. Stripe explicitly documents anti-automation protections on hosted Checkout/Payment Element. Automate real sandbox subscriptions and billing webhooks through supported APIs; report hosted-checkout completion as unverified unless a separate supervised check is performed. Sandbox billing does not require putting a manual payment step in the automated gate. This is partial Checkout coverage, not an equivalent replacement. [Stripe automated testing](https://docs.stripe.com/automated-testing).

For renewal, upgrade, failure, cancellation and webhook convergence, create a separate test-clock customer/subscription and associate it through the application's existing user metadata/webhook path. Existing app-created customers cannot simply be retrofitted into a simulation. Query provider objects by exact customer/subscription IDs. Delete the test clock after assertions to clean up its simulated customers/subscriptions. Test-clock time does not advance PostgreSQL time, the app's quota grace window or account deletion deadline. [Stripe test clocks](https://docs.stripe.com/billing/testing/test-clocks), [advanced usage](https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage).

Assert subscription/plan projection, webhook receipts, reservation completion, deletion blockers, and compensation state. App account purge intentionally retains the Stripe customer mapping for invoice history; it does not prove the Stripe customer was deleted. Sandbox cleanup must cancel/expire its own resources and handle its customer separately after recording application behavior.

### Resend

Keep the existing UAT sending domain and domain-scoped sending key. Provider record reads need a different credential: documented Sending access only sends, while Full access permits reads and broader operations. A dedicated UAT Resend team or a small protected verifier holding that credential would limit exposure if the account also carries production data. [Resend key permissions](https://resend.com/docs/dashboard/api-keys/introduction).

Join `email_outbox.provider_message_id` to `GET /emails/{id}` and check recipient, sender, purpose/content and delivery result. `email_outbox.status='sent'` means the provider accepted the message, not that it reached an inbox. The provider response exposes `last_event`. Capture these IDs before account purge deletes the local outbox. [Retrieve email](https://resend.com/docs/api-reference/emails/retrieve-email).

Resend's labeled `delivered+run-id@resend.dev`, `bounced+run-id@resend.dev`, and `complained+run-id@resend.dev` addresses can simulate mail outcomes without damaging real inboxes. They are not inboxes for reading Clerk OTPs. The app currently has no Resend webhook consumer, so observing a bounce at Resend cannot prove an application bounce handler exists. [Resend test addresses](https://resend.com/docs/dashboard/emails/send-test-emails).

### Sentry

Provision an event-read token for the EU organization and relevant projects. The existing build-upload token's name does not establish `event:read`. Filter by `environment=uat`, service/release, the disposable actors, and the run's request/job traces. Background ingest mints its own trace; collect it from `ingest_job_attempts` instead of looking only for the upload request's trace.

Fail on unexpected correlated error events after a bounded ingestion allowance. Zero events alone cannot prove Sentry works. Include a small deterministic terminal-failure case that exercises the app's own capture path, and require its expected event; the ingest worker already captures terminal failures. Validate the chosen fixture first without changing shared service credentials or disrupting the parser. Expected 4xx and client aborts are intentionally quiet.

Keep synthetic events and failure evidence for their retention period. These projects are shared with production, and Sentry events cannot be individually deleted through the issue mutation API. Deleting a grouped issue to tidy a UAT test can delete unrelated evidence. [Sentry permissions and event retention behavior](https://docs.sentry.io/api/permissions/).

## 5. Cleanup means matching the lifecycle, not an empty provider account

The user accepts documented remnants. Prefer the product's normal cleanup and retention policies over adding maintenance solely to erase historical test evidence. Each run must produce a sanitized cleanup report listing exact resource IDs/keys, why each remains, its expected expiry, and whether an operator needs to act. For manual work, include a narrowly scoped cleanup command or runbook step. Distinguish expected retention, deferred cleanup with a deadline, and failed cleanup. Expected retention does not fail the gate; a failed required cleanup action does.

Cleanup must be independent of the account's session because requesting deletion revokes it. Record the run ID, GitHub attempt, actor IDs, workspace/file IDs, source hashes, B2 keys, job IDs, Stripe IDs and mail IDs as resources are created. Attach the run identity to disposable Clerk private metadata where possible. Keep an exact unique email as recovery identity for signup failures before metadata is written.

Never let cleanup write the expected state before an assertion. In particular, do not insert an index, alter an entitlement, or delete B2 objects to make the product-cleanup check pass.

There are several distinct retention cases:

| Resource | Expected behavior and cleanup implication |
| --- | --- |
| Trashed file | Retained and billed for 30 days. Use the owner-only permanent purge action to test immediate destruction. |
| Account deletion | Verify the normal 30-day deadline first. Deleting the disposable Clerk identity then invokes the existing immediate-purge webhook path. This covers external identity deletion and shared purge machinery, not natural passage of the 30-day deadline. Keep focused time-boundary tests for that rule. |
| User tombstone and ledgers | `PurgeUser` deliberately keeps a scrubbed local user ID and some pseudonymous billing/usage/audit records. Assert permitted retention and removed PII; do not require zero matching rows everywhere. |
| Shared B2/index content | Clones, other files and cache rows may still reference it. Assert remaining references are valid and the last-reference deletion works in a unique-content case. |
| Parser/derived-text caches | `artifact_cache` owns reusable artifacts with a default 90-day inactivity TTL. Account purge does not empty this platform cache. Office parse bundles retain structured evidence, not PDF copies. Migration 0016 removes `office_preview` and the preview columns; exclude those obsolete resources from cleanup. A bounded maintenance step may evict only this run's unique cache identities after proving no other live references. That is separate test cleanup, not evidence of product deletion. |
| B2 versions | `Delete`/`DeleteObjects` currently omit version IDs. B2 adds a delete marker; version data remains. The checked-in lifecycle rules delete hidden versions after a day, not synchronously. Verify logical inaccessibility first, then separately list versions and delete only this run's eligible unreferenced versions if immediate physical cleanup is required. |
| Expired or interrupted PUT | Upload/candidate paths may have a presign grace delay. Do not purge a writable key early and report it clean; a late PUT can recreate it. Track deferred cleanup until deadlines expire or verify cleanup in a later run. |
| Local parser spool | Successful/terminal jobs remove their job source; fingerprint bundles and interrupted spools have their own TTLs. Office conversion/capture uses temporary directories; verify their cleanup in isolated tests and report any attributable remnants. Never empty the shared nonproduction volume. |
| Provider history | Resend sent messages, Sentry events and some billing history are retained evidence. Cleaning active resources does not imply erasing every historical provider record. |

B2 behavior is confirmed by [Delete Object documentation](https://www.backblaze.com/apidocs/s3-delete-object), [current adapter](/Users/sam/web/capy-notebook/server/internal/blob/s3.go:201), and [UAT lifecycle rules](/Users/sam/web/capy-notebook/deploy/b2-lifecycle.uat.json). The runbook's suggestion to leave versioning off must not be used as proof that B2 physically deletes an unversioned DELETE request.

Sources for account cleanup: [webhook](/Users/sam/web/capy-notebook/server/internal/httpapi/webhooks.go:235), [purge worker](/Users/sam/web/capy-notebook/server/cmd/api/account_workers.go), [purge and tombstones](/Users/sam/web/capy-notebook/server/internal/store/account_purge.go:132).

`finally` and `always()` cannot guarantee execution after runner loss. Persist enough resource identity before destructive stages and provide a manual cleanup command keyed by a run ID. Detect abandoned manifests and report unresolved active resources separately from documented retention. Confirm a prior run is inactive before touching its resources. Report cleanup failures separately and fail the gate; do not broadly sweep users by an email substring or empty the UAT bucket.

## 6. Coverage expansion across the application

| Journey family | Cases beyond the first document journey |
| --- | --- |
| Account/auth | Email sign-up, login/logout, password reset, profile/avatar, onboarding, active-session revocation, identity-webhook replay, deletion blockers and cancellation where supported. |
| Upload/processing | Native/scanned PDF, DOCX/XLSX/PPTX, text/Markdown/JSON, CSV/TSV, image, short audio and store-only file; invalid/truncated input, limits, abandoned upload, duplicate finalize and exact-source reuse. Keep fixtures small and test distinct processing routes. |
| Editable sources | Each native Office runtime, raw text, concurrent edits, fresh reopen/export, manual refresh, automatic thresholds, edits during publication, disconnect/draft recovery and stale-epoch refusal. PDF annotations require their own private-per-actor case. |
| Collaboration/access | Invitations, owner/editor/viewer/stranger, member versus link grants, role revocation while connected, private/public reads, clone ownership/reference retention and workspace transfer. Source rooms and Plate material rooms are different protocols. |
| Study materials | Create/generate/edit notes, quizzes, flashcards, mindmaps and diagrams; persistence/revisions; quiz attempts/mistakes/grading and flashcard review state; clone/share/trash. Exact generated prose is not an oracle. |
| Chat/retrieval | Persisted conversations, citations, changed-source evidence, multiple sources, denied sources, tool mutations and Undo receipts, cancellation, credit settlement and error codes. Keep open-ended model quality evaluation in `bench/rag`. |
| Personal organization | Tasks, calendar events, labels/tags, canvas persistence, search, notification records/read state/preferences, and stream reconnection. |
| Billing/quotas | Checkout reservation and portal creation; sandbox subscription lifecycle, duplicate/out-of-order real provider events, failed payment, quota transitions, recovery, refunds and compensation. Race and exhaustive failure matrices remain in fast tests. |
| Operations | Cloudflare Access and Clerk/operator gates, authorized reads, denied privilege elevation, and explicitly scoped maintenance. This needs separate operator fixtures and must not become unrestricted production-like fault injection. |
| Cleanup/error paths | Deletion during processing, late callbacks, shared blobs, expired sessions, partially registered accounts, terminal ingest reporting and cleanup after an interrupted test. |

Run sequentially. Production, local development and UAT use the same physical ingest host. Local and UAT additionally share one nonproduction parser and capacity locks that admit only one parse and one ingest job at a time. This suite is not a load test; use the existing benchmark families for capacity/performance work.

### Committed fixture sets

Store file inputs under `e2e/fixtures/files/`, shared by local tests and UAT. Start with `basic/`, then add `rich-content/`, `unicode/`, and `invalid/` sets as files are prepared. Each set's README lists input facts, browser actions, and expected persisted results. The [fixture guide](/Users/sam/web/capy-notebook/e2e/fixtures/files/README.md) describes the format matrix and examples. It is preparation guidance; no fixture discovery or runner is implemented yet.

Use temporary copies during a run and retain exports and evidence as workflow artifacts. Keep known semantic facts and preservation requirements beside the inputs. Use a format-aware run marker to force new source bytes when the test must exercise fresh parsing; a filename change does not bypass donor reuse. Every supported editable format gets a real browser edit plus checkpoint/export checks. PDF annotations, image captions, audio transcripts and store-only files have different expected actions.

The format review adds these constraints:

- DOCX/XLSX/PPTX use temporary LibreOffice conversion for extraction and keep a PDF-free v4 structured bundle. Check formula expressions, hidden content, links and media preservation in native exports separately. Native citation matching uses the current quote target and renderer geometry. Current XLSX browser controls support cell edits and sheet switching; engine-only restructuring tests stay in the fork. Reuse its existing `exportOffice`/`inspectOffice` helpers and selected package-part checks.
- Include modern Office with parsing disabled, which remains editable, and one captured-checkpoint publication race that keeps newer saved edits and residual pending effects. Publishing C must not discard C+1 or force their checkpoint numbers equal.
- Successful text edits require valid UTF-8. Ingest replaces invalid bytes, while collaboration rejects them. JSON and code ingest as raw text; CSV/TSV normalize field/value evidence without evaluating formulas. Verify raw byte preservation separately from normalized index contents.
- Accepted media extensions do not establish every deployed decoder/provider/browser combination works. SVG and HEIC/HEIF especially need live validation. MP4/WebM/MPEG enter audio transcription; they provide no visual video evidence. Test real encoded samples, not renamed files. PDF annotations are private to each reader, including viewers, and leave the source/index unchanged.
- Material editor assets are a separate path with different allowlists and size limits. Inserting one does not exercise workspace source ingestion.
- Fresh source bytes can still produce identical canonical text and reuse an index. Change a semantic fact as well when proving fresh embedding/index work. Preserve scan/frame/stream properties when adding media/PDF uniqueness.
- Some caption/transcript cache writes are optional. Local cache-failure tests may still succeed in publishing indexed content; do not equate a missing optional cache with ingest failure. Failed processing normally retains the failed uploaded source until product deletion.

The [fixture guide](/Users/sam/web/capy-notebook/e2e/fixtures/files/README.md) contains the concrete codec matrix and expected edit/preservation cases. New failure recipes below are source-supported candidates that still need local execution before being required in UAT.

### Local failure coverage

The current [local compose stack](/Users/sam/web/capy-notebook/deploy/docker-compose.e2e.yml) starts Postgres, Redis, the API and collaboration. It has no ingest worker, and its memory blob adapter returns unusable `memory-put://` URLs. Real direct upload and worker-failure integration tests therefore need an isolated HTTP object-store substitute and worker/upstream setup; they cannot be enabled merely by adding a Playwright fixture. Start with the existing Go upload tests and Python worker-failure tests, adding only missing assertions. Add a browser-through-worker case when its cross-service behavior is not already covered, without pointing local E2E at the shared ingest host.

Prioritize these cases while the UAT journeys take over duplicated happy paths:

| Failure | What the test must establish |
| --- | --- |
| Reserve or B2 PUT fails | Correct failed response, no completed file or ingest job, and reservation/candidate cleanup according to the upload lifecycle. |
| Complete response is lost or repeated | An explicit user retry does not duplicate files, jobs, or storage charges. |
| Browser analysis rejects invalid input | No upload is submitted and no backend resource is created. This covers preflight rejection, not worker failure. |
| Parser rejects an accepted fixture | Terminal job state, settled credits/reservations, no published partial index, and permitted cleanup of the source/artifacts. |
| Office bundle is corrupt or lacks evidence | Reject wrong hash/version, any PDF member, missing page text or invalid heading evidence before publication. Preserve prior publication and saved edits. Optional durable cache upload failure is a distinct success-compatible case. |
| On-demand Office capture fails | Reject wrong source size/hash, invalid page/crop or bad JPEG; bound timeout and clean temporary files. No new parse job/receipt or source/index mutation. |
| CSV exceeds the real cell estimate | A small file with 100,000 commas can exercise terminal direct-ingest failure before model calls. It is not a document-parser failure. |
| Text editor receives invalid UTF-8 | Verify editor bootstrap refusal and preserved source; initial ingestion may succeed with replacement characters. Malformed JSON is not a reliable failure input. |
| Audio probe rejects malformed WAV | Validate upload admission followed by terminal ffprobe failure before transcription. Candidate for the real UAT/Sentry probe. |
| Ingest dependency fails | Run the real worker against a controlled failing upstream in a disposable test stack; check retryable versus terminal handling and final cleanup. |
| Refresh fails after edits | The previous publication/index remains usable and saved edits remain available for an explicit retry. |
| Delete or revoke access during processing | Late callbacks cannot publish deleted or unauthorized content; run-owned resources are accounted for and cleaned. |
| Google/OneDrive fetch fails | Fixture-backed upstream tests cover expired grants, missing files, interrupted streams and import replay without interactive consent. Google rate-limit-reason 403 retries; ordinary authorization 401/403 fails terminally. |

Use browser request interception to test client request/recovery behavior. A fabricated `failed` job response proves only the client's handling; it does not establish that the worker records failures or releases reservations. Use controlled server-side upstreams for that evidence. Never stop the shared UAT parser, alter its credentials, or break production dependencies to simulate failures. UAT can retain a small validated terminal-failure fixture to verify real job persistence and Sentry delivery.

Keep assertions on responses, database state, bytes and provider evidence. If a specific error message itself needs coverage, that is a separate UI contract requiring an explicit choice; it cannot be proved by a database query.

## 7. What existing E2E tests could be removed

Current post-cleanup inventory is 39 real-stack local tests, 11 mocked editor tests, and 10 UAT tests, plus separate editor performance cases.

The user approved removing the discussed redundant cases and prioritizing local failure tests. Apply the deletions with their replacement coverage, rather than waiting for a second approval. Require a replacement to exercise the same actor, denial boundary, transport and persisted effect. Database assertions alone do not prove authorization: attempt the prohibited operation and verify both refusal and unchanged state.

| Existing tests | Recommendation after equivalent UAT coverage exists |
| --- | --- |
| `workspace-membership.spec.ts` | First strong retirement candidate when UAT covers actual invite/accept, notification/Resend linkage, wrong-recipient denial and roster privacy. |
| `live-collaboration.spec.ts` | Replace only after the new suite includes Plate material collaboration and durable/static projection. Office source collaboration alone does not replace it. Remote-selection visualization is separate coverage that would intentionally be dropped. |
| Quiz blank creation and clone success paths | Candidates once UAT performs standalone creation and checks the same initial question/content, ownership and privacy. Generating a workspace material is not the same route. |
| Workspace/quiz/flashcard positive sharing flows | Consolidate duplicate happy-path navigation after equivalent UAT journeys exist. Preserve negative/private/anonymous cases in focused API tests. |
| `e2e/uat/authorization.spec.ts` | Keep its short role matrix, or incorporate the same cases into a dedicated permissions journey. Most assertions already use authenticated APIs. |
| Mocked editor formatting/insertion/block tests | Keep initially. They cheaply isolate client editor behavior; backend truth after a broad journey does not establish all these commands worked. Remove only commands actually covered by a corresponding real browser action and persisted-content assertion. |
| Error-banner/accessibility tests | External records do not replace these UI contracts. Their removal would be an explicit coverage tradeoff, not deduplication. This plan does not add DOM assertions to the new journeys. |
| Performance, Go, Python, collaboration unit/integration tests | Keep. Heavy UAT is unsuitable for exhaustive races, lease expiry, grace boundaries and capacity budgets. |

Inventory source: [test catalog](/Users/sam/web/capy-notebook/openwiki/test-catalog.md:376).

## 8. Suggested implementation order and open decisions

1. Add environment/release preflight, a read-only DB connection, run identity/evidence, and independently resumable cleanup. Prove cleanup using disposable resources before adding expensive model work.
2. Implement registration plus one DOCX lifecycle, two-user collaboration, manual processing, retrieval, trash/permanent deletion and account cleanup.
3. Add text automatic refresh, remaining Office formats, native citation matching/current-state cases, explicit Office captures, denied access, duplicate-source reference retention, and an expected terminal-error/Sentry case.
4. Add other ingest routes, study tools and sandbox billing. Use fixture-backed cloud download mocks locally; live OAuth/imports remain outside the initial gate.
5. Retire the exact old cases now covered and add focused local upload/parse/ingest failure coverage. Expand remaining app domains from the coverage table.

Decisions to settle before implementation:

- Real OTP inbox versus explicit Clerk test mode. A real inbox provides the most complete registration evidence.
- Whether to add reusable ingest staging inside promotion later. The initial recommendation preserves independent ingest deployment and adds strict release verification.

No external configuration changes, test deletions or new runtime tests were made as part of this investigation.

The native-file re-audit ran existing focused checks: `pnpm exec vitest run src/office-runtime/citations.test.ts src/features/files/officeProtocol.test.ts` passed 19 tests; `pnpm test:pipeline:offline pipeline/tests/test_parser_client.py pipeline/tests/test_parser_app.py pipeline/tests/test_capture.py` passed 82 tests. These checks cover local matching/protocol/parser/capture behavior with their existing test dependencies; they are not a live UAT or Google export run.
