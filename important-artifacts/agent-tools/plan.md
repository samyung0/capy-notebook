# Agent tools, direct editing, and recoverable deletion

Implementation handoff, 2026-09-09. Based on Capy Notebook `main` at `38a7bbc` and BetterOffice `ef3a5fd`. Product choices are agreed, including content-only editing and guarded chat Undo. Status: ready for implementation after the requested Astra xhigh review and focused recheck. This document is a plan, not an implementation report.

## 1. Delivery and agreed decisions

Implement shared agent-tool contracts, structured chat results, shared material creation, direct document editing, and a 30-day trash lifecycle for both source files and Plate materials. Ship usable manual trash controls before exposing trash tools to chat.

The developer approved the preceding architecture review and specified the following refinements on 2026-09-09:

- Python retains the chat agent loop. Existing retrieval handlers remain local; material mutations use Go and document edits use the collaboration service. A separate tool deployment or HTTP/MCP discovery adapter waits for a concrete external integration. Adding Google/YouTube search or building a general plugin host is outside this implementation.
- Shared contracts cover tool definitions, allowed slots, resource permissions, trusted invocation context, input/output schemas, progress, resource results, and durable mutation receipts. Only chat exposes an agent tool loop today.
- The fixed Generate workflow and chat material creation keep separate entry paths and model accounting, while sharing validated Go material persistence. Rename the model-facing `generate_material` tool to `create_material` to match its actual behavior.
- Chat edits apply directly. Do not add an acceptance step to chat. Existing Plate editor-menu preview/accept behavior remains a separate feature.
- Initial edits cover Plate blocks/study content, text sources, Office text and spreadsheet cells/formulas. Formatting, Office structure and media manipulation are deferred. Each direct AI edit has a guarded Undo action in chat that reverses only that edit and refuses if its affected targets have since changed.
- A PDF edit attempt returns a normal tool refusal with `unsupported_format` and the message `Cannot edit PDF files.` It makes no content change and does not fail the entire chat turn. Existing private PDF annotations are unaffected.
- Manual and tool-triggered deletion first trashes the resource. Retention is 30 days, measured by the database from the first successful trash transition. Replaying that transition must not extend retention.
- Trashed content remains charged to its storage owner. Trashed source files also retain their slot in the workspace file-count limit.
- Owner, member editor, and link/public editor can trash active workspace content. Only the current workspace owner can list, restore, or permanently delete shared trash. An editor does not gain trash access by having uploaded or trashed the item. Standalone material trash belongs to that material's owner.
- The existing Files page gains a Trash tab through the existing Tabs component. The tab includes source files and Plate materials owned by the viewer, across their owned workspaces and standalone materials. Restore and permanent deletion are available there. Chat exposes trash and owner-only restore, never permanent deletion.

Decisions are recorded in `human/agentic-retrieval.md`, `human/authorization-permissions-lifecycles.md`, and `human/backend-storage-quota.md`. Read those files before implementation. Do not reinterpret an implementation detail in this plan as permission to change an unrelated product policy.

## 2. Repository workflow and scope

- Read root `AGENTS.md`, `AGENTS.local.md`, and the `human`, `ponytail`, and `unslop` skills. Work on the current Capy `main` checkout without stashing or reverting other work. Do not open a PR, deploy, access a live database, or run paid model calls as part of this handoff.
- BetterOffice changes follow its own `AGENTS.md` and the root submodule workflow: a feature branch from current `origin/capy-ci`, review, merge into `capy-ci`, then pin that exact reviewed commit in Capy. Do not change BetterOffice `main` or point the submodule at an unmerged feature branch.
- Use existing components to extend Files and chat. The specified Files/Trash tabs are approved; a new visual design system or unrelated layout redesign is not part of the task. If proposing a different non-trivial UI, follow the repository's mock-selection workflow first.
- Preserve current model pins, slot requirements, search ranking, chat budgets, exact pending evidence, locale behavior, credit settlement, source processing thresholds, and account/workspace deletion policies.
- Workspace deletion and final account purge retain their existing teardown semantics, including removal of already-trashed children. This is a file/material bin, not a workspace or account bin. Retention does not promise recovery after its containing workspace has been deleted.
- Preserve chapter deletion's existing unfiling behavior. Preserve revision pruning on subscription downgrade. Trash does not introduce a second document-history archive.
- Do not add blanket retries, a workflow engine, a public arbitrary-operation proxy, browser-dependent tool execution, an MCP server per editor, or migration to AI SDK `useChat` as a prerequisite.

## 3. Grounding and files to inspect

Read these OpenWiki domains before changing their behavior: `agentic-retrieval.md`, `authorization-permissions-lifecycles.md`, `backend-storage-quota.md`, `observability-metering.md`, `frontend/plate-editor.md`, `frontend/office-files.md`, and `frontend/error-handling.md`. Read `bench/README.md` and `openwiki/editor-perf.md` before editor performance verification.

