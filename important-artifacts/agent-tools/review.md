# Agent tools plan review

Reviewed 2026-09-09 against Capy `38a7bbc`, BetterOffice `ef3a5fd`, the current `artifacts/agent-tools/plan.md`, root workflow instructions, the applicable human decisions, OpenWiki, and the implementation paths cited below. This is the requested Astra xhigh plan review. Repository inspection was read-only. No application code, live services, databases, paid calls, or runtime tests were used.

Verdict: make three narrow corrections before handing this plan to the implementer. The architecture and agreed product choices are otherwise consistent with the inspected code. These findings concern the implementation required by direct editing and guarded Undo, not a request to reopen the architecture or Trash policy.

The author added the history-reconstruction paragraph at plan line 123 during this review. It addresses lost SSE/activity and orphaned streaming rows, so those issues are not reported as unresolved findings. Plan line references below refer to that revision.

## R1 · P1 · Validate commands at the durable merge, not only in a local room

Plan references: `artifacts/agent-tools/plan.md:114`, `:116`, `:158`, `:159`, `:160`, `:171`.

The specified Office merge-boundary check is necessary but does not close the existing cross-replica persistence race. The plan serializes duplicate operation IDs, but two different commands or a command and an ordinary edit can still affect the same target.

Evidence:

- `collaboration/src/serviceCommand.ts:127` applies the command to a local room before the disconnect/store path. `collaboration/src/commands.ts:63` checks expected content in that local document.
- `collaboration/src/persistence.ts:574` locks and loads the existing durable state; `:582` and `:584` then merge that state with the local snapshot. This can introduce a target change that the earlier local check never saw.
- `collaboration/src/sourceDocuments.ts:354` explicitly handles out-of-order Redis delivery and database flushes. It reloads the current session and merges again at `:357` through `:365`, and repeats after a 409 at `:380` through `:386`.
- `server/internal/store/source_documents.go:200` checks the checkpoint CAS, but the current Go checkpoint request contains an already-built state rather than command target preconditions.

Example: replica A validates an AI edit or Undo against target value X. Replica B durably changes that target to Y before A stores. A's normal store reloads/merges Y, or retries its source checkpoint after a 409, and commits without revalidating the command. The command can be recorded as successful even though the agreed stale-target condition was crossed. Broadcasting a rejected command delta before this check also lets another replica persist it through the ordinary edit path.

Smallest plan correction: carry the operation descriptor, expected target guards, and prepared delta through the authoritative persistence path. Under the existing material lock or source checkpoint CAS, check for an existing operation receipt first, merge applicable non-command state, re-resolve and validate every target, then commit the command, inverse, and receipt together. Every source CAS retry must revalidate the targets against the refreshed state rather than blindly remerge the prepared command. An unrelated durable change may be merged and retried; a changed target must refuse. Keep an uncommitted command delta out of ordinary peer broadcast/persistence, or explicitly require every receiving persistence path to enforce the same operation guard before accepting it.

Add one focused race case each for material and source persistence: another replica changes the target between local preparation and durable commit. The edit/Undo must refuse with no durable effect. A sibling case changing an unrelated target must succeed and retain both edits.

Classification: implementation correction. No new product choice or standalone service is needed.

## R2 · P2 · Specify durable guards for deleted ranges and empty cells

Plan references: `artifacts/agent-tools/plan.md:144`, `:145`, `:147`, `:170`, `:171`.

The required changed-then-reverted check is correct, but the plan currently names native identity/change stamps without identifying the missing native contract. This matters most when the AI's own operation leaves no live target to inspect. Value equality, stable coordinates, and a surviving surrounding paragraph are not sufficient for that case.

Evidence:

