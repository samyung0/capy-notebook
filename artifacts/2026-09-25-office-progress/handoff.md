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
image metadata timeouts before any test started. CI will verify it after push.

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