| Area | Existing implementation | Required change |
| --- | --- | --- |
| Tool schemas, handlers, scope | `pipeline/pipeline/retrieval/tools.py` | Shared definitions, validation, explicit permissions, new tools |
| Agent loop and activity | `pipeline/pipeline/retrieval/agent.py`, `events.py`, `pending.py` | Structured results, per-call progress, evidence refresh after own mutations |
| Python service | `pipeline/pipeline/retrieve/service.py` | Typed trusted chat context and contract-version checks |
| Go chat and persistence | `server/internal/httpapi/chat_stream.go`, `server/internal/store/chat.go` | Trusted invocation identity, durable effects, typed event relay/history |
| Generation | `server/internal/httpapi/huma_generate.go`, `internal_materials.go`, `pipeline/pipeline/retrieval/workflows.py` | Shared material-draft validation and creation; retain separate generation orchestration |
| Schema generation | `server/cmd/openapi/main.go`, `server/internal/httpapi/apimodel/`, `openapi.yaml`, `src/api/types.ts` | Authoritative Go schemas and generated Python/TS contracts |
| Plate commands | `server/internal/store/collaboration_commands.go`, `collaboration/src/commands.ts`, `serviceCommand.ts`, `persistence.ts` | Inspect current authoritative state; guarded direct edits and durable receipts |
| Source collaboration | `server/internal/store/source_documents.go`, `source_refresh.go`, `server/internal/httpapi/huma_source_documents.go`, `collaboration/src/sourceDocuments.ts`, `server.ts`, `officeRuntime.ts` | Source edit commands, stale-target checks, current-state persistence, trash fencing |
| BetterOffice engine | `vendor/betteroffice/shared/office-checkpoint.ts`, its tests, format package/engine APIs | Bounded command support and inspection without a DOM |
| Trash and domain permissions | `server/internal/store/queries.go`, `share.go`, `storage.go`, `workspace_transfer.go`, `server/internal/httpapi/huma_content.go`, `huma_materials.go`, quiz/flashcard routes | Shared active/trash lifecycle for every manual entry point |
| Physical teardown | `server/migrations/0001_init.sql`, `server/internal/store/blobs.go`, `server/cmd/api/blob_workers.go` | Retain references while trashed; use existing delete/refcount/reaper on final purge |
| Index, cache and worker admission | `pipeline/pipeline/retrieval/store.py`, `pending.py`, `parse/caption_cache.py`, `jobs.py`, `pipeline/pipeline/store/db.py`, Go ingest/import/source handlers | Exclude trash from new reads/reuse and fence all late background writes |
| Files UI | `src/routes/Files.tsx`, `src/components/ui/Tabs.tsx`, `src/api/hooks.ts`, `src/api/client.ts` | Owner-scoped Trash tab and mutations |
| Chat UI | `src/api/chatStream.ts`, `src/features/workspace/useChatStream.ts`, `ChatPanel.tsx`, `src/routes/WorkspaceOpen.tsx` | Result cards, resource opening and targeted cache invalidation |

Current details that must not be mistaken for finished support:

- `ToolSpec` already contains a schema and handler, but tool arguments/results do not share one validated cross-language contract. `canGenerate` is the only explicit mutation capability in the Python chat request.
- `generate_material` persists content supplied by the chat model; it never invokes Python `/generate`. Public Generate selects the generate model and makes its own fixed call.
- `ToolResult.created_material` is populated, but the chat tool events and persisted activity do not carry that resource result. `tool_end` is currently emitted after the whole batch finishes.
- `read_document` returns indexed source passages, not editable Plate/Office targets. `list_sources` lists sources, not Plate materials.
- Plate's service command currently replaces one stable custom block. Source/Office helpers can seed, compare, export and resolve an image but do not offer a general authenticated edit command.
- The global Files query already joins `workspaces.user_id`, rather than uploader identity. Reuse that ownership interpretation for trash.
- Actual SQL deletion fires job-cancellation and room-eviction hooks. A soft-delete update will not invoke those hooks automatically.
- Source rooms have an epoch. Material `room_schema` already acts as an epoch and increments during compaction in `collaboration/src/persistence.ts`. Extend these existing fences for trash/restore, including resources whose collaboration state has not been bootstrapped.

## 4. Shared tool and result contracts

### 4.1 Ownership and generation

Extend the existing Go/OpenAPI generation workflow. Define shared resource references, tool metadata, invocation/result/event envelopes and material drafts in Go, then export the machine-readable schemas used by Python and generated frontend types. A small `server/internal/agenttools/` package is a reasonable home if it avoids an HTTP/store import cycle. Do not duplicate hand-maintained versions in three languages.

Keep handlers as ordinary Python functions registered against a known definition. Private bindings map to a local handler or an existing named Go operation. Addresses and credentials stay in environment/service configuration. The model-visible function definition contains only name, description and argument schema. Validate unknown properties, required fields, tagged unions and bounds before invoking a handler. Use a maintained JSON Schema validator if the generated schema needs one; do not write a partial schema interpreter. Pin the supported dialect and test the OpenAPI-to-tool-schema conversion rather than treating OpenAPI 3.0 `nullable` as JSON Schema.

Generate/export the contract through a documented root script, building on `gen:openapi` and `gen:api:full`. Include generated schema assets in the Python package/container. Add one contract fixture test that crosses the generated definitions, Python validation, Go decoding and frontend event narrowing. Unknown contract/tool versions fail explicitly. Add no fake remote binding implementation until a real remote tool is selected.

### 4.2 Required shapes

Use these concepts and a single canonical set of wire names:

