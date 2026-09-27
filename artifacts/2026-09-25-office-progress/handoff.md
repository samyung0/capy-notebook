# Handoff, 2026-09-27

The continued investigation is in
[investigation-2026-09-27.md](investigation-2026-09-27.md), with compact observations
in [investigation-evidence-2026-09-27.json](investigation-evidence-2026-09-27.json).
It supersedes the pending verification and uncommitted-change statements in the
earlier [docx-failure.md](docx-failure.md).

## Verified state

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

## Fixes to implement

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

This investigation ran the three previously problematic or blocked rich-content
scenarios, not a new complete 13-journey gate. Product fixes remain unimplemented.
After those fixes and green CI, use the existing UAT deployment and full journey
workflow when release work is requested.
