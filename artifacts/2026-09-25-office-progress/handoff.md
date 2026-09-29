# Handoff, 2026-09-27

The continued investigation is in
[investigation-2026-09-27.md](investigation-2026-09-27.md), with compact observations
in [investigation-evidence-2026-09-27.json](investigation-evidence-2026-09-27.json).
It supersedes the pending verification and uncommitted-change statements in the
earlier [docx-failure.md](docx-failure.md).

## Implementation, 2026-09-27

The five fixes below are implemented. DOCX now blocks input after an unresolved
pointer placement, lets previously accepted input drain at its original caret,
exposes the accepted caret, and retains all three language
slots through seed, projection and export. PPTX uses native textarea input for
paste and IME, with composition included in its save flush. Read-only or invalid
selection transitions settle active composition with an explicit flush failure. Closed menu content
stops late key/click events before Radix handles them. Cleanup accepts an exact
recorded actor ID, email and run tag across provider clock skew, while keeping
the time guard for unrecorded registrations.

Biology 101 includes the committed rich DOCX, XLSX and PPTX fixtures through the
ordinary MSW file/session paths. Their native checkpoints are regenerated from
the fixed engine. Slide navigation tests use `pptx-next-slide`, independent of
the translated label. The browser check exercises real clipboard paste and
Chromium IME composition, then verifies the saved viewer content and reset.