| Shape | Fields and rules |
| --- | --- |
| `ResourceRef` | Tagged `source_file` or `material`, stable `id`; material kind/format returned from the server when needed for rendering |
| `ToolDefinition` | `name`, `version`, description, input/output schemas, `allowedSlots`, required resource operations, mutation/concurrency policy |
| Trusted context | Contract version, actor, workspace, slot, assistant-message ID, call ID, operation ID, bounded scope and deadline; populated outside model arguments |
| Invocation | Tool name/version, arguments and trusted context; reject a reused operation ID with a different normalized request hash |
| Result | Contract version, operation/call identity, terminal outcome, bounded model content, structured resource effects and safe typed error |
| Resource effect | Operation such as created/edited/edit_undone/trashed/restored, resource reference, authoritative revision/checkpoint or trash episode and expiry; edit effects include an Undo operation reference/status, never its private inverse payload |
| Progress event | Call/operation identity, stage and optional actual progress/total; no invented percentage for unknown work |

Useful outcomes are `succeeded`, `refused`, `failed`, `cancelled`, and `outcome_unknown`. Distinguish a committed edit with projection pending from an uncommitted failure. The browser's temporary `running` state is not a terminal receipt. Error codes include unsupported format/operation, invalid input, unavailable target, stale target, quota/lifecycle rejection and unknown outcome. Localize frontend messages through Paraglide; keep technical codes stable.

Do not store raw provider reasoning, credentials, full source content, or duplicated document snapshots in operation receipts. Result presentation is determined by trusted resource type and UI code. The model does not choose a component, HTML, JavaScript or arbitrary internal navigation URL.

### 4.3 Capabilities, scope and authority

Keep `agentic_loop` as a model capability required by the chat slot. Resource operations are a separate small policy table, not additional model capabilities. Examples include source/material read, create, edit and trash, plus owner-only trash read/restore. Reuse existing role resolvers and lifecycle gates to evaluate them. Do not infer owner-only capabilities from `canEdit`.

At turn admission, Go sends the available operations and trusted workspace scope. Python filters the offered tool schemas and checks dispatch too. Each Go mutation and authoritative collaboration commit independently rechecks current access and lifecycle. A removed member, downgraded role, trashed target or expired document incarnation cannot pass because a tool was previously offered.

For callbacks, bind the actor/workspace to the authenticated internal request and the real assistant message/conversation. Verify the supplied context against those server records. Never accept model arguments as authority to impersonate another actor or change workspace. Existing service secrets authenticate Capy services; they are not reusable credentials for a future third-party tool server.

Represent a restricted empty scope separately from unrestricted workspace scope. Never turn an empty list after trashing the last selected file into `None`/all files. The current public chat is workspace-scoped; preserve the existing narrower internal source scope when present without inventing a new UI scope selector. Material discovery/editing stays in the admitted workspace. Standalone trash is managed on Files; workspace chat cannot reach standalone resources or another workspace's bin.

Credits stay actor-billed for chat and owner-billed for automatic source refresh. Direct edits save without starting another editor/generate model call. Accepted tools emitted by the call that exhausted chat credits may finish under the existing settlement rule; still enforce current access and storage policy. Preserve shrink-only material behavior and source growth accounting.

## 5. Durable mutations and shared material creation

### 5.1 Receipts

Add the smallest durable operation record needed to reconcile create/edit/undo/trash/restore. This is an idempotency/result record, not a new job queue. Derive a chat operation ID from the assistant message plus tool call; include tool version and a normalized request hash. Browser Undo and trash mutations use one request ID per user action.

- The same ID and same request returns the recorded outcome without reapplying. A different request with that ID conflicts. A later intentional action gets a new ID.
- Create/trash/restore persist their receipt in the same database transaction as the state change.
- Plate/source edits persist the committed receipt with the authoritative Yjs/checkpoint transaction. A Go HTTP response or in-memory `ServiceCommandCompletions` entry alone is insufficient. Carry operation identity through contributor/direct-command persistence and recovery.
- An editable command also co-commits the minimal inverse data and post-edit target guards required by section 6.3. Undo co-commits its own receipt and consumes the original Undo eligibility. Retain any inverse payload still needed to finish a dependent projection until that restoration commits. A successful edit must not quietly omit its promised Undo because storing the inverse failed.
- Serialize admission of the same operation across service replicas. An in-flight duplicate waits only within its deadline or returns an explicit pending/unknown result; it cannot apply a second insert. Failed uncommitted in-memory edits must be discarded before a new execution can proceed.
- A lost response is reconciled through an authorized receipt read. Do not add blind mutation retries. Preserve/rework existing deterministic material replay only as needed to satisfy this same guarantee.
- A committed Yjs change remains committed if SQL projection fails. Expose its durable revision and projection status, leaving the existing projection repair path responsible for catching up.
- Receipts do not cascade merely because the target file/material is purged. They retain only minimal effect identity, allowing an old create call to report an existing completed operation without resurrecting a purged resource. Tie their lifetime/access to the originating chat/account/workspace; a deleted originating turn is not valid authorization for a late callback.

Stopping chat prevents starting more work. An already accepted mutation may finish; display its actual receipt and never imply cancellation rolled back committed content. Save resource effects as they finish so a later provider failure or browser disconnect does not erase completed actions from chat history.

History reads reconstruct committed effects from the authoritative receipts, including when the response/SSE was lost before Go saved activity. Final assistant-message persistence must merge by operation identity or read those receipts instead of overwriting incremental effects with the final event's activity array. Extend the existing orphaned-stream recovery/history handling so a crashed `streaming` row cannot hide a committed mutation and its Undo action indefinitely. Never label an ongoing mutation cancelled merely because the answer stream ended.

