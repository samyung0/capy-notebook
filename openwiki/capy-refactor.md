# Capy Notebook refactor

Started 2026-09-05 from commit `6caeb00`. This file records progress and remaining
decisions for the rename, public workspace summary, and deployment configuration.
The two documents in Downloads are historical context; their proposed decisions
are not approvals.

## Agreed scope

- Rename Evo Notes to **Capy Notebook**, including the Chinese product name,
  project identifiers, and `EVO_*` configuration such as `EVO_PRIVATE_BIND_ADDRESS`.
- Add a minimal server-rendered workspace summary and require authentication for
  workspace contents that should no longer be available anonymously.
- GitHub environment variables and secrets are the deployment source of truth.
  Local env files provide a convenient upload path.
- Each manual deployment applies that GitHub configuration. App and ingest have
  separate workflow files while preserving the coordinated release sequence.
- One Cloudflare Worker serves the SPA and SSR summaries. Go supplies live
  minimal metadata on each request; no KV or R2 cache in this version.
- Summary links retain the existing `ws_...` workspace IDs so URLs and analytics
  use the same ID. Existing IDs are not UUIDs, despite the old plan's wording.
- Preserve full-local development, full UAT, and local UI with UAT services.
- Cloud imports already download and upload to B2 on the ingest VM. The removed
  relay is not part of this work.
- Use the current branch/worktree. Keep BetterOffice's upstream identity and
  historical benchmark evidence. Do not touch production or erase existing data.

## UI and company identity

The developer selected layout A, a single reading column with workspace metadata
above the chapter/file outline. Mockups: https://pyd4moxcoz68.postplan.dev.
Support uses `support@stablestudio.org`; the company is Stable Studio Limited
and the product is Capy Notebook.

## Starting inventory

- Both repository worktrees are clean at the starting point.
- UAT VM `159.195.250.206` runs Coolify 4.3.14 and its dependencies. No application
  containers or application volumes are present.
- Ingest VM `159.195.61.195` runs the existing `evo-rag-lab` stack. Its data stays
  untouched. `evo-ingest.service` is disabled; `/opt/evo-ingest` and
  `/etc/evo-ingest` exist.
- Local Docker has no containers. No application database has been reset.
- The release script predates the import worker. The new deployment flow must
  include it in prepare, activate, health verification, and rollback handling.
- Cloudflare reports R2 is not enabled on the connected account.

## Completed work

- [x] Read attached context, repository rules, and stored decisions.
- [x] Check the current VMs without printing secrets or changing services.
- [x] Rename source/configuration in both repositories and regenerate outputs.
- [x] Rename existing GitHub, Coolify, tunnel, and host resources safely.
- [x] Implement and verify the summary data and authentication boundary.
- [x] Implement selected summary UI and frontend hosting.
- [x] Implement GitHub env upload/sync and app/ingest deployment workflows.
- [x] Run formatting, focused and full unit suites, and independent reviews.
- [x] Upload UAT configuration and the approved dedicated deployment key to GitHub.

The GitHub repository is now `samyung0/capy-notebook`; the BetterOffice integration
branch is `capy-ci`, renamed from `codex/capy-integration` on 2026-09-07 at the same pinned commit. Coolify project,
application, and private-key labels and its repository URL are updated. Cloudflare
tunnels are `capy-uat` and `capy-dev-sam`. The ingest account and host are
`capy-ingest`, with `/opt/capy-ingest` and `/etc/capy-ingest`; its existing UID and
data were preserved. The UAT firewall unit has its new name with identical rules.
The nonprod parser watchdog is installed and waits for release state. No
production workload or application database was changed.

The dedicated UAT deployment key authenticates as `capy-ingest` on
`159.195.61.195`. Its private key is in the GitHub `uat` environment and ignored
mode-0600 `deploy/.env.uat`. UAT configuration renders successfully, including
encoded database URLs and separate ingest configuration. Secrets were never
printed in command output.

## Verification

- The full Go, offline Python pipeline, frontend unit, and collaboration suites
  passed. The Worker summary tests and typecheck passed.
- Deployment configuration and release-protocol tests passed, including failure
  recovery, immutable configuration snapshots, and retired-key cleanup.
- The production build and pinned Wrangler UAT dry-run passed. Desktop and mobile
  previews use invented workspace metadata; no real workspace was published.
- Generated email templates reproduce byte-for-byte. Formatting and lint checks
  passed. Python formatting used the already installed Ruff after the package
  download failed certificate validation.
- All 32 sharing checks are verified: 31 passed in the full run, then the last
  mention-directory assertion passed after updating its expected anonymous
  response from 403 to 401. Quiz and flashcard tests now cover authenticated
  shared reads and anonymous denial for every visibility. Live collaboration,
  role permissions, summaries, and cloning passed too.
- After Docker stopped during the initial image build, verification used the
  existing `E2E_SKIP_COMPOSE` mode with one disposable Postgres container, native
  Redis/Go/collaboration processes, and one Playwright worker. All temporary
  services and test storage were removed afterward, and Docker was stopped
  again. The temporary launcher is `/private/tmp/capy-e2e-low-memory.py`.

## First UAT rollout