Local verification includes 96 focused native editor and input-queue tests, 32 shared Office
golden/checkpoint tests plus two Rust storage tests, 432 frontend tests,
305 collaboration tests, the three Biology browser cases, four focused menu
browser cases, and the UAT verifier's six TypeScript plus three Python tests.
TypeScript, lint and Rust formatting checks pass. The full Go suite exposed an
obsolete missing-levels assertion after levels became optional; the affected
HTTP package passes after removing it, and every other Go package passed.
The previous main CI also asserted the removed legacy quiz prompt shape; its
creation check now verifies the API-created draft, editor route and Save state.
Local execution of that Docker-backed browser check was blocked by Docker Hub
image metadata timeouts before any test started. CI run
[36309921222](https://github.com/samyung0/capy-notebook/actions/runs/36309921222)
then passed the Docker-backed browser suite, backend, frontend, pipeline and pin
checks. Its editor suite passed all Office cases but found a stale workspace
settings assertion: the dialog now closes after a successful Save, as recorded
in `human/frontend/motion.md`, so the test cannot wait for its Save button to
become enabled again. `15c0dbe0` removes that obsolete expectation and retains
the close, reopen and persisted-description checks. That case and the workspace
mode/new-tab case pass locally without retries.

The same CI run recorded one flaky new-tab event wait. Its trace proves a second
page loaded `/workspaces/ws_bio?file=f_1` with HTTP 200, fetched the PDF, and left
the original material page unchanged. Playwright's context `page` event wait
did not settle. The retry passed. The underlying missed-event cause is not
established, so no speculative navigation-code change was made.

Language preservation changes the four DOCX golden seeds. Migration
`0036_docx_language_seed_reset.sql` uses the existing guarded DOCX-only reset.
Deployments with existing DOCX state require the documented maintenance window
on the old engine before applying it. No production backfill is needed.

## Investigation evidence before implementation

- Local baseline is `75512bb3`; the revised DOCX helper and failure attachments
  are already committed there. UAT app, collaboration, Office and ingest serve
  `4c960717`. BetterOffice is pinned at `04560dd6`. No deployment or product code
  changed during the continued investigation.
- The current DOCX, XLSX and PPTX rich-content UAT scenarios all pass with one
  worker and no retries. DOCX and XLSX also pass automatic export-only publication
  under the open peer editor, charge reset, reload and reopen. Rich PPTX does not
  attempt paste-driven publication.
- The original DOCX helper reproduces the exact convergence predicate failure
  through real UAT persistence. Checkpoint 2, epoch 1 contains the owner's
  `人數：24人`, but the collaborator sentence is appended to `2022 至 2023 年度`.
  The intended topic paragraph is unchanged. The update is misplaced, not lost.
- The actual pointer hook drops a click when hit-test geometry is unavailable and
  never replays it. The old/default selection can still receive typed text.
  The revised helper avoids the observed race; it does not fix that product gap.
- A no-edit native DOCX export drops all six run language tags. The fixture's
  section page-number and column properties now survive. The preservation test
  explicitly exempts language, so its pass does not clear this defect.
- PPTX accepts per-key typing, but a real clipboard paste delivered to the Office
  frame produces no saved change. Direct text insertion also produces no change.
  The slide editor has no paste/composition input bridge.
- Current CI [36305430178](https://github.com/samyung0/capy-notebook/actions/runs/36305430178)
  is red on a separate shared-menu defect. A second Enter executes a retained,
  closed/inert submenu item twice. The root-menu close test also flakes because
  its second Enter can validly reopen the restored trigger.
- The first local UAT process exited 1 after its three passing scenarios because
  cleanup compares Clerk creation time with the local clock using a five-second
  allowance. The exact run-owned actor appeared 9,049 ms older than the manifest.
  The existing helper removed the exact actors after run-tag and email checks;
  the normal cleanup verifier then returned `failed: []`.
- The later DOCX/PPTX diagnostic run also finished with `failed: []` after exact
  actor cleanup. Both run manifests record completed cleanup; ingest release
  verification stayed at `4c960717` before and after the runs.
- 57 focused collaboration/native-runtime tests, two pointer-hook checks and the
  UAT TypeScript check pass. The browser reproduction confirms that a shared
  closed-content event guard prevents duplicate selection.

## Authorized fixes, now implemented

1. Fix the DOCX pointer/selection handoff. Observe clicks during unavailable
   geometry and prevent typing at an old caret while placement is unresolved.
   A successful caret placement must be observable by the journey.
2. Preserve DOCX language through native seed, Yjs projection and OOXML writer;
   cover it with the existing preservation check.
3. Give PPTX slide text a native input bridge for paste and composition, including
   the existing save-flush contract.
4. Guard shared closed menu content before Radix synthesizes selection. Make the
   test for a late event deterministic and retain valid trigger reopening.
5. Correct UAT cleanup's cross-clock false rejection for actors already proven to
   belong to the run by exact ID, email and private run metadata.

There is no existing production data. These changes need no production backfill,
legacy fallback or compatibility migration. BetterOffice changes still follow
the `capy-ci` review/pin workflow and the existing engine-upgrade procedure for
any UAT documents deliberately retained across an engine change.

## Evidence limits and release gate

The two original failed CI DOCX exports were not retained and cannot be recovered
after cleanup. Their exact final paragraph cannot be asserted retrospectively.
The fresh UAT control reproduces and captures the failure class conclusively.

The earlier claim that rich XLSX had never run was wrong. Run
[36277362542](https://github.com/samyung0/capy-notebook/actions/runs/36277362542)
reached it, passed saved-export checks, and then failed because `H5` was outside
the virtualized viewport. The horizontal-scroll correction is already deployed.

The investigation ran the three previously problematic or blocked rich-content
scenarios, not a new complete 13-journey gate. Local implementation checks do not
substitute for that gate on a deployed revision. After green CI, use the existing
UAT maintenance, deployment and full journey workflow when release work is
requested. Rich PPTX now includes paste-driven export-only publication, and the
DOCX preservation assertion no longer exempts language tags.

## Independent Astra review and storage measurement

The independent review was explicitly dispatched with `gpt-6-astra`, `xhigh`,
and a fresh context. It found no actionable correctness, data-loss, integration
or test-validity issue in Capy `50302c8e` and BetterOffice `99d5bcc4`. Independent
checks passed: 85 native cases, 32 shared checkpoint/golden cases, six Chromium
cases, nine offline UAT verifier cases, and byte-identical fresh seeds for all
six app fixtures. [The review record](review-astra-xhigh-2026-09-27.md) also covers
the later deployed findings and storage methodology. The detailed original
report is retained at `/private/tmp/capy-office-astra-xhigh-review.md`. The child cannot independently
introspect a runtime model ID; the model statement records the accepted spawn
configuration.

Current source/editing measurements for 18 committed sample files are in
[the storage report](../../bench/parsers/reports/2026-09-27-office-storage.md).
They cover seed, saved checkpoint, compressed database values, logical quota,
export capture, later-edit rebase, quiet publication, browser drafts and
parser/index lifecycle costs. Live UAT parse/index measurements now cover all six application fixtures, with
verified cleanup and before/after release identities. Deployed gate results
are recorded below.

## Deployed monitoring findings, September 27

CI [36311852988](https://github.com/samyung0/capy-notebook/actions/runs/36311852988)
passed at `15c0dbe0`: 39 Docker browser cases and 77 editor cases, with one
intentional skip and no retries. UAT app deployment
[36312867296](https://github.com/samyung0/capy-notebook/actions/runs/36312867296)
and UAT ingest deployment
[36313798976](https://github.com/samyung0/capy-notebook/actions/runs/36313798976)
succeeded at that revision. All four public release markers matched, migration
0036 was applied, and Office editing was resumed. Production was untouched.

The separate full UAT gate `36313946437` and a six-file live storage run then
exposed three additional failure paths:

- Collaboration uses `/internal/collaboration/`, while the rate limiter only
  exempted `/api/internal/`. Every editor therefore consumed the same anonymous
  60/minute service-IP budget. Logs correlate actual access/bootstrap 429s with
  the PPTX storage case failing to save. A real Redis test reproduces all five
  sampled internal-route refusals before the prefix fix and passes afterward.
  Public rate limits and service-secret/actor/ingest checks remain enforced.
- A normal text-source trash action raced a pending Hocuspocus save. Redis had
  started acquiring the store lock, but the application store counter was still
  empty. Both unload attempts refused pending work, then a delayed store reported
  the intentional discard as a failed save. The fix waits for all native hook
  work and queued application saves, and skips stores during intentional discard.
  Drain still requires durable success. Astra reproduced the exact error ordering
  with the pinned library and also verified the queue handoff timing gap.
- Hocuspocus does not await stateless callbacks. A save failure was already
  reported and sent to the client, then leaked as an unhandled rejection. The
  checkpoint-request callback now contains that handled rejection while other
  persistence callers continue to receive failures.

The interrupted storage run `office-storage-20260927-15c0dbe0` completed all three
phases for DOCX and XLSX. Its cleanup recorded `failed: []`, and before/after
ingest identities matched. Those measurements are retained. The other four files subsequently completed
on the corrected `2f54d84a` UAT revision, with verified cleanup and release
identities. The production-code corrections received bounded Astra xhigh reviews.

The full gate finished with eleven journeys passing. Rich XLSX then failed in
the saved-export helper before its first real checkpoint; rich PPTX did not
run. An untouched store-only source legitimately has checkpoint zero, NULL
state and an empty base hash. The helper incorrectly asserted a populated hash
for that state. Its correction permits only the untouched combination and
still rejects missing or mismatched hashes after a save. The fresh Astra
closing reviewer confirmed the contract and the focused verifier cases.
The corrected rich-XLSX journey passed on unchanged UAT `15c0dbe0`; cleanup
returned `failed: []` and both ingest identity checks passed. Release-scoped
Sentry recorded no errors during that diagnostic.

The reviewed service, eviction and helper fixes are pushed to `main` in
`2f54d84a`. CI [36315657945](https://github.com/samyung0/capy-notebook/actions/runs/36315657945)
passed with 39 Docker browser and 77 editor cases, one intentional skip and no
retries. UAT app [36316927158](https://github.com/samyung0/capy-notebook/actions/runs/36316927158)
and ingest [36317341036](https://github.com/samyung0/capy-notebook/actions/runs/36317341036)
deployed that exact revision. All four public release markers matched and
editing remained enabled.

The full gate [36317423600](https://github.com/samyung0/capy-notebook/actions/runs/36317423600)
passed all nine authenticated checks and 12 of 13 lifecycle journeys. The last
PPTX case single-clicked a body shape after switching slides, then expected text
focus. The editor uses the first click to select a shape and a double click to
enter text. The helper now double-clicks the existing canvas target. Its strict
focus, charge, export and publication checks remain. The corrected focused
PPTX journey passed in 3.5 minutes on unchanged UAT `2f54d84a`. Gate cleanup recorded no failed
resources, and both ingest identity checks passed. Sentry's only error for this
release during that run matches the deliberately oversized CSV rejection by
exact trace ID.

## Pending input follow-up

The storage probe exposed a separate measurement race: a billing read completed
before the requested DOCX checkpoint began. The probe now waits for that edit's
actual exported server content before the strict accounting comparison.

Astra then independently reproduced a real save-status gap in DOCX's worker
input queue and PPTX image decoding. Accepted work had not yet emitted its Yjs
update, so the parent could show Saved and omit the close warning while Save
itself correctly waited for the native flush. Both editors now report that
pending work through the existing source-session path. Their native updates
arrive before pending clears, and the checkpoint receipt still controls Saved.
Failed DOCX input stays pending; stale completions cannot clear a new session.

Both full-app before/after reproductions, a withheld-receipt check, 42 native
tests and two additional stale-lifetime cases passed. The original Astra
reviewer verified the fixes and a fresh Astra xhigh closing pass found no
actionable issue. The BetterOffice change is reviewed and pushed to `capy-ci`
at `64bbde820878c769e7b6678ac36880c618734b79`; it changes React pending callbacks,
not native seed output or checkpoint encoding. The retained reviews and
measurement provenance are summarized in [the review record](review-astra-xhigh-2026-09-27.md).

## Deployment telemetry follow-up

Office revision `7c0caaf3` passed CI with 39 Docker browser and 77 editor
cases, one intentional skip and no retries. UAT app and ingest deployed that
revision, with all four release markers matching and editing enabled.
Post-deploy database logs exposed an older telemetry gap: the import worker
emits role `import`, but both raw-sample and minute-rollup constraints only
allowed `parse` and `ingest`. The actual database test reproduced the same
constraint failure for import while the other two roles passed.

Migration `0037_import_worker_telemetry.sql` extends both constraints. The same
real writer test then passed for all three roles, including raw rows and minute
rollups. The Ops history chart also needed a separate import series: its former
non-parse branch treated import as ingest and could overwrite that bucket. The
aggregation now keeps all three roles separate, with both input orders tested.
The 29 Ops tests, Ops typecheck and focused Go migration harness passed. A
fresh Astra xhigh review found no actionable issue. Failed historical telemetry samples
cannot be reconstructed; this gap did not affect the worker's job execution.
The final release gate follows deployment of this correction.

## Completed UAT release and browser follow-up

Runtime revision `a71058954e48b7ac825faf2af16c47a61a388c05` is deployed to
UAT: [app 36322439115](https://github.com/samyung0/capy-notebook/actions/runs/36322439115),
[ingest 36322854067](https://github.com/samyung0/capy-notebook/actions/runs/36322854067)
and [Ops 36322920031](https://github.com/samyung0/capy-notebook/actions/runs/36322920031)
all succeeded. All four public release markers match. Fresh import, parse and
ingest raw samples and minute rollups persist at this revision, confirming the
telemetry correction through the live writer.

[UAT quality 36323141116](https://github.com/samyung0/capy-notebook/actions/runs/36323141116)
passed smoke checks, all nine authenticated browser checks and all 13 lifecycle
journeys. Journey cleanup finished at 14:07:52 UTC with `failed: []`; all five
ingest container and image identities match before and after. Retained account
ledgers, cached objects, delayed upload deletions and hidden B2 versions follow
the existing retention policy. Both verifier tunnels closed after their runs.

The release-scoped Sentry scan contains only the deliberate oversized-CSV
failure, trace `580991ffc1e4ab37165d80181f86ce6c`, which matches the gate's
terminal-failure evidence and ingest logs. The app/Ops/database/collaboration
audit found no service failure; the gateway recorded one client-aborted
notification request. Containers have no restarts or OOM kills. Office editing
remains enabled with no unpublished or in-flight work after cleanup.

[CI 36322032704](https://github.com/samyung0/capy-notebook/actions/runs/36322032704)
succeeded with 39 Docker browser passes, 76 editor passes, one editor case that
passed its retry and one intentional skip. That retry repeated the modified-click
headless-shell failure. The reviewed follow-up uses full Chromium for the editor
project and uploads CI artifacts even when a retry succeeds. Its isolated
application check passed in 33.5 seconds with no retries. This follow-up changes
test infrastructure and documentation only; the deployed runtime stays at
`a7105895`. The [Astra review](review-astra-xhigh-2026-09-27.md) records the
upstream evidence and the limit on attributing the historical failure exactly.

The test-infrastructure follow-up `0fe773e5` passed
[CI 36324953303](https://github.com/samyung0/capy-notebook/actions/runs/36324953303).
The modified-click case passed on its first attempt in 42.4 seconds. The
retained artifacts exposed a different DOCX recovery timeout: every assertion
passed, but the complete open/edit/fail/retry/mode/reload/reset workflow took
60.794 seconds against a 60-second test budget. Reset's idle assertion took
1.468 seconds, within its existing five-second allowance. Its retry passed in
59.7 seconds. This is a whole-test budget failure, not a save-recovery defect.

The existing three-format recovery workflow now has a 120-second total budget;
individual operation and assertion deadlines remain unchanged. The bounded
Astra xhigh review found no actionable issue, and all three cases passed locally
with retries disabled (DOCX 40.3 seconds, XLSX 28.3 seconds, PPTX 22.3 seconds).
Formatting and lint checks passed. This correction is test-only and does not
require another UAT deployment. The post-cleanup UAT soak from 14:07:55 through
approximately 14:28 UTC recorded no application or ingest errors, warnings or
Sentry events, with healthy containers, no restarts or OOM kills, and Office
editing enabled.

## Durable parse cache removed and measurements repeated

Epo approved removing the durable B2 document parse bundles while keeping the
validated temporary parser handoff and database donors. The removal is committed
in `1e50b8a9`; `21a8f996` also corrects a premature UAT provider-receipt assertion.
The parser no longer uploads, restores or registers document bundles. Migration
0038 releases the old cache references and rejects the retired cache kind.
Paid image-caption/audio-transcript caches and source objects are preserved.

The [new storage comparison](../../bench/parsers/reports/2026-09-28-office-storage-no-parse-cache.md)
contains all 18 native fixtures and six paired live files, using identical frozen
uploads on both releases. All native export/rebase checks and all six live
after-cases passed. Published active payload fell 28.44%, from 1,749,174 to
1,251,716 bytes. Including retained B2 copies, the observed total fell 28.52%,
from 3,488,561 to 2,493,600 bytes. DOCX/PPTX checkpoints still explain the native
editing jumps; those persistence formats were not changed. Calculated overlap,
user quota, local ZIPs and database overhead are identified separately.

The reviewed removal release `21a8f996` passed
[CI 36333573665](https://github.com/samyung0/capy-notebook/actions/runs/36333573665),
[UAT deployment](https://github.com/samyung0/capy-notebook/actions/runs/36335068075)
and [ingest deployment](https://github.com/samyung0/capy-notebook/actions/runs/36335505652).
Old UAT parse/ingest consumers were stopped before migration and remained stopped
until matching activation. All 82 registered bundles, 16,735,471 bytes, have no
current B2 objects after the deletion grace/reaper. Hidden versions await the
normal one-day lifecycle. A post-quality check also found no current object
anywhere under the document parse-cache prefix.

[UAT quality 36335617678](https://github.com/samyung0/capy-notebook/actions/runs/36335617678)
passed smoke, nine authenticated browser cases and 13 lifecycle journeys.
Cleanup finished at 17:35:30 UTC with `failed: []`, and all five ingest identities
were unchanged. The subsequent observation through 17:46 UTC found no new app,
ingest or Sentry errors, no container restarts/OOM kills, and Office editing
enabled with no unpublished or in-flight work. The report explains the deliberate
terminal-error test and other classified log records. Exact aggregate evidence
is in [the rollout record](parse-cache-rollout-2026-09-28.json).

The [Astra xhigh review record](review-parse-cache-astra-xhigh-2026-09-28.md)
covers implementation, rollout corrections, receipt timing, independently
recomputed measurements and the small follow-up CI fix. No actionable findings
remain in those reviewed changes.

The separate `d5d31d17` editor merge reached main while the paired UAT run was
active. Its Docker browser failure came from the Add comment textarea losing its
accessible name; the retained accessibility snapshot confirmed the unnamed
textbox. Its retry then hit a name conflict because fixture cleanup soft-trashes
materials. Follow-up `5416fcaa` restores the localized `Comment` accessible name and
gives each test material a UUID-suffixed title. Existing test assertions and
product title uniqueness remain intact. These main follow-ups do not change the
measured UAT runtime, which remains `21a8f996`; production was untouched.

### Follow-up editor CI corrections

[CI 36338724004](https://github.com/samyung0/capy-notebook/actions/runs/36338724004)
passed the 39 Docker browser cases and the backend, pipeline, frontend and Office
pin jobs. The expanded editor suite from `d5d31d17` had 102 passes, two failures,
one flaky case and one skip. All three problematic cases reproduced locally.

The callout test measured a one-pixel difference from the CSS line-height box,
while the rendered first text line differed by only half a pixel. It now measures
the rendered line and preserves the existing strict one-pixel assertion. The
slash group test expected the obsolete `File operations` label instead of `File`;
it now verifies that the accessible group name matches its nonempty visible
heading. The to-do test used platform-dependent Home/End selection and could
send Backspace with a collapsed selection, removing the list marker. It now
drags the exact fixture text, verifies the selection and waits for Slate's
selection toolbar before deletion. All original editing and layout checks remain.

These are test-only corrections. The focused three-case run passed, followed by
nine repetitions with one worker and no retries. Formatting/lint passed. An
explicit Astra xhigh reviewer found no actionable issue in the bounded changes;
full Linux CI remains the final check after pushing this follow-up.

### Comment capture and development-server reload

[CI 36341111503](https://github.com/samyung0/capy-notebook/actions/runs/36341111503)
passed all three corrected cases on their first attempts, all 39 Docker browser
cases and the four other jobs. It exposed a selected-text comment failure and a
CSV preview retry in the editor suite, which had 103 passes, one failure, one
flaky case and one skip.

The Linux trace showed the correct text visibly selected before Comment opened,
but the saved discussion had no anchors. Comment captured `editor.selection`
before Slate's throttled native-selection sync. A focused same-task selection
and Comment click reproduced the missing anchors before the application fix.
The shared Comment action now converts the current native range when its
endpoints belong to the editor, preserving stored selection for commands opened
outside it. Portable mouse selection also replaces the tests' platform-dependent
Home/End setup. All five comment cases passed without retries, including the
immediate-click regression and command-palette selection. Root formatting, lint
and TypeScript checks passed.

The CSV test lost its execution context during a Vite reload triggered by the
parallel Word-export test. A cold-cache reproduction logged late discovery of
the export worker's existing `buffer` and `katex` dependencies, then a reload.
Both cases happened to pass in that reproduction. Explicitly prebundling those
dependencies removed the reload in the same cold-cache parallel run, with both
cases passing without retries. CSV assertions and retries were unchanged.

The initial Astra xhigh reviewer identified the real capture race and confirmed
the fix. A fresh Astra xhigh closing review found no actionable issue. Full Linux
CI is checked after pushing this follow-up. The requested pull from `origin/main`
found no incoming changes at `5fd64dd2` and preserved these local fixes.

### Table-of-contents retitle flake

[CI 36368412155](https://github.com/samyung0/capy-notebook/actions/runs/36368412155)
passed every job at `31941850`. The comment-capture and prebundle fixes held.
One editor case flaked: the table-of-contents retitle typed `updated` mid-word
(`Editor matrix headinupdatedg`). The trace shows the h1 click landing at its
centre, the space landing at the end after `End`, then the TOC re-render
restoring Slate's stale click caret before the remaining text. This is the
throttled-selectionchange race already documented in `live-collaboration.spec.ts`.

The insertions tests now use `clickTextEnd`, which clicks the text's last pixel
instead of relying on `End`, so a stale restore lands at the same place. The
slash test's inline workaround moved into that helper. Test-only; 25 serial runs
and 40 runs with four workers at load average 22 passed without retries.

No storage-relevant runtime changed after `21a8f996` (one comment in
`source_refresh.go`; same BetterOffice pin), so the September 28 storage report
remains the current measurement.

## Office save cost, 2026-09-28

Epo asked why every DOCX/PPTX save rewrote a full snapshot. Two Opus
investigations ([write path](save-write-path-2026-09-28.md),
[state representation](state-representation-2026-09-28.md)) led to four
recorded decisions (`human/frontend/office-files.md`,
`human/backend-storage-quota.md`, 2026-09-28):

- Source rooms debounce 5 s / 30 s; the browser's idle request only registers
  its receipt, explicit saves `flush`. Saved still means a database commit.
- Office states are stored as their Yjs change over seed(base) with
  `state_seed_sha256` (migration 0039), rebuilt and checked on every write and
  read; text and DOCX/PPTX states rebased by a publication stay whole. Office
  rows are charged as stored, text keeps `seed_bytes`.
- Write path: blob-reference triggers fire only on path changes, saves start
  from the instance's durable copy, the base is downloaded once, and access is
  rechecked at most every 5 s per connection.
- Pin bumps run `office-maintenance seed-manifest` and
  `pnpm office:seed-check` first (runbook). No legacy Office editing data
  exists anywhere, so nothing converts old rows.

One saved edit across the 18 native fixtures now stores 4.7 KB of state
instead of 559 KB ([report](../../bench/parsers/reports/2026-09-28-office-state-diffs.md)).
An Opus review found a critical rebuild-check bug (non-canonical merged
encodings refused valid saves permanently) and a text-publication fast-path
bug; both are fixed with regression tests, and an Opus recheck plus the
reviewers' fuzzers (0 refusals in about 30k saves) closed the loop.

## Stage 2 and DOCX fidelity, 2026-09-29

Epo approved stage 2: DOCX and PPTX publication rebases now land on
seed(export) like XLSX, so every Office state is its change over its seed and
no row stores `indexed_baseline` (migration 0043). Rebased DOCX/PPTX rows drop
from 1,074.8 KB to 4.2 KB across the 12 fixtures
([report](../../bench/parsers/reports/2026-09-28-office-rebase-seed-export.md)).
Six Opus implementation rounds and five reviews shaped it; every behaviour
choice is a 2026-09-28/29 line in `human/frontend/office-files.md`:

- A rebase the engine cannot reproduce exactly refuses with a terminal 422
  (restored content, unaligned comment anchors, unrenderable states); the edits
  stay saved and the next publication carries them.
- The DOCX editor never puts text ahead of a table, page or column break or
  block content control; Delete and Backspace follow Word and never delete a
  table or content control.
- Comments pair with the export's ids and land through the text alignment.
- DOCX export fixes found on the way: page/column breaks saved from break
  units, `w:cstheme`, valid `w14:paraId`, `w:rPr` before a rendered page
  break, and exact comment and bookmark ranges across publications (a seed
  change for DOCX with comment ranges; comment-free seeds are unchanged).
- Page breaks outside the body (cells, headers, footers, notes) are still
  dropped by the export; keeping them needs a representation change and is a
  separate task.

The account lifecycle deadlock (Clerk `user.deleted` webhooks holding the
4-connection UAT pool) is fixed in `efde3dc8`. BetterOffice `capy-ci` is at
`558f63d9`, pinned by `97224e85`. That revision passed CI and the full UAT
gate (run 36493375567: 13/13 journeys, clean cleanup, no restarts); UAT held
no Office rows, so the seed change needed no maintenance window. Production is
untouched.