### 5.2 Generation refactor

Extract a typed, kind-discriminated `MaterialDraft` and one shared creation path around the existing store functions. Validate quiz questions/time limit, flashcard cards, Mermaid content and note content using existing domain/material validators. The two entry routes adapt into that draft:

- Public Generate retains source gathering, generate-model selection, locale, billing, required user title and its current response compatibility.
- Chat `create_material` retains already-authored content, chat source provenance, title disambiguation, deterministic operation identity and the rule that accepted emitted tools do not recheck inference credits.

Do not call `/generate` from `create_material`, add a second completion, unify sharing/metadata/content routes, or permit unsupported kinds by falling through a generic map. Continue to reject empty generated output. Return one structured created-resource effect, adapting to the existing public Generate response where necessary. Old persisted activity containing the former tool name must remain readable; do not advertise two equivalent creation tools to the model.

## 6. Direct editing commands

### 6.1 Tools and supported operations

Add bounded `list_documents`, `inspect_document` and `edit_document` tools. `list_documents` discovers active sources and Plate materials by ID/name/type in the current workspace, with pagination where necessary; keep `list_sources` retrieval semantics intact. `inspect_document` reads a selected region of the current authoritative document and returns supported operations, stable target identifiers and concurrency preconditions. A model must not derive edit positions from RAG chunk numbers.

The developer selected content edits for the first implementation:

| Format | Commands to deliver | Preconditions |
| --- | --- | --- |
| Plate note/material | Insert, replace or remove identified content blocks; bounded text edits; use existing typed quiz/flashcard/Mermaid mutations for their authored content | Material epoch, stable block/relative target and expected prior content; preserve material shape, surrounding formatting and embedded assets; no image-bearing subtree replacement |
| Text/Markdown/JSON/CSV/TSV source | Bounded literal text replacement/insertion/deletion through `Y.Text` | Source epoch, authoritative inspected target and expected text; preserve UTF-8/BOM/newline rules |
| DOCX | Bounded paragraph/story text edits using BetterOffice's native operations | Source epoch/base identity, stable story/paragraph target, expected text |
| XLSX | Cell/range value and formula updates using the engine, not ZIP/XML patching | Source epoch/base identity, stable sheet/cell targets and expected values/formulas |
| PPTX | Existing shape/story text edits using the engine | Source epoch/base identity, stable slide/shape/story target and expected text |
| PDF | Refuse with `unsupported_format` and `Cannot edit PDF files.` | Check access before revealing resource format |
| Other unsupported sources/operations | Explicit unsupported result | No implicit conversion, whole-file overwrite or guessed operation |

Formatting, image/media edits, PDF body edits, Office layout or structure changes and a general scripting tool are outside this first editing contract. This includes adding/reordering sheets or slides and restructuring Office tables. Content operations preserve existing styles outside their text/value targets. Existing manual Office editing capabilities remain available. Report the supported operation set accurately so the agent can explain limitations rather than pretending success.

### 6.2 Apply through the authority

1. Go validates the resource, user operation, format and invocation identity.
2. The collaboration service opens/uses the current room, bootstrapping through its existing safe path if needed. A browser need not be open.
3. Prepare the command in an isolated candidate. Carry its operation descriptor and target guards to persistence; keep its uncommitted delta out of ordinary peer broadcast and store snapshots. Multiple operations in one document command validate together and either all commit or none do. Use stable IDs/relative positions; raw row indices alone are insufficient after spreadsheet restructuring.
4. Reconcile applicable ordinary room edits into the authoritative pre-state without discarding buffered user edits. Under the existing material lock or source checkpoint CAS, first check for an existing receipt, then resolve and validate every command target against that pre-state. A changed target refuses atomically with `stale_target`; unrelated durable changes may merge and proceed. Local-room validation alone is insufficient because both persistence paths merge other replicas' stored state.
5. Plate uses Slate-Yjs transforms with deterministic normalization and element IDs. Office commands execute through the existing worker-thread runtime using the exact base and accepted checkpoint to produce a native CRDT delta. Capture the inverse from the accepted pre-state and guards from the resulting state. After asynchronous Office work and on every source CAS retry, refresh the pre-state and rerun target validation and inverse capture. Never blindly remerge a prepared command or reuse an inverse from a failed snapshot. Attach server-owned actor provenance and apply the existing access, quota and document-limit checks.
6. Co-commit authoritative state, inverse/guards and operation receipt. Only then merge/fan out the committed delta through the normal collaboration path, preserving newer ordinary edits already in live documents. Do not replace the whole live document or overwrite `materials.content`/the published B2 source. Return the durable version; export and indexing retain their existing scheduling.

Retain current source-refresh behavior: text batches every 15 seconds; Office eligibility still uses successful prior parse, 5,000 net tokens and 60 seconds idle. The agent does not bypass owner-only manual processing. A tool result may say the edit is saved while indexing is pending.

### 6.3 Guarded Undo for direct AI edits

Add an Undo action to each committed direct-edit result, backed by a typed authenticated route such as `POST /api/chat/edit-operations/{operationId}/undo`. The route takes a new request ID; the server loads the original command and inverse. It does not accept a client-authored inverse or make an LLM call. Browser-local Ctrl/Cmd+Z and daily material revisions are not reliable substitutes for a server-origin edit receipt. No new redo feature is required.

