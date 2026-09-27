# Office review repeated with Astra xhigh

The reviews below were dispatched with the explicitly requested configuration
`model: gpt-6-astra`, `reasoning_effort: xhigh`, and a fresh context. The agent
tool accepted that configuration. Child agents cannot independently inspect
their runtime model ID. These reviews supersede the earlier Luna passes for
this release.

## Original Office changes

The independent reviewer examined Capy `50302c8e` and BetterOffice `99d5bcc4`,
including DOCX caret handoff and language preservation, PPTX clipboard and IME
input, closed-menu event handling, actor cleanup ownership, the Biology 101
fixtures, stable navigation selectors, and the engine-upgrade migration.

That pass reported no actionable correctness, data-loss, integration or
test-validity finding. The reviewer independently ran 85 native cases, 32 shared checkpoint
and golden cases, six Chromium cases and nine offline verifier cases. Fresh
native seeds matched all six committed application checkpoints byte for byte.
The detailed report is `/private/tmp/capy-office-astra-xhigh-review.md`.

## Failures found during deployed monitoring

The internal collaboration routes used the public anonymous IP budget because
the exemption covered a different URL namespace. The Redis reproduction failed
before the fix and passed afterward. The bounded Astra re-review confirmed that
the new exemption retains service-secret and actor checks and leaves public
rate limits enforced. Report: `/private/tmp/capy-office-rate-limit-astra-review.md`.

The eviction review reproduced a gap between Hocuspocus starting a store hook
and application save tracking, plus a gap between consecutive queued saves.
It also confirmed that Hocuspocus does not await the stateless callback's
promise. The fixes wait for native hooks and all accepted source saves, preserve
failure for callers that require a durable receipt, and contain the rejection
already reported by a stateless save. An intermediate discard implementation
could falsely report success to source handoff; review caught it and the final
implementation rejects that cancelled save. Eight exact-function cases,
including the actual source-handoff path, passed after correction. Report:
`/private/tmp/capy-office-eviction-astra-review.md`.

A fresh closing Astra reviewer independently inspected the final production
diff and the pinned Hocuspocus/Redis implementation. It found no remaining
actionable issue. All 307 collaboration tests, collaboration type checking,
and the root Go rate-limit/HTTP test packages passed. The fixes are committed
in `2f54d84a`.

That reviewer also checked the UAT export helper correction. An untouched
store-only source may have checkpoint zero, NULL state and an empty base hash.
The helper now permits only that exact state; populated hashes and edited
states remain strict. Seven Node verifier tests and three Python tests passed.
The live rich-XLSX scenario passed on unchanged UAT `15c0dbe0`, confirming that
the previous hash assertion failed before the first real checkpoint. Closing
report and helper addendum: `/private/tmp/capy-office-final-astra-review.md`.

## Pending native input

The storage run prompted another narrowly scoped Astra xhigh review. It
reproduced a real gap while DOCX's worker processes accepted keyboard input
and PPTX decodes an inserted image. Both native editors correctly awaited
their input when Save was requested, but neither reported that pending work
to the host. Before the native update reached the shared document, the parent
could still show Saved and had no close warning.

The fix forwards the editors' pending callbacks to the existing source-session
dirty state. DOCX reports acceptance synchronously, clears only after all
successful operations finish, and retains pending status after an input failure.
PPTX reports its existing image-operation set. Old queue/image completions are
guarded against clearing a newer session's pending work. Native updates arrive
before the callback clears pending status; the server receipt still determines
when the shared document is Saved.

The original reviewer repeated both full-app browser reproductions and verified
Saving plus the close warning before Save and while its flush waits. Holding
the actual checkpoint receipt after the native queue drained still kept Saving
and the warning active. Two additional actual-native lifecycle checks confirmed
that old completions cannot clear new work. The 42 focused native tests passed
with 303 assertions; the two reviewer lifecycle cases added 16 assertions.
The bounded recheck found no remaining actionable issue. Evidence and the
before/after report are in `/private/tmp/capy-office-save-status-astra-review.md`.
A fresh closing Astra xhigh reviewer found no actionable issue and independently
ran the 12 DOCX queue/input cases with 49 assertions. Report:
`/private/tmp/capy-office-pending-closing-astra-review.md`. The committed Biology
DOCX browser probe passed in 2.0 minutes after reopening the file following
scenario Reset; that action navigates out of the file. The synthetic unload
probe runs last because MSW also handles beforeunload by closing its mock client.

