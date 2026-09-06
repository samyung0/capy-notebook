# Collaborative source editing and incremental indexing

Implementation contract, 6 September 2026. Approved decisions are recorded under `human/`; implementation and independent review are complete in the working tree. See [implementation and verification](implementation.md) for checks and limits. Layout C is selected with the existing Tabs, a reused ProgressBar and two pending counts.

Selected design: [C with the requested changes and a PDF toolbar interaction example](https://ccjlcshrb8bj.postplan.dev). This updates the existing mock URL and needs no new layout vote.

## Agreed behavior

- DOCX, XLSX and PPTX support simultaneous editing, including the XLSX structural operations currently blocked during collaboration.
- Office saves follow Plate. Shared state persists automatically, Saved requires a durable checkpoint receipt, and Ctrl/Cmd+S flushes that same path. Leaving editing retains shared changes. Export and indexing have separate progress. Exhausted AI credits do not prevent durable saving.
- Retrieval and generation use the published index plus exact net changes through a durable editing checkpoint. Local uncommitted edits and unaccepted suggestions stay outside source evidence.
- Office automatic processing becomes eligible at 5,000 estimated tokens of net changes, then waits for 60 seconds without edits on the collaboration server. Each edit resets the idle debounce. Remove the earlier forced five-minute maximum wait. Manual processing overrides the minimum. Continued editing may indefinitely delay automatic processing and overflow pending chat context; the developer accepts that tradeoff. These are starting values for later tests.
- Text, JSON, Markdown, CSV and TSV updates batch every 15 seconds with no minimum. Continuous typing must not postpone a batch indefinitely.
- Keep at most one immutable job per file and one coalesced desired checkpoint. Editing stays available during processing. If edits arrive after the captured checkpoint, postpone base replacement until a fresh idle checkpoint is processed. An older result must not replace the base, clear Undo/Redo or overwrite newer edits.
- Pending changes reserve input space and stay outside both live chat compaction and conversation checkpoint summaries. Raise the chat effective input ceiling from 200,000 to 250,000 tokens while retaining the selected model's own window, output allowance and calibrated margin.
- If pending changes cannot fit, show a chat information label offering to process file changes and warning that some information may be outdated. Keep exact changes durably, without a lossy summary. Explicitly identify omitted pending evidence to the model as well as the user.
- Visual changes produce typed placeholders rather than earlier parsing. An agent tool can resolve a supported image into a cached caption. Hyperlinks remain text.
- The workspace owner funds automatic reparse/reindex. Both workspace switches default to true. Automatic reparse requires a successful earlier parse, including a manually triggered first parse.
- Historical chat citations retain their snippets and boxes after re-ingest, accepting inaccurate geometry without a source-changed notice. The overflow notice above concerns current pending context, not historical citations.
- Native PDF text highlights, rectangles, ellipses and an eraser are private overlays. The toolbar appears below the document cursor or above when space below is insufficient, and disappears without document focus/cursor placement. Highlighter changes pointer mode, applies marks during selection and toggles an existing selected highlight. Pressing Eraser immediately removes marks from an existing selection; without a selection it enables pointer erasing. Downloads, AI evidence and material collaboration retain their existing behavior.
- Deletion cancels source processing. Cloning reads an available published source/index snapshot without waiting and does not copy pending changes or their work.
- Retain the current file's transformation caches, without dedicated retention of original-version caches for re-upload. Identical image/audio bytes reuse SHA-keyed captions/transcripts across prompt-version changes. Image captions also survive surrounding-context changes.
- When a completed Office refresh safely promotes B as the current source and collaboration base, clear Undo/Redo for every editor. Retain no original source or deleted package parts solely for historical Undo. The durable target is one current source, one current ingest-cache set and eligible shared captions; old and candidate objects may coexist temporarily until successful publication and reference cleanup.
- Caption reuse is authorized by the current containing workspace/material. Private workspace reuse stays within the workspace; link/public workspaces allow global reuse. Private standalone material reuse stays with the same owner; link/public standalone material captions allow global reuse.
- Cache payloads share physical storage. Visibility changes update reuse eligibility without moving or duplicating payloads; authorized reuse and clones attach resource references. Existing expiry and cleanup still apply to optional caches.
- Generate image-only captions directly. There is no production data or database, so no compatibility or legacy-caption migration is needed.
- Simple and detailed summaries use the complete current document. Durable source bytes belong on B2; ingest-worker copies are temporary.

## 1. Fork contract and shared state

Keep the existing Yrs collaboration architecture. Capy supplies authenticated transport, database durability, lifecycle checks and billing. The fork supplies document semantics and deterministic export.

A small headless adapter needs three operations over an immutable checkpoint:

```ts
compare(baseBytes, indexedCheckpoint, currentCheckpoint): NetEffect[]
resolveAsset(baseBytes, checkpoint, objectRef): { bytes, mimeType, sha256 }
exportOffice(baseBytes, checkpoint): Uint8Array
```

Every checkpoint binds format, schema/epoch, exact base-package SHA and complete durable shared state. A net effect identifies the stable object, before/current content and locations, and whether it is added, replaced, removed, moved or visual. Locations are labels, not identities. The comparison represents net effects, not cumulative keystrokes or an LLM-written history. Successful base replacement now clears Undo/Redo by explicit developer decision. This permits a simpler coordinated fresh seed from B; no historical package-binding or deleted-part sidecar is required solely to preserve Undo. Changing the base is a versioned handoff, not an unguarded `open(B)` followed by merging old shared state.

Capy formats effects into concise text, owns file/checkpoint IDs and token budgets, schedules work, and authorizes image resolution. The fork has no knowledge of B2, chat prompts, model tools or workspace billing. Browser dirty events can invalidate a projection, but the accepted durable state remains authoritative.

### XLSX critical path

Current cells use positional `row:col` keys. Row insertion rewrites cells and references. Merges, hyperlinks and charts contain whole-collection values, and defined names are not fully shared. Removing the collaboration guard cannot make those structures converge.

Use stable sheet/row/column identity with a sparse representation of unchanged base axes. Bind cell edits, formulas, ranges, merges, hyperlinks, names, chart data and drawing ownership to those identities. Independent additions need independently addressable records. Preserve source-part ownership so a fresh headless replica can export the same opaque OOXML parts after sheet deletion or reordering.

Prototype collision behavior before completing the schema: independent inserts survive; deletion targets the row/sheet seen by its author; same-target updates follow deterministic shared-state ordering; duplicate sheet names receive stable suffixes, overlapping merges keep one deterministic winner and concurrent deletion of every sheet retains one sheet, as explicitly selected by the developer. Resolution must not depend on delivery order. Test undo after remote structural changes. Do not silently redirect formulas to whichever cell inherited an old coordinate. With no production shared documents to migrate, introduce the new schema directly and reject mismatched protocol/schema inputs.

"Full structural collaboration" covers the existing editor's supported single-user operations. Existing serializer refusals for unsupported pivot/custom-part references remain until the fork can preserve those parts correctly. Supporting every Excel feature is a separate scope.

The vendored pin is `71524815b5b4704fa72a34ef0d9a3310fc21e1dd`; the separate `evo-office` checkout is `fc25f8930c23bca449af5df82de2a564c3b0913a` and has existing PoC edits. Reconcile the intended checkout with the pinned fork before implementation, preserving other work.

### DOCX/PPTX and assets

PPTX already has headless restore/export and media access. Enforce exact source SHA when restoring; do not use a source-less fallback on mismatch. DOCX's complete save path includes TypeScript projection plus its Rust writer, so a Node/WASM adapter reusing that path is smaller than writing a second serializer.

Check actual toolbar image insertion through export and reopen. Static inspection found a suspected DOCX seam: insertion assigns a nonempty temporary relationship ID, while the serializer imports new image bytes only when that field is empty. This is a test target, not a confirmed runtime failure.

Current DOCX inserted image bytes live in shared embeds as data URLs. Existing Office images can be read from package relationships and media parts. B2 insertion is not required for extraction, but any future external asset must be durable before Saved is acknowledged. XLSX and PPTX do not currently offer the same image-insertion UI as DOCX; their existing media can still be resolved.

## 2. Durable source editing

Extend the collaboration service with explicit source room types. Reuse Plate's bootstrap lock, token/origin validation, eviction, contributor attribution, checkpoint receipts and quota/lifecycle checks. Material roots, serializers and permissions are not reusable unchanged. Source editing keeps the current explicit workspace owner/editor scope.

Plain text formats can use Y.Text with a raw-source edit view inside the existing viewers. CSV/TSV retain their table preview. Never seed from a truncated preview or round-trip raw JSON/Markdown through rich-text conversion. Apply text operations with proper selection, undo and IME handling. Preserve encoding/newline behavior instead of silently normalizing downloads.

The durable editing state and the published read projection are separate. Ordinary background metadata refetches must not remount a mounted editor. Recoverable save failures leave the draft present. Editing stays available throughout the long processing stage. Successful Office refresh has an explicit coordinated base handoff and clears Undo/Redo. Neither idle detection nor clearing an undo stack proves that every client has delivered all its edits.

## 3. Published snapshots, jobs and cloning

Track the active editing epoch/base, latest durable checkpoint, published source/preview/index checkpoint and processing checkpoint separately. The published snapshot owns the source bytes, preview and canonical index that agree with one another. Build candidates without replacing the readable alias.

Once an Office file reaches the net-change threshold, start/reset the server idle timer on edits. Admit a fixed durable checkpoint only after the idle interval. Editing remains available during processing. Any newer accepted edit makes the candidate ineligible for base replacement. Coalesce the latest desired state and process a fresh checkpoint after another idle interval, with at most one running job. Discard a stale candidate's unneeded source/cache references through ordinary cleanup; retain the working base, index, exact pending effects and Undo/Redo. Reuse existing cancellation at supported stage boundaries to avoid unnecessary stale work; an already running stage that cannot stop safely may finish, but its stale result cannot publish. If edits reduce net changes below eligibility, wait for eligibility or manual processing rather than forcing another automatic job.

For the simplest fresh-seed handoff, publication requires the processed checkpoint to still equal the latest durable state. Validate file existence, editing epoch, attempt lease and that exact checkpoint under the existing transaction/room coordination. Flush and acknowledge connected-client buffers at the handoff boundary and reject a raced newer write before replacing the room. Atomically publish B with its matching preview/index and new shared seed, then clear old-epoch Undo/Redo and pending effects now included in B. A stale checkpoint must not erase newer content. Failed or superseded processing leaves the current source, shared state and Undo/Redo intact.

Fresh seeding changes the editing epoch. Reconnecting clients must compare that epoch before submitting buffered updates; never merge old-epoch CRDT bytes into the new seed. A client with unacknowledged edits must retain them locally and enter explicit recovery instead of silently replacing its buffer. Recovery retains actor-specific local drafts and provides draft download; clearing Undo/Redo authorizes discarding history, not discarding authored unsaved edits. No-socket/idle detection alone proves neither client convergence nor absence of a disconnected draft.

For text formats, the 15-second full-source reindex path retains its shared Y.Text lineage and can publish an older fixed checkpoint while preserving exact remaining effects. If a user changes A to B, the job captures B, and the user undoes to A, publishing B retains B-to-A as pending. Deleting all edits older than a sequence number is insufficient. The Office Undo reset decision does not silently reset text editing every 15 seconds.

Clones take the last published source/index snapshot in one transaction and start a new editing history from those bytes. They do not copy live Yrs state, pending effects or queued refreshes. Sources undergoing refresh remain cloneable through their last successful projection. A never-indexed source can clone its existing published source bytes without starting a first parse implicitly.

The full exported source is uploaded to B2 under its own candidate object key. Incremental retrieval does not require patching an OOXML ZIP or a B2 object. Export alone does not alter the active room; only the successful coordinated refresh handoff replaces its base. Downloads should export the requested durable checkpoint if the current binary projection is behind; doing so need not trigger parsing or clear Undo/Redo.

Current replacement already creates a fresh `sources/<blob-id>` key, then swaps `files.blob_path`. Existing blob references retire the old key when no file/clone needs it. B2's latest-version lifecycle applies to multiple versions under the same object name; it does not delete the current version of a separately named, still-needed base object. Extend existing references to cover the active Office base, published snapshot and in-flight job. The source hash is recorded metadata, not a capability that disappears when an old object is deleted. Retain no old transformation-cache ownership solely for possible future re-upload.

Reparsing identical source bytes does not change their SHA. Exporting edited source bytes does. During processing, old A and candidate B must coexist so a failed job cannot destroy the working file. After a successful handoff, B serves both current published source and collaboration base. Release A and its old transformation-cache associations when their remaining job/clone references permit cleanup. Any surviving clone owns its own references; deleting A globally while a clone needs it would violate that ownership. There is no permanent original-file archive or old-part retention solely for Undo. One current ingest-cache set can contain several physical artifacts, and shared state, previews and indexes still consume storage; the decision does not imply one B2 object or zero temporary overlap.

Turning off an auto switch prevents further automatic job admission while retaining pending state. Already admitted work can finish under its existing lease. Existing bounded retry/backoff remains; disabled settings or exhausted credits do not create a polling loop.

## 4. Incremental text indexing

The 15-second window schedules one fixed full source version; the ingest worker normalizes, chunks, embeds and publishes it. Heavy processing stays off the collaboration event loop. Here "snapshot" means the normal updated source file in B2. The database records its object key/SHA/checkpoint and the worker downloads a temporary job copy. There is no permanent snapshot store on the ingest host.

Use the same full-file ingest flow as Office with the parse stage skipped. Run the existing normalizer/chunker over the complete source. The published index already stores old chunk inputs and vectors, so exact-input vector reuse needs no extra permanent source snapshot: compare effective model input plus the immutable embedding pin and embed misses. Keep reuse only if it stays a small lookup inside this path. The approved simpler option is to embed the full file, with the same B2 source and atomic publication, rather than add a dirty-range planner or a second snapshot system. Changed lexical metadata and positions are rebuilt from the current full source.

One edit does not always map to one old chunk. Packing and overlap move boundaries; heading changes affect a section; CSV header changes affect every row, and row insertion changes current row labels. Re-chunking avoids a new dependency/invalidation graph while still reducing embedding calls.

A local, provider-free reproduction confirmed that the current canonical hash omits heading context: `# Biology` and `# Chemistry` over the same body produce different embedding inputs but the same content hash. Correct canonical identity as part of this work, otherwise ready-content reuse can bypass embedding entirely. Compare exact indexed input, not body text alone or old chunk ordinals.

Generate both the short descriptor and detailed summary from the complete current document, never from the diff or the old summary plus edits. This is already the intent of `summarize_file`, which reads all current chunks. Use one whole-document call where it fits. Its existing large-document path covers all chunk groups and combines their summaries when the selected model's window is insufficient. Preserve complete-document coverage and budget prompt/output overhead; do not silently truncate the file. The full-document summary cost remains even when vectors are reused.

## 5. Exact pending evidence and context budgets

Capture durable source versions consistently for an answer. Include all scoped pending effects in a protected evidence section where they fit, including files that had no old search hit or no index yet. Search/list/describe/read and generation share the same assembly logic. Corrections and deletions explicitly supersede older facts.

Keep pending bodies outside ordinary tool-output clipping and outside summarized conversation history. Current tool output is capped at 8,192 tokens, and the paged renderer only includes its first text part; appending a footer would lose changes. Tools can reference the captured source version while one exact protected section avoids duplicating the full payload on every call.

Budget the complete provider request, including system instructions, tools, current query and output/thinking allowance. Reserve pending evidence before selecting ordinary passages and compacting prior conversation. Both live compaction and durable checkpoint generation must exclude the pending bodies.

The repository's seeded text models have windows above 250k, but operators can select other models or margins. Keep those actual limits. Current 200k is an admission ceiling as well as a compaction trigger; simply changing the constant does not solve preservation or overflow.

If the exact changes cannot fit, preserve them in storage and give both the model and chat a specific indication that some pending evidence is absent. Show an information label such as "Some file changes have not been processed. Information may be outdated." with "Process file changes" using the existing manual processing path. Do not silently label the old index as current. New pending evidence has logical file/location provenance, without fabricated old parser boxes.

Generation has no chat label, so its response must carry the same outdated-source state for its UI; the decision above does not authorize silent loss of pending evidence in generated study materials.

## 6. Caption resolution and cache ownership

The model requests an authorized `file + checkpoint + change/object reference`, or a supported editor-asset reference. The server authorizes the target, resolves its current image bytes, computes SHA and checks eligible caption associations. A SHA match by itself grants no reuse permission. On a miss, call the captioning slot. Image bytes are sent internally to the caption model, not generated by the agent as a tool argument. Recheck that the result still belongs to the same image before replacing its stub. Failure retains a resolvable placeholder.

An interactive resolver uses the existing calling chat actor's spend session; owner billing applies to automatic background processing. Keep attribution separate from the owner payer on automatic jobs.

Caption input contains the image alone. Remove page and surrounding-text input from figure prompts. Supply surrounding chunk text at retrieval. There is no production data or database, so implement this rule directly without legacy entries, migration or backwards-compatibility branches.

Use a shared caption object store with one association table owned by exactly one source file or editor asset, with image SHA and caption object pointer. Reuse existing blob reference counting for B2 caption objects. Authorized reuse creates another reference to the same payload. Visibility changes perform no payload copy, move or regeneration. The SHA lookup can return multiple candidates: unrelated private scopes with no eligible donor must be able to generate independently without reading or overwriting each other's captions. A single globally accessible caption per SHA would bypass the approved private-reuse rule. Physical storage sharing does not grant access by hash.

Reading an authorized file/image permits reading its attached caption while that caption is available. Merely possessing another image with the same SHA does not grant access to a private donor's caption. A caption not yet generated, an optional cache write failure or expired/unreferenced cache can still produce a miss; "shared store" does not mean unconditional permanent retention. Reuse must preserve existing required-source versus optional-cache failure behavior.

Derive candidate eligibility from live parent joins: same target workspace, same owner for two standalone materials, or an eligible currently shared holder. Workspace material visibility comes from its workspace; standalone material visibility comes from its own privacy field. Prefer an eligible local candidate, then an eligible shared candidate. Return caption content without donor names or source metadata.

Changing private to link/public makes live workspace associations globally reusable without a captioning or cache-promotion job. Returning to private stops new global reuse from that holder. Another currently shared copy can still supply the caption. Copies obtained with authorization retain their own associations when the original changes visibility or is deleted. This uses current visibility, never an "ever public" flag.

Perform ordinary hash-based reuse validation and destination attachment in one short transaction, following existing lock order and excluding model/B2 calls from the transaction. Recheck live target identity and donor eligibility at attachment. A caption finishing while visibility changes attaches to its current target; global eligibility is then derived from live ownership.

Authorized clones copy the caption associations of the chosen published source snapshot alongside existing file/asset maps. This is a permitted content transfer, separate from private-cache discovery by hash. It adds no wait for live collaboration and no caption provider call. New clone-owned associations preserve their own privacy and object references.

Apply the same rule to whole-file donor reuse. `find_ready_donor` currently searches ready matching source hashes across all workspaces, and donor chunks already contain captions. Gating only the direct caption lookup would leave a bypass through copied chunks and summaries. Require an eligible live holder and recheck during transfer for caption-bearing donors. If marking caption-bearing content adds machinery, restricting ordinary donor discovery to same-workspace or live shared holders is the simpler implementation. Explicit authorized clone copies retain their separate path. This image-caption policy does not silently change audio transcript reuse.

Office media and MinerU images are not guaranteed byte-identical. Office ingestion converts to PDF, then hashes the parser's extracted images/crops. Cropping or re-encoding gives different bytes and a different SHA even for a visually similar image. Reuse identical bytes; do not invent hash aliases or fuzzy image matching. Stable source-to-parser asset mapping could be added later if measured misses justify it.

Current checkout work has already removed prompt versions from image/audio cache keys. Build on those edits. Replace unscoped image-caption lookups with current file/asset associations and exact image SHA matching. A source-file SHA change no longer prevents reuse of eligible unchanged images. Keep audio's existing content identity policy unless separately changed.

Retire obsolete transformation cache ownership when the current version changes, while protecting other files/clones and running jobs through references. The Office base is authored source state until the coordinated refresh handoff. That handoff makes B the base and clears Undo/Redo, allowing the original base reference to be released. Merely writing a new index or clearing a client undo stack is not enough to release a base still used by the room.

## 7. Workspace settings and PDF overlays

Use selected layout C with the existing `Tabs` component, matching A's standard tabs. Extend and reuse the existing `ProgressBar` to display the three segments. General reuses name/description/tags/color editing. Sharing reuses existing visibility, link and member controls. Indexing displays logical source counts from the server:

| Category | Definition |
|---|---|
| Indexed | A published searchable alias exists, including sources with newer pending or failed refreshes |
| Not indexed | The format has a supported indexing route, but no published searchable alias exists |
| Not indexable | No supported extraction/indexing route exists for the format |

The categories are disjoint. Use one denominator and a rounding method that sums to 100%; show an empty state when there are no files. Uploading with parsing disabled does not turn a supported format into a nonindexable one. Show exactly two separate pending count rows, reparse and reindex, without filenames. Include below-threshold pending changes in the counts. Record successful parse history independently of current status and expiring cache pointers.

PDF annotation rows belong to an author and logical file, with page-normalized geometry and source identity. Rendering accounts for page rotation and zoom; text selection can store multiple highlight rectangles. Keep annotations separate from citation overlays and source content. The floating controls expose highlight, rectangle, ellipse, eraser and color.

Anchor the toolbar below the current document cursor/last placement, above if there is insufficient space below, clamped to the visible PDF viewport. Hide it when document focus or cursor placement is absent. Clicking toolbar controls must preserve the document selection/focus rather than dismissing the controls. It does not stay pinned to the page bottom or chase the pointer while the user moves to click a tool.

Highlighter sets a distinct pointer mode; selecting text applies highlights. Clicking Highlighter with an existing selection toggles that selection: if the whole selected range is highlighted, remove its mark, otherwise highlight the range. Preserve partial and multi-line selection geometry. Clicking Eraser with an existing selection immediately clears the author's marks in that selection while preserving the source text and unselected portions. Without a selection, Eraser enables a distinct pointer mode and removes the author's marks under a click/drag; rectangle and ellipse use pointer drags. Apply ordinary source read access and author ownership checks. The HTML mock demonstrates interaction with whole words; application behavior uses exact PDF text ranges.

## Work order and verification

1. Reconcile the fork checkout, prototype XLSX stable topology/reference behavior and prove fresh-replica export. Reuse and extend existing convergence/undo/preservation tests.
2. Add the shared compare/asset/export adapter and validate DOCX image insertion and complete headless saves. Bind every restored session to its exact base.
3. Add source rooms and durable receipts, pending projections, snapshot scheduling and atomic promotion. Preserve mounted editors and old readable indexes.
4. Add exact-input embedding reuse, correct canonical hashing, common pending context, overflow status/action, caption resolution and cache ownership.
5. Add settings/counts, the selected settings layout, raw-source editing and private PDF overlays. Use existing components and translations.
6. Update OpenWiki and the test catalog to describe implemented behavior, then run the relevant root test scripts and formatting commands. Large completed implementation receives independent review under the human workflow.

Focused checks cover concurrent row insertion versus cell/formula edits, structural undo, out-of-order/duplicate updates, fresh restore/export, equal modeled workbooks with different package bytes, embedded-image extraction/save/reopen, IME with remote text edits, heading and CSV-header changes, exact-input vector reuse, idle debounce without a maximum-wait trigger, failed/stale refreshes retaining Undo/Redo, editing during processing deferring base replacement, successful base replacement resetting Undo/Redo, late old-epoch reconnects retaining unsaved buffers, deletion before publication, clone without pending state, pending-only retrieval/generation, preservation through both compaction paths, explicit overflow status, and private annotation access/geometry. Measure sparse-workbook memory and chunk/export latency at the existing source-size limits.

No new broad smoke suite, extra retry framework, binary patch store or alternate XLSX sequencer is needed for this plan.