- Only the original chat actor with current edit access can invoke this action. Recheck the originating chat, target workspace, active resource, lifecycle and storage/document limits. A revoked role or trashed target cannot bypass access through an old result card. Undo is not trash restoration.
- Record native inverse operations for affected text, blocks or cells, together with stable targets, original epoch/base and the exact post-edit target identity/content. Preserve enough original inline structure to reverse the content edit without flattening styles. Define guards for both present targets and intentionally absent targets, such as a deleted text gap or cleared cell. Immediate Undo of the AI's own deletion must work. Do not retain whole Office packages or document snapshots for this purpose.
- Per-format guard production/validation is a prerequisite of the command bridge. Current Plate equality checks and BetterOffice value projections do not provide this contract. Expose a retained native mutation identity or a bounded target/gap guard with stable parent/neighbor identities. It must detect intervening browser, remote, manual Undo/Redo and service writes, including clear/write/clear or insert/delete in the affected gap. Add the necessary native export/mutation hooks in the reviewed BetterOffice fork and equivalent Plate/text paths. Capture final guards with the inverse at commit; relative positions, value equality and whole-document counters alone do not satisfy the contract.
- At Undo, validate every affected target or intentionally empty location through the same durable command path. Reject the entire Undo with `stale_target` when a target changed, was unexpectedly removed or lost its guard lineage. Unrelated edits remain intact and must not cause a whole-document revision check to reject a valid Undo.
- Preserve question/card IDs during in-place study-content edits. A supported card removal also retains the affected `card_stats` known/SRS row with its inverse. Coordinate capture and restoration with the existing material/projection locks and affected-card study writes, preserving the latest pre-removal state and refusing conflicting ID reuse. Handle delayed, skipped and repeated projections without recreating fresh progress or overwriting unrelated cards' newer study updates. Undo of an insertion must likewise avoid discarding progress recorded after that insertion. Internal restoration does not expose SRS/known editing to the model; independent quiz attempt history keeps its current semantics.
- One document edit is one atomic Undo. Consume its eligibility and record `edit_undone` in the authoritative state transaction. If relational restoration is pending, retain its bounded payload until the projection commits it and expose the pending status accurately; a repeated projection or Undo cannot restore twice. Concurrent/double-click requests cannot reverse twice. Lost responses use the ordinary receipt reconciliation path. Never roll back the entire document to an earlier checkpoint.
- Keep inverse content separate from the minimal display/idempotency receipt and out of model input, logs and list responses. Bound each payload by the command/content limits. Charge retained inverse bytes to the existing resource owner, including transfer and reconciliation, rather than hiding another content copy in chat metadata. Distinguish accounting from admission: source checkpoint admission uses the combined net state/inverse growth, while material edits retain existing lifecycle, document-limit and shrink/recovery rules. Do not introduce `gateStorageTx` for ordinary material saves. Release inverse payload after successful Undo and any required dependent restoration, known invalidation, originating-chat deletion, resource purge or workspace/account teardown; minimal repair data needed by an already-committed projection remains until that projection settles or the target is purged. Use bounded cleanup for invalidated records; no extra product retention timer is introduced.
- Existing lineage changes invalidate affected Undo records. Office reparse/re-ingest or replacement clears them together with current Office Undo/Redo and keeps the one-current-source policy. Material compaction or trash/restore must not revive old guards. Ordinary text reindexing that preserves Y.Text lineage does not invalidate a still-valid target solely because the published index changed. Later conflicting edits make the old Undo unavailable; do not pin obsolete bases or required-to-delete assets to keep it alive.

The response and rehydrated result card distinguish available, already undone and unavailable Undo with a safe reason. Availability shown in a card is advisory until the server validates the request. A refused Undo leaves the original edit committed and gives the user an explicit message.

### 6.4 Same-turn evidence

After an acknowledged edit/trash/restore, invalidate cached outlines and editable snapshots affected by that operation. A chat Undo updates these same resource queries and pending evidence; if it occurs during a running turn, treat it as a concurrent external mutation unless that turn explicitly reconciles its receipt. Refresh the exact protected pending-source evidence before the next source-dependent call. Validate that published identities changed only as acknowledged by this turn; unrelated publication/replacement/trash continues to cause `source_changed` rather than silently resetting the baseline.

Drop or explicitly supersede previously gathered passages/results from an edited or trashed source in the active model context. Keep retained citation numbering stable for already-emitted references, but do not supply removed facts as current evidence. An acknowledged deletion of the last source must still allow a final response describing the successful action. If refreshed exact evidence no longer fits, use the existing omission/context-limit behavior and do not roll back the committed edit.

This does not rewrite historical chat answers/citation snippets or their accepted stale geometry policy. It prevents the active turn from using its own obsolete source state.

## 7. Trash lifecycle and owner control

### 7.1 Data model

Keep `files` and `materials` rows until purge. Add paired trash timestamps, deleting actor provenance and a stable identity for each trash episode. `purge_after` is set once to database time plus 30 days for each new trash episode. Pair/null constraints and due-item indexes must make invalid half-trashed states impossible. Reuse existing source epochs and material `room_schema` to fence editing; only add lifecycle state where no existing fence covers the required operation. Use the repository's current migration policy, directly extending `0001_init.sql` where the agreed no-production-data workflow still applies; do not reset any live database.