Source changes remain uncommitted and have not been pushed. The frontend is
live as a labelled bootstrap build; backend and ingest are not deployed. Before
the first complete rollout, review and commit the changes, run CI, and use **Deploy UAT** with
`bootstrap_ingest` selected. That run applies GitHub configuration to both
Coolify and ingest. The app and ingest workflows also support later separate
manual deployments; ingest must match the running backend revision.

The Worker now owns `uat.capynotebook.com`, and its isolated Office runtime is
live at `uat-office.capynotebook.com`. Both custom domains and their assets were
verified. The detached `evo-notes-uat` Pages project remains available for
rollback. After the backend creates its application database, run the explicit
UAT seed initializer and activation checks before enabling automatic post-CI
deployments.

GitHub UAT configuration readback passed, including the dedicated SSH key,
Office origin and parent origins, and all seven fixture settings. Automatic UAT
deployment remains disabled. The five Clerk actors are ready; database fixture
creation awaits the backend.

Historical benchmark/architecture evidence retains original identifiers, as do
local checkout and SSH-key paths. GitHub's existing Coolify deploy-key title is
also unchanged because that API requires replacing the key to change its label.

## Configuration rename follow-up, 2026-09-06

Ops checks use `DEPLOYMENT_OPS_URL` directly in the selected GitHub environment
and local environment file. The manifest accepts it, the UAT example includes
it, and the duplicate repository `UAT_OPS_URL` was removed after verifying the
values matched. GitHub variables and secret names contain no `EVO_*` entries.

UAT Coolify's saved Compose definition was reloaded from its repository without
starting a deployment. The four renamed settings and sender name were aligned
with GitHub variables, and the old names and retired `EVO_QUERY_MODEL` were
removed. Future configuration sync also removes that retired query-model key.
Other credentials remain subject to the normal GitHub deployment sync.

The ignored local ingest inventory now names the existing `capy-ingest-1`
host. Local parser paths and development database credentials match the Capy
Compose setup; retired import-relay entries were removed. `VITE_DEV_HOST` is
classified as local-only. Both local environment files validate.

Deployment tests and offline ops URL authorization checks passed. UAT config
rendering passed with actual GitHub variables and local copies of its secrets;
GitHub secret values cannot be read back. No deployment, service restart,
production change, or database migration was performed. The original RAG lab,
historical evidence, backups, and existing SSH-key filenames remain preserved.


## UAT hosting and seed follow-up, 2026-09-05

- Cloudflare cutover completed and verified: `uat.capynotebook.com` routes to
  `capy-notebook-uat`; the Office hostname routes to `capy-notebook-office-uat`.
  Old Pages custom-domain binding and CNAME were removed; Pages project retained.
  UAT custom domain is declared in Wrangler; temporary workers.dev and preview
  URLs are disabled.
- Approved Office hostname: `https://uat-office.capynotebook.com`.
  The isolated Worker and CI publish step use the same build artifact as the
  SPA, with explicit UAT and `dev-sam` parent origins. Embedded DOCX blob fonts
  are allowed. Five Worker tests and TypeScript checks passed.
- GitHub UAT and the ignored environment mirror now contain the Office origin,
  explicit parent origins, five approved fixture emails and stable fixture IDs.
- All five Clerk UAT accounts were created and then verified on a second run.
  The initializer verifies the backend key's exact primary UAT domain before
  account mutation. Six offline seed checks passed.
- `scripts/uat/seed.sql` passed against one disposable pgvector Postgres 16
  container with the current numbered schema: repeat execution left every row
  and storage counter unchanged, note edits survived, and invalid identity,
  membership drift and privacy drift each failed without changing data. The
  container was removed and Docker stopped after verification.
- The UAT API still returns 404 for `/healthz`; no live application database
  was seeded. After the first backend deployment, run the explicit `uat:seed`
  command from the deployment runbook using its actual Postgres container.
- The Cloudflare bootstrap build uses release marker
  `uncommitted-uat-bootstrap-20260905`; it is built from this uncommitted
  worktree with GitHub UAT build variables. It must be replaced by the normal
  GitHub workflow after committing the refactor.


## Migration baseline support, 2026-09-05

Read the Codex task "Review database migration strategy" and implemented the
requested future baseline support before further deployments. `Bnnnn_name.sql`
can initialize an empty application database; existing databases retain their
numbered upgrade path and immutable recorded checksums. There is no duplicate
baseline yet because the repository still has only `0001_init.sql`.

The migration plan is shared by status and execution. It rejects numbering gaps,
malformed or duplicate versions, unsupported recorded baselines, and checksum
drift before applying pending files. Ledger writes remain transactional and the
advisory lock also protects first ledger creation. SQL dump session settings are
reset inside each transaction before recording the migration.

The Go CI harness now exposes its disposable container to baseline tests so the
server's own `pg_dump` can compare forward and baseline paths without another
container. Checks cover schema, required catalog data, sequence state, existing
content preservation, reruns, checksum refusal, occupied databases, installed
extensions, failed transactions and session settings. Only one container and one
Go test worker were used. No environment database or further deployment was
changed during this follow-up.

Validation completed: full Go suite passed, followed by targeted reruns of the
final baseline gate including sequence state and retained-history validation.
Formatting and whitespace checks passed. Docker was stopped after cleanup.