- The headless runtime currently exposes only seed/compare/export/asset operations in `collaboration/src/officeRuntime.ts:30`. Its existing effect shape has IDs and before/after values, not a mutation guard, at `:19`.
- The BetterOffice checkpoint projection exposes spreadsheet cell IDs, values, formulas, and formatting in `vendor/betteroffice/shared/office-checkpoint.ts:305`, but no per-target change identity. PPTX text inspection similarly produces paragraph IDs and flattened values at `:448`.
- Clearing a spreadsheet value removes the native content-map entry in `vendor/betteroffice/crates/betteroffice-xlsx/src/authority/stable.rs:581` through `:583`.
- Plate's existing replacement check uses deep value equality in `collaboration/src/commands.ts:63` through `:67`; it supplies no persisted change guard for this new promise.

Example: AI clears A1, another user writes a value and clears A1 again, then chat Undo runs. The cell has the same stable location and empty value as immediately after the AI edit. It must still refuse. A deleted text range has the analogous problem if somebody inserts and removes text in the resulting gap. Conversely, an immediate Undo of the AI's own deletion must work, rather than treating the intentionally absent target as already unavailable.

Smallest plan correction: make per-format guard production and validation an explicit dependency of the headless command bridge. Define a guard for present targets and for intentionally absent targets, such as a native retained mutation identity or an affected-range/gap guard with stable parent/neighbor identities. It must detect intervening writes from browser, remote, manual Undo/Redo, and service commands. Capture it from the final committed state with the inverse. Relative positions alone and whole-document revision counters are not substitutes. If an engine needs a bounded guard export or mutation hook, include that in the reviewed BetterOffice fork work instead of assuming the current snapshot provides it. Guard lineage may expire at the already-approved rebase/compaction boundaries; historical Office packages are not required.

Add explicit immediate-delete-Undo, clear/write/clear, and insert/delete-in-gap cases, plus an unrelated-target edit. These tests establish that the chosen native guard actually implements the promise.

Classification: missing implementation dependency. The user already chose the behavior; weakening the guarantee to value equality would be a new product choice and is not recommended.

## R3 · P2 · Include flashcard study-state side effects in supported removal Undo

Plan references: `artifacts/agent-tools/plan.md:144`, `:170`, `:172`, `:173`.

The plan includes removals and typed flashcard content mutation, but the inverse currently covers text, blocks, and cells only. Removing an authored flashcard ID has a relational side effect that a content-only inverse cannot reverse. The handoff must explicitly account for it before claiming every supported removal is undoable.

Evidence:

- `server/internal/store/yjs_documents.go:180` through `:190` reconciles flashcard study rows after projecting an authoritative content edit.
- `server/internal/store/queries.go:2276` through `:2292` deletes `card_stats` for removed IDs and creates fresh `known=false` and new SRS state for IDs that reappear.
- `server/migrations/0001_init.sql:453` stores the relevant state separately from the Plate document.
- In-place card edits preserve IDs in `server/internal/store/queries.go:2176` through `:2193`, so this issue is specific to removal/rekeying, not ordinary front/back edits.

Example: a previously studied card is removed by an AI command and the projection deletes its `card_stats`. Chat Undo reinserts the same authored card. The normal projection now recreates a new scheduling record, silently losing its learned state even though the UI says the edit was undone.

Smallest correction that keeps the planned scope: require stable IDs for in-place study edits. For a supported removal, retain only the affected dependent study row with the guarded inverse and coordinate its restoration with the existing material/projection lock and version checks. Handle concurrent study updates and delayed, skipped, or repeated projections explicitly. If the projection still needs a restoration payload, a successful Yjs Undo must not delete that payload before the relational restoration has committed. Unrelated card study rows remain untouched. These internal consequences do not expose a tool for editing SRS or known state and do not add a general history archive.

Add one removal/Undo test with non-default known/SRS data and a delayed projection, verifying exact restoration of the removed card and preservation of another card's newer study update.

Limiting initial typed study edits to authored fields on existing IDs is a smaller alternative. It can be a deliberate implementation boundary while the removal path is unfinished, but it reduces the completed plan's currently listed removal behavior. It should not silently replace that behavior. Preserving the bounded dependent state is the correction that honors the present handoff without asking for a new product decision. Existing independent quiz attempt history should retain its current semantics.

