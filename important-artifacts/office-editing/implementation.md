# Collaborative source editing implementation

6 September 2026. Changes are in the current Capy checkout and the
`vendor/betteroffice` submodule working tree. The agreed schema changes are in
`server/migrations/0001_init.sql`. No commit, PR, deployment or live database
migration was performed.

## Delivered behavior

- DOCX, XLSX and PPTX use shared durable source state. Saving flushes active
  input and waits for a database receipt. Local recovery drafts survive failed
  saves, concurrent tabs and editing-epoch changes.
- XLSX row, column and sheet operations use stable identities, including
  formulas, ranges and the agreed automatic name/merge/last-sheet conflict
  rules. DOCX comments, replies and resolution share native document state.
- Office refresh captures an immutable checkpoint after the agreed threshold
  and idle period. A stale result cannot replace newer edits. A successful
  handoff replaces source, index and preview together and clears Office Undo.
- Raw text, JSON, Markdown, CSV and TSV use shared text with IME, selection and
  local Undo support. Reindexing batches every 15 seconds, preserves residual
  edits and reuses exact matching embedding inputs.
- Chat and generation carry exact pending edits outside conversation
  compaction. Full requests reserve model output and safety allowances within
  the 250k input ceiling. Publication during evidence gathering produces an
  explicit retry message instead of combining different source versions.
- Image captions use shared SHA-keyed payloads with current resource access.
  Pending, candidate and ordinary ingest jobs recheck source identity before
  attaching cache references. Full-document summaries use all current chunks.
- Workspace settings use the selected three-tab layout, existing progress bar,
  two pending counts and automatic-processing switches. Native PDF highlights,
  shapes and erasing remain private visual overlays.

## Verification

| Area | Result |
| --- | --- |
| Go | Full store, HTTP API and ops suites passed; remaining Go packages passed in the earlier full run. Source locking, cancellation and error relay tests passed after their final changes. |
| Pipeline | 546 offline tests passed; 147 source/SQL/worker/indexing tests passed. The final independent follow-up passed 78 focused tests, three original SQL race proofs and the HTTP overflow check. These sets overlap. |
| Collaboration | 99 tests passed with one worker; TypeScript build passed. All three actual Node Office runtime checks passed again against the final packaged WASM. |
| Browser | Actual Office iframe input/save/export, IME, handoff, comments, text preview, PDF annotation and IndexedDB recovery checks passed. |
| BetterOffice | 163 native XLSX tests passed. Final headless/WASM follow-up passed 43 tests with one existing skip; prior DOCX-specific checks passed. |
| Independent concurrency checks | All 16 bounded traces passed, covering 320 local actions, reordered delivery, fresh restoration, deterministic export and final convergence. Ready portions of mixed-client updates and retained delayed tails also passed. |
| Formatting | Root Biome/Ultracite, Go formatting and cached Ruff formatting/checks passed. |
| Production frontend build and full frontend suite | `pnpm run build` passed after rebuilding all Office engines. `pnpm run test` passed 290 frontend tests across 59 files and four performance-helper tests; its prepare hook correctly reused all nine unchanged WASM builds. |

The 10,019-cell local spreadsheet probe reduced median projection time after
20 structural edits from 714 ms to 101 ms by sharing one topology context per
projection. This measures that case only; it is not a maximum-file benchmark or
a memory improvement claim.

## Independent review

Astra HIGH reviewers checked frontend/collaboration, Office document semantics,
and source/ingest/evidence lifecycles. Confirmed findings were corrected and
independently rechecked. The final bounded reviews report no remaining
actionable findings:

- [Source sessions, editor input and collaboration](reviews/source-frontend.md)
- [Recovery completion and error presentation](reviews/source-recovery.md)
- [Pending evidence, caption ownership and error relay](reviews/pending-evidence-and-captions.md)
- [Spreadsheet delivery, restoration and convergence](reviews/office-concurrency.md)

## Verification limits

The collaboration Docker build could not complete because registry/package
downloads repeatedly failed. Actual Node worker tests load the packaged Office
adapters locally, but they do not substitute for a completed container build.
No deployed multi-instance exercise, live parser/B2/provider run, native
Microsoft Office rendering comparison or maximum-source-size benchmark was
performed. Tests used local fixtures, disposable databases and synthetic
external-service responses.