Reuse existing owner fields and workspace joins. Never make the deleting actor the trash owner. Keep current content, durable Yjs/source state, base/source blobs, required editor assets, source captions and published index references. Disposable caches may follow their existing TTL where current source/preview references suffice; restore must not depend on a cache that can expire.

Preserve retained document history subject to existing plan limits. Preserve private PDF marks with their source identity and ownership. Trashing a material does not recursively trash a workspace-shared asset used by another active material.

Reserve existing title/name uniqueness through trash for this first implementation, avoiding automatic restore renaming. Keep chapter placement while the chapter exists; existing chapter deletion unfiles both active and trashed children through its normal relationship behavior. Do not invent a fallback chapter. Restore the same resource ID.

### 7.2 Transitions

| Operation | Authority | Transaction behavior |
| --- | --- | --- |
| Trash active source/material | Current effective editor for workspace content; owner for standalone | Set trash episode/expiry, fence editing and background work, retain resource data and charges, commit receipt |
| Replay same trash request | Same authorized invocation | Return original result, preserving expiry; never trash again after an intervening restore |
| List trash | Current workspace owner or standalone owner | Return metadata only, filtered by ownership in SQL |
| Restore before expiry | Current workspace owner or standalone owner | Revalidate current episode, clear trash fields, retain charged bytes/count, reopen with fresh edit-session incarnation, commit receipt |
| Permanently delete from Trash UI | Current workspace owner or standalone owner | Require still-trashed matching episode; actual SQL DELETE and existing cascades/refcounts; commit receipt |
| Expired-item purge | Internal maintenance worker | Under the same resource locks, delete only the still-trashed matching episode with expiry reached |

Restore at or after expiry is refused even if the sweeper has not run yet. Competing restore/purge attempts serialize on the same resource lifecycle locks. An old pending purge request cannot delete an active/restored item or a later trash episode. A fresh trash after restoration receives a new episode and new 30-day period.

Use the existing workspace/account/resource lock order and clone-source advisory locks where those already coordinate deletion. Do not add a lock inversion by taking a file/material row before its workspace. Permanent deletion should work as storage recovery for an authenticated over-quota owner. Restore changes visibility, not retained byte usage: it does not require a second storage reservation or charge. Account suspension/deletion gates still apply. Keep existing content growth restrictions after restoration.

Restore processing must never reactivate a cancelled attempt or its old provider reservation. Restore ready resources from the retained published state. Preserve pending authored changes; fresh processing may follow ordinary eligible scheduling. Incomplete/cancelled ingest remains an explicit retryable file state and uses the existing user/manual processing path where supported, with new admission and billing. Do not bill a replacement ingest merely because Restore was clicked.

### 7.3 Fencing at trash time

Run cancellation and eviction when entering trash, not only at final SQL DELETE:

- Cancel source parse/ingest/refresh attempts, desired refresh scheduling and relevant replacement/import/upload work. Release their exact reservations/leases while preserving settlement of already-open provider calls. Reuse existing cancellation helpers and late-PUT cleanup grace.
- Claim, heartbeat, provider admission, final index/source publication, replacement finalization and projection retries must all reject a trashed or wrong-incarnation target. A job lock skipped during cancellation cannot allow a late write to publish anyway.
- Discard-evict active source/material rooms through the existing durable outbox. Restore uses a fresh source epoch/material `room_schema`. Recheck these fences on connect, incoming updates, direct commands and durable stores, including failed-store retry paths. Handle never-bootstrapped materials explicitly so the implicit schema-1 path cannot revive an old token; retain durable content when advancing a trash fence instead of rebuilding from a lagging SQL projection.
- A delayed old eviction event must not evict a newly restored room. Scope events and processing fences to the correct incarnation while retaining existing operation-ID deduplication.
- Source draft recovery must reject old-epoch buffered edits after restore. Preserve the existing explicit local-draft recovery behavior rather than merging pre-trash buffers automatically. Trash guarantees retained durable content, not browser edits that were never acknowledged.

### 7.4 Visibility, reads and storage accounting

Audit all callers and SQL paths, not only `ListFiles`. Ordinary active-resource access must reject trash consistently:

- Global/workspace lists, chapters, workspace/public summaries, material/library/quiz/flashcard study lists and metadata, search and Explore.
- Direct GET, content/download/preview/export, revision history, PDF marks, comments, collaboration tokens/rooms and direct commands.
- RAG aliases/search/read/describe/generation context/pending snapshots, caption/cache donor eligibility and source-refresh discovery.
- Workspace/single-resource clones, title/scope resolution, internal mutation callbacks and any metadata reorder/move paths.

Physical refcounts and storage reconciliation must still include trashed rows. Do not filter the same rows out of quota/file-count calculations just because active listings hide them. Keep the file-limit calculation inclusive on uploads, imports, clones into a target, ownership transfer and reservations. A source clone omits trash; a transfer retains trash, its charges and its original expiry and grants control to the new owner.

Separate active-resource queries from explicit internal maintenance/trash lookups. Do not change a low-level getter globally without updating its maintenance/idempotency callers. Remove trash-only donors from future reuse eligibility without deleting a payload retained by an active authorized reference elsewhere. Asset access must check a trashed material parent when the asset belongs solely to that parent, while preserving valid active/shared references.

Fresh server reads stop at the trash boundary. This does not erase already-delivered browser bytes, old signed URLs before their existing expiry, or historical conversation text. Issue no new download/preview URLs from the trash listing.

### 7.5 API and purge worker