The separate storage measurement barrier remains necessary. An observation of
any visible Saved label does not identify which edit has persisted. The probe
now verifies the requested owner edit in the exported server checkpoint before
comparing the quota API with the source row. This preserves the strict quota
assertion. The timing evidence proves the earlier billing read preceded the
first checkpoint request; it does not retrospectively identify which browser
phase caused that observation. Astra's bounded barrier review found no issue.

The next full UAT gate passed 12 of 13 journeys, then the PPTX paste helper
single-clicked a body shape and incorrectly expected text focus. A first click
selects the shape; entering text requires a double click after the prior slide
switch cleared selection. The helper now double-clicks its existing canvas
target. Another bounded Astra xhigh pass confirmed the native interaction
contract and retained assertions. The gate's cleanup had no failed resources.
The corrected focused PPTX journey then passed in 3.5 minutes on unchanged
UAT `2f54d84a`. The next full release gate remains separate evidence from that
code review and focused run.

## Storage methodology

A separate bounded Astra review checked all 18 committed source hashes, archive
and media measurements, displayed storage and quota sums, real PostgreSQL
compression, native edit/export/rebase workload, and the live database/object
collector. It found no actionable methodological error. The available DOCX
and XLSX live triples reconciled, including hidden B2 versions and retained
earlier parse bundles. The collector counts each exact object key once.

The report distinguishes attributable payload from shared index pages, tuple
overhead, WAL, backups, memory and temporary conversion peaks. Exact committed
files and marker-repacked live uploads also remain separate. The final recheck reconciled all 18 live snapshots, all three live tables,
the native aggregate and 12 strict quota receipts. Every quiet publication
cleared state and baseline. All three contributing runs had clean cleanup and
matching ingest identities; partial file measurements were excluded. Report: `/private/tmp/capy-office-storage-astra-review.md`.

## Deployment telemetry correction

Post-deploy database logs exposed a preexisting import-worker telemetry gap.
The worker emits `import`, while the raw-sample and minute-rollup constraints
accepted only `parse` and `ingest`. A real PostgreSQL reproduction failed on
the same import constraint while the existing roles passed. Forward migration
`0037` extends both constraints; all three real-writer cases then passed with
both raw rows and rollups verified. The Ops history chart now keeps import
metrics separate instead of assigning every non-parse row to ingest.

A fresh Astra xhigh reviewer found no actionable issue in the migration,
writer test, aggregation or chart wiring. The migration and ledger entry run
in one transaction; the Ops query already produces one row per minute/role.
The 29 Ops tests, Ops typecheck and focused Go migration harness passed.
Report: `/private/tmp/capy-import-telemetry-astra-review.md`.

## Evidence limits

An additional Astra xhigh pass examined the earlier modified-click timeout in
`document-pages.spec.ts`. The waiter was armed before the click. The child
requested its document, API data and PDF successfully, but Playwright never
published its initialized Page before the timeout. Network tracing starts
before that publication, so those observations are consistent. The retained
trace lacks the Chromium protocol commands and replies needed to distinguish
the exact initialization or event-dispatch failure. No application or test-code
defect is proved, and changing the waiter or timeout would be speculative.
The exact test passed in 39.2 seconds in CI `36315657945`, without retry.
Report: `/private/tmp/capy-office-tab-astra-review.md`. If it recurs, retain
`DEBUG=pw:protocol` and browser logs for the child target; later passing runs
alone cannot establish its historical cause.

These reviews establish the inspected code paths and retained reproductions.
They do not certify every possible Office document or replace the deployed
UAT gate. The two original failed DOCX exports were not retained; the fresh
captured reproduction establishes their failure class, not their unavailable
historical bytes. Release and live-measurement completion are recorded in
[the handoff](handoff.md) and [the storage report](../../bench/parsers/reports/2026-09-27-office-storage.md).