## Other checked points

The plan correctly keeps Python's chat loop, local retrieval, shared Go material persistence, separate Generate billing, direct chat application, explicit PDF refusal, and the existing Office one-current-source/base-replacement policy. It reuses material `room_schema`, includes never-bootstrapped resources, retains Trash charges and references, preserves current-owner control across transfer, and covers cancellation, old-room writes, delayed eviction, purge episodes, read exclusions, restricted empty scope, and acknowledgment after trashing the last source.

One implementation clarification should be added alongside inverse accounting: distinguish accounting from admission. Existing material growth deliberately does not call the hard creation gate, as documented at `openwiki/backend-storage-quota.md:168` and enforced by the material limits path in `collaboration/src/persistence.ts:585` through `:620`. Source checkpoint growth is gated on the net increase at `server/internal/store/source_documents.go:217` through `:224`. The new inverse ledger must participate in owner transfer, reconciliation, cleanup, and the appropriate net transaction accounting without accidentally placing every ordinary material save behind `gateStorageTx`. If a new inverse allocation needs a separate restriction, state its exact effect on AI edits at or over quota; do not silently change manual shrink/recovery behavior or commit an edit without its promised inverse. This is a clarification, not an additional finding that requires reopening the existing quota policy.

Verification here was static inspection. The focused race, native-guard, and projection cases above are acceptance requirements for the later implementation, not tests reported as passing today.

## Focused resolution check · 2026-09-09

Rechecked only R1–R3, the related inverse-accounting clarification, and regressions directly introduced by those changes. This was a plan check, not an implementation review or a new repository audit.

| Item | Status | Resolution in the revised plan |
| --- | --- | --- |
| R1 | Fixed in plan | `artifacts/agent-tools/plan.md:158` keeps candidate commands isolated from ordinary broadcast/store snapshots. `:159` reconciles ordinary edits and checks receipts and targets against the durable pre-state under the material lock or source CAS. `:160` requires fresh validation and inverse capture after asynchronous work and every CAS retry. `:161` permits only committed delta fanout while preserving newer live edits. Acceptance at `:297` covers the cross-replica target race, unrelated changes, and CAS retries. |
| R2 | Fixed in plan | `artifacts/agent-tools/plan.md:170` defines present and intentionally absent targets and requires immediate deletion Undo. `:171` makes guard production/validation an explicit native-bridge prerequisite, covers every write origin and the cleared-cell/deleted-gap cases, and rejects value equality, relative positions, or whole-document counters as substitutes. `:172` uses these guards at the durable Undo boundary. Acceptance at `:298` includes the required cases. |
| R3 | Fixed in plan | `artifacts/agent-tools/plan.md:173` preserves stable study IDs, retains affected known/SRS state for removals, coordinates study writes and projection locks, rejects conflicting ID reuse, and protects progress acquired after insertion. It preserves independent quiz history and exposes no study-state editing tool. `:115`, `:174`, and `:175` retain the bounded repair payload until dependent relational restoration commits, including delayed/skipped/repeated projections. Acceptance at `:299` verifies exact restoration and unrelated progress preservation. |
| Inverse accounting clarification | Resolved | `artifacts/agent-tools/plan.md:175` distinguishes owner accounting from admission, uses combined source state/inverse net growth, preserves material lifecycle/limit/shrink rules, and explicitly prohibits moving ordinary material saves behind `gateStorageTx`. Cleanup retains only repair data required to finish an already-committed dependent restoration. |

No unresolved finding or directly introduced plan regression remains from this focused check. The R3 correction retains the agreed removal scope rather than silently restricting study edits to existing IDs. The added protections describe the implementation necessary for the agreed Undo behavior; they do not require a new product decision.

Final plan-review verdict: R1–R3 are resolved in the handoff plan. This supersedes the initial request for revisions above. The later implementer must still deliver and run the specified acceptance cases; no runtime behavior is claimed as verified here.