Use the existing public delete routes as the manual move-to-trash entry points, including quiz/flashcard wrappers around materials. Update names/copy/docs so their user-visible meaning is clear. All paths call shared store operations, not handler-specific updates.

Add typed routes such as:

- `GET /api/trash` with bounded pagination and optional owned-workspace filter, returning source/material metadata, workspace identity, trash time, expiry and current trash episode.
- `POST /api/trash/{resourceKind}/{id}/restore` with expected episode/request identity.
- `DELETE /api/trash/{resourceKind}/{id}` with expected episode/request identity for permanent deletion.

The exact route names may follow existing Huma conventions, but ownership and episode checks are mandatory on the server. Unauthorized direct trash lookups/mutations return the existing non-disclosing unavailable-resource response. Internal chat wrappers use the same store functions. Do not expose a client-controlled SQL table name or arbitrary operation dispatcher.

Add a bounded due-trash sweep to the existing Go maintenance lifecycle, running at startup and periodically like the existing reaper. It performs logical SQL deletion, leaving B2 deletion to `pending_blob_deletions`. Reuse existing maintenance batch/interval conventions; the only new product retention value is 30 days. Log failures and leave eligible rows for a later sweep. Multiple replicas must not purge a restored resource or apply quota release twice.

## 8. Files and chat presentation

### 8.1 Files/Trash tab

Extend `src/routes/Files.tsx` with the existing `Tabs` component, preserving the active-files behavior and viewer dirty guard. Add a separate lazy owner-trash query; do not load every trashed record on every page open.

Render both source files and materials using existing cards/rows, buttons, badges and dialogs. Show name/title, type, containing workspace or standalone label, size, deletion time/expiry and actions Restore / Delete permanently. Clearly state that trash counts toward storage and that items expire after 30 days. Use server timestamps, locale formatting, empty/loading/error/paused states and accessible controls. A trashed row is not an editable/downloadable file preview.

Reuse the existing destructive-action dialog pattern for permanent deletion; the action is irreversible. Apply role restrictions through the owner-only API, not just hidden buttons. Show no restoration shortcut to a non-owner editor who just trashed an item. Only offer an owner a Restore action when its capability is present.

After restore/delete, invalidate owner trash, active Files, affected workspace sources/materials/chapters and existing quota/file-count queries as appropriate. Maintain row-local pending/error state and block duplicate clicks. Preserve existing query mutation retry defaults and hook destructuring conventions. Generate validators/types and re-export types through `src/api/types.ts`. Add both supported locale strings and MSW fixtures.

### 8.2 Chat results and tools

Keep current SSE transport while adopting the shared contract. Extend Python event builders, Go relay, assistant activity storage, TypeScript consumer and chat state reducer together. Emit completion for each finished tool rather than waiting for the slowest independent read solely to update its spinner; retain deterministic tool-result/citation order supplied to the model.

Display bounded created/edited/trashed/restored resource cards with status and an explicit Open action for active resources. Add the guarded Undo action and its pending/error/undone/unavailable states to direct-edit cards. Reuse `WorkspaceOpen` navigation and existing material/file viewers. Keep resource opening separate from successful commit; avoid stealing focus on every tool result. Ordinary tool cards show safe localized errors for unsupported PDF edits or stale targets.

Hydrating chat history must reconstruct effects without replaying navigation, mutations or repeated toasts. Query invalidations target affected resources; do not refetch and replace a mounted authoritative editor on every save. Preserve pending-source notice visibility and owner-only process-now control.

Expose `trash_file`, owner-only `list_trashed_files`, and owner-only `restore_file` after the lifecycle/UI are ready. The names cover both source and material resource references with a tagged target schema. The trash list tool is scoped to the current workspace and returns metadata only. It makes restore by name possible without guessing IDs. Apply the same owner check in schemas, dispatch and Go. Never expose permanent deletion to chat.

## 9. Implementation sequence

1. Establish generated tool/resource/result contracts and permission evaluation. Migrate existing tools to validation/typed results without changing retrieval or model behavior.
2. Add durable mutation receipts, refactor material creation, and deliver structured chat result rendering with `create_material` as the first end-to-end case.
3. Add authoritative document discovery/inspection, per-format target/gap guards, direct content editing and guarded Undo. Complete Plate/text first, then BetterOffice native text/cell operations and reviewed submodule pin. Each format ships with its inverse/receipt path and any dependent study-state restoration; include explicit PDF refusal.
4. Implement and verify trash state, accounting, ownership, cancellation, fencing, all read exclusions and final purge. Keep chat trash tools unavailable until this is complete.
5. Extend Files with the approved owner-only Trash tab. Connect manual delete routes, restore/permanent-delete controls, mocks and i18n.
6. Enable chat trash/list/restore tools, including same-turn evidence refresh and history rehydration. Finish documentation and focused cross-service tests.

Commit/review in coherent increments if requested by the implementation session; do not enable a partially guarded trash lifecycle. If using a feature switch for staged integration, use the repository's existing feature mechanism and remove temporary scaffolding once the complete path passes. No additional standalone services are required by this plan.

## 10. Focused verification and acceptance

Use existing test harnesses and reusable actors/fixtures. Tests must assert behavior and races, not copy registry literals. Add/update `openwiki/test-catalog.md` for tests actually added.

| Family | Required evidence |
| --- | --- |
| Contracts and permissions | Invalid tagged arguments rejected; unsupported version/tool refused; viewer gets reads only; member/link editors can create/edit/trash; only owner gets trash list/restore; forged context/cross-workspace targets rejected; restricted empty scope stays empty |
| Material creation and receipts | Both entry paths create valid quiz/flashcard/Mermaid/note content through shared persistence; chat makes no second generation call; duplicate same-key request creates once; different payload conflicts; lost response recovers; replay after edit/trash/purge never creates again; final-answer failure retains committed effect |
| Direct edits | Plate/text/DOCX/XLSX/PPTX edits persist with browser closed and appear to connected peers; another replica's target change between preparation and material/source persistence refuses with no durable or broadcast AI effect; an unrelated change succeeds and survives; CAS retries revalidate guards/inverses; duplicate append/insert applies once; projection failure reports committed state accurately; private/editor-only and quota limits hold; PDF yields normal refusal without mutation |
| Guarded Undo | Each format reverses only its edit and preserves unrelated edits/styles; immediate deletion Undo succeeds, while clear/write/clear and insert/delete-in-gap refuse; all write origins maintain guards; Undo is atomic/idempotent across reconnects; role loss/trash/rebase blocks it; text reindex preserves valid targets; inverse accounting/cleanup preserve material shrink/recovery and source net-growth rules without keeping historical Office bases |
| Study-content Undo | In-place edits preserve question/card IDs; removal/Undo exactly restores non-default known/SRS data even with delayed/skipped/repeated projection; another card's newer progress survives; conflicting ID reuse and progress acquired after an insertion cannot be overwritten by Undo |
| Same-turn behavior | Inspect/edit/read sees latest saved content; edit then generate uses refreshed exact evidence; trash then answer succeeds; last-source trash never widens scope; concurrent unrelated source publication still fails as `source_changed` |
| Trash authority/accounting | Source and every Plate material kind retain identity/content/required assets/bytes/count while trashed; editor cannot discover/restore/purge shared trash even if uploader/deleter; standalone owner works; transfer changes trash control and charge owner without restarting retention; over-quota owner can purge and restore already-charged content |
| Trash boundaries/races | 30-day boundary, replay timer, restore-vs-purge, restore/retrash vs stale purge, cancelled job finalization, replacement/import late completion, old material/source room, failed-store retry and delayed eviction all preserve the new lifecycle; clones omit trash and retain live shared blobs |
| UI | Files/Trash tabs, source+material rows, owner actions, editor exclusion, pagination/loading/error/paused states, localized copy, double-click protection, query invalidation, durable chat cards and Undo state after reconnect, no action replay on hydration |

After relevant changes run the root scripts required by AGENTS: `pnpm run fmt`, `pnpm run fix`, `pnpm run fmt:go`, and `pnpm run fmt:py` for their respective languages. Inspect formatter changes and retain unrelated user work.

Run applicable `pnpm run gen:api:full`, `pnpm run typecheck`, `pnpm run test`, `pnpm run test:collaboration`, `pnpm --filter @capy-notebook/collaboration typecheck`, `pnpm run test:go`, and `pnpm run test:pipeline:offline`. Use `pnpm run test:pipeline` with the existing Docker integration harness for cross-service storage/worker cases. Run focused Playwright scenarios with `pnpm run e2e:slow`; avoid several workers on the local machine. Execute the relevant BetterOffice checkpoint/native-command tests and `pnpm run office:prepare` after fork changes. Follow `bench/README.md` for the existing editor performance check when modifying live rendering or persistence paths; do not create another benchmark suite.

No production/UAT rollout or live provider trial is implied. Document checks that could not run and why; never present static inspection as a passing runtime test.

## 11. Documentation and completion criteria

Update the affected OpenWiki pages to describe the implemented contracts, direct content editing and guarded Undo, Files trash UI, permission matrix, quota semantics and full trash-to-purge lifecycle. Add supporting code references to the recorded human decisions after implementation. Keep public API schemas, internal protocol docs, tool descriptions and UI wording consistent.

The implementation is complete when a permitted actor can create/edit/trash through chat, each result survives answer failure and can open the correct active resource, every supported direct edit has guarded Undo, the owner can restore/purge source files and materials from Files/Trash, automatic expiry enters the existing refcount cleanup safely, and all read/write/worker/collaboration paths enforce the same trash boundary. Review must cover these connected behaviors, not merely the new endpoints.

## 12. Plan review

Completed by `gpt-6-astra` with `xhigh` reasoning on 2026-09-09. The reviewer inspected the agreed decisions and relevant repository paths without changing application code. The full report and focused recheck are saved in [review.md](review.md).

All three findings were incorporated and confirmed resolved by the same reviewer:

- R1: validate edit/Undo preconditions against the durable pre-state on every persistence attempt; isolate uncommitted commands and publish only committed deltas.
- R2: implement native guards for present and intentionally absent targets, including cleared cells and deleted text gaps, across every write origin.
- R3: preserve affected flashcard study state during supported removals and Undo, including delayed projection and concurrent study updates.

The plan also distinguishes inverse-byte accounting from existing material/source admission rules and reconstructs chat effects from durable receipts after stream failure. The focused recheck found no unresolved findings or regressions introduced by these corrections.

Handoff validation checked existing repository references, named root scripts, and `git diff --check`. Changes are limited to this plan, its review record, and the developer decision records. No application implementation or runtime tests were performed; section 10 defines the later implementation's verification requirements.
