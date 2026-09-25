# XLSX editing state: store overrides, not cells

Date: 2026-09-25. Engine: `vendor/betteroffice` at `origin/capy-ci` = `dfa3f05e` (schema 7).
Nothing in the repository, the submodule or any live service was changed. The prototype lives
in a scratch worktree, now removed; its patch and probes are kept in
`scratchpad/xlsx-lazy/` (see "Method").

## Answer in one paragraph

No, Capy doesn't need Yjs state for every cell. Nothing in schema 7 depends on it. A cell's
stable identity is already a pure function of its source row and column, formula bindings can
be recomputed from the source, and structural edits never touch cell entries. I built a lazy
prototype of about 200 lines in `stable.rs`. The seed writes only the workbook skeleton, edits
write per-cell overrides, and the projection lays overrides over the parsed source package the
engine already holds. All 211 tests of the two XLSX crates pass on it, and a differential
script gives identical model and export digests against today's engine at every step. The
100k-cell workbook's first Edit open drops from 70.9 MB charged to 0.82 MB, its refresh peak
from 172 MB to about 7 MB, and a checkpoint save in WASM from about 66 s to about 2 s.

## Recommendation

1. **Lazy XLSX state (schema 8).** Seed only the skeleton (meta, sheet order, per-sheet
   containers, axis catalog, merges, links, charts, freeze panes, defined names, dimensions,
   formats catalog). `contents` and `styles` hold overrides keyed by the existing stable
   identity. A missing key means "the source cell". A cleared source cell stores an explicit
   empty value (`{"value":{"kind":"empty"},"formula":null}`) or an empty style key `""`.
   Writing a value equal to the source removes the override. Projection lays each source cell
   through the live axes, skips the halves an override replaces, then applies overrides.
   Source formulas bind once per session against the bootstrap topology and resolve against
   the live one.
2. **Pending effects from overrides, and no stored XLSX baseline.** Before the first
   publication the Yjs base is the uploaded file, which is what the index was built from.
   After a publication with the rebase in point 3 it is the published export, which is again
   what the index was built from. So "what changed since indexing" is exactly the overrides
   plus the active row and column changes. The engine computes effects from them in about
   0.1 s for 10,000 overrides (native). The service stores the 44-byte
   `{"entries":[],"format":"xlsx","version":1}` in `indexed_baseline`, so Go, the migrations
   and the pipeline stay unchanged. This makes the 2026-09-25 XLSX baseline decision (short
   ids, no default `:format` entries) unnecessary.
3. **Rebase publications as overrides over the published export.** When edits land after the
   capture, re-express the latest workbook as overrides over B: replay the post-capture row,
   column and sheet changes from the aliases `rebase_aliases` already computes, write an
   override for every cell that still differs, then verify that the result projects to the
   latest model and fail the publication explicitly if it doesn't. This deletes the
   `xlsx:rebase` parts overlay (the whole changed worksheet XML, +5.2 MB at 100k cells), the
   rezip and reparse on every open, and the aliased indexed state. Point 2 depends on it.
   With today's overlay the Yjs base is the latest export, not B, and override effects would
   miss edits made while the candidate was parsing.
4. **Keep today's source binding** (SHA-256 of source SHA and the parsed-model fingerprint) in
   this change. With lazy state the binding is the only guarantee that every replica projects
   the same unedited cells, and it already covers every cell. A parser change still orphans
   saved rooms (see open question 3 for the alternative).
5. **Ride the planned seed-changing reset.** Schema 8 changes the seed. Publish pending edits on
   the old engine, deploy, bump the epoch and drop XLSX states in one statement, and let rooms
   reseed on next open. Accept only schema 8, like the PPTX decision. Reseeding now writes
   about 3.6 KB per workbook.
6. **Worth adding to the same schema bump, not required.** Short identity keys and plain-text
   effect values halve the effects (see "Smaller savings").

A side effect: the engine's 64 MiB state cap (`workbook.rs:52`), which today stops these
sheets from being edited at about 250k cells (270 bytes each; the handoff review measured about
490k on smaller cells), would bound edited cells (about 530k numeric overrides) instead of
workbook size.

Estimated effort: about a week of fork work plus a day on the Capy side (details in Q6).

## Open questions for the developer

1. **Concurrent clear against set of a source cell.** Today the set always wins, because a
   clear deletes the map key. With lazy state, clearing a source cell writes a marker, so the
   two writes resolve by client-id order. Both are deterministic and convergent; I measured
   both orders (below). Accept that, or keep "set wins" with a separate per-sheet `cleared` map
   (one more container, a little more code)?
2. **Structural effects.** One inserted row at the top of the 10k-cell sheet makes today's
   pipeline store 9,991 pending effects (8,991 "move" and 999 re-rendered formulas), 2.51 MB
   of jsonb and 162,668 net tokens, which alone triggers an automatic reparse on the owner's
   credits. Override effects give one entry (94 bytes). Should structural changes be
   summarized as one effect per inserted or deleted run (with deleted cells' old text listed),
   even though the chat evidence and the auto-refresh token count change with it?
3. **Parser-tolerant binding.** Bind to source bytes plus what the bootstrap writes plus the
   occupied cell coordinates, and make the formats catalog and dimensions lazy too. Then a
   parser change that only alters cell values, formulas, styles or sizes no longer orphans
   saved rooms (upstream `57980319`, `dfb5c824`, `b56efb33` and `0c5c4fcf` look like that kind
   of change; golden seed tests would confirm it), and unedited cells show the new parse. The
   price is that a deploy must still bump XLSX epochs so two engine versions never share a
   room, and overrides lose their protection against a changed base. Want this, now or later?
4. **Format-only effects.** Formatting a 10k-cell range adds 10k visual effects and 10k net
   tokens today, and would with overrides too. Summarize per range, or keep per cell?
5. **Order against the upstream merge.** Land lazy state first on `capy-ci` with its own reset,
   or as a commit on the upstream-merge branch so one reset covers both? Resets are cheap while
   there is no production data.

## Q1. Where the bytes go today

### Stored state, per cell

Exact walk of the seeded `cells-10k.xlsx` state (2,666,476 bytes). Each Yjs item's update-v1
length was recomputed from the `Item.write` rules and the sum matches the state to 12 bytes
(client header and empty delete set). Source: `scratchpad/xlsx-lazy/breakdown.mjs`.

| Part | Items | Bytes | Per item |
| --- | ---: | ---: | ---: |
| `contents` entries | 10,000 | 1,997,776 | 199.8 |
| of which item info byte + parent id (parentInfo, 7-byte client varint, clock) | | 100,000 | 10.0 |
| of which map key (length byte + text) | | 558,900 | 55.9 |
| of which value (Any header, string length, JSON) | | 1,338,876 | 133.9 |
| `styles` entries (50% of cells are styled here) | 5,005 | 665,105 | 132.9 |
| of which header / key / value (3 + 64 hex) | | 50,050 / 279,720 / 335,335 | 10 / 55.9 / 67 |
| Everything else (formats catalog 2,418, col widths 390, containers and meta) | | 3,595 | |

- Per cell: 199.8 + 0.5 x 132.9 = **266 bytes**. A first write carries the parent reference
  and the key, so there are no origin bytes.
- The key is `[{"run":"base","offset":R},{"run":"base","offset":C}]`, the JSON of the stable
  identity (`stable.rs:32-36`), 55 bytes for five-digit rows.
- The value is the JSON of `Content` (`stable.rs:345-350`). By kind: number 56.4 bytes, text
  68.6 bytes, formula **764.5 bytes**. A formula stores its full binding record per reference
  (`Binding`, `stable.rs:125-146`: original range, flags, spans, prefix, suffix, sheet key), so
  the 10% of cells with `E2*F2` hold 57% of the value bytes.
- The style value is the 64-hex SHA-256 key of the canonical `CellFormat` JSON
  (`authority.rs:2759-2764`), the same key as the formats catalog entry.
- Every cell is written by the bootstrap (`stable.rs:658-672` calls `write_cell` for each).

### Stored baseline, per cell

`officeBaseline` of the same seed, 4,255,767 bytes, split by field (`breakdown.mjs`):

| Entry | Count | Bytes | Per entry | id | kind | label | value | position | braces, commas |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| text | 10,000 | 1,957,657 | 195.8 | 81.9 | 13 | 20.9 | 48.1 | 24.9 | 7 |
| `:format` | 10,000 | 2,297,830 | 229.8 | 88.9 | 15 | 31.9 | 74 | 13 | 7 |

- Per cell: **425.5 bytes**. The id is `sheet:0:` plus the identity key with 12 escaping
  backslashes. The text value is `=formula` or the canonical value JSON
  (`{"kind":"number","value":1001}`). The format value is a SHA-256 hex of the resolved format,
  written for every cell, default-styled ones included (`office-checkpoint.ts:426-447`).
- At 100k cells the same layout gives 27,019,546 bytes of state and 43,071,623 bytes of
  baseline, the 270 and 430 bytes per cell in the storage report.

## Q2. Why every cell is seeded, and what actually needs it

Nothing needs it. The per-cell seed comes from upstream's schemas 3-6, where the Yjs document
is a full copy of the workbook (upstream `seed` calls `sync_sheet`, which writes every cell as
`row:col`). Schema 7 swapped the keys for stable identities and added formula bindings but kept
the full seed. The fork already reads some data from the source instead of Yjs
(`SheetFallbacks`, `authority.rs:2814-2822`), upstream keeps column styles and tables as
"read-only reference data, not shared state", and the 2026-09-25 PPTX media decision applies
the same rule to media.

| Feature | Needs every cell in Yjs? | Evidence |
| --- | --- | --- |
| Concurrent edit resolution | No. Each cell is a map key with last-writer-wins; an override's first write creates the key. | `stable.rs:568-612` |
| Stable row and column identity, structural edits | No. An identity is `(run, offset)` per axis; a source cell sits on the `base` run at its source row and column. Insert and delete write one `Change` to the catalog and an active flag, never a cell. | `topology.rs:56-272`, `stable.rs:1198-1231` |
| Formula binding across inserts and deletes | No. `Formula::bind` is a pure function of the text and the bootstrap context; the prototype binds source formulas once per session. | `stable.rs:148-248`, `stable.rs:249-343` |
| Merges | Not per cell. One `base:{i}` entry per merge. | `stable.rs:683-691` |
| Undo | No. The undo scope is the sheet maps; undoing a first override deletes it and the source value shows. | `authority.rs:1666-1691`, `stable.rs:1394-1413` |
| Fingerprint and bootstrap-writer checks | No. They read `meta` and the 15 container items per sheet, which the lazy seed still writes. | `stable.rs:790-846`, `authority.rs:403-419` |
| Materialize | Reads Yjs today, so it must lay the source under the overrides instead. The engine already holds the parsed model (`Workbook.source_package`, and the model `from_source` receives). | `stable.rs:931-960`, `workbook.rs:262-343` |
| Remote validation | No. Today each staged update hydrates a full copy of the state (`authority.rs:740-742`, `852-854`), so lazy state makes it cheap. | |
| Rebase | Works unchanged in the prototype, but stores an O(N) parts overlay. | `workbook/rebase.rs:227-307` |
| Agent locate and inspect | Locate returns the `contents` path of the edited cell, which exists once the edit lands; the guard reads that key's item chain. Inspect reads the model. | `office-checkpoint.ts:937-954`, `editCommands.ts:909-947` |
| View export | Reads the model. The prototype's exports are byte-identical. | `office-checkpoint.ts:955-956` |

## Q3. The design

### Data

- Roots and per-sheet containers are unchanged, so container identity checks and the undo
  scope need no change.
- `contents[identity]` is an override of the source cell's content; `styles[identity]` of its
  style. For cells outside the source (inserted rows, added sheets, cells the source didn't
  have) an entry is simply the cell, as today.
- Clearing a source cell writes the empty marker; clearing a non-source cell deletes the key.
  Setting a source cell back to its source value deletes the override (`write_cell` in the
  patch: plain values compare directly, formula cells keep the override).

### Materialize

For each active `sheet:N`, the prototype iterates the parsed source sheet once, maps each
cell's `(base, row)` and `(base, col)` through the live axes (`Axis::index_in`, O(spans)),
skips deleted rows and columns, skips content or style halves that have an override, and
resolves source formulas from the per-session bindings. Then overrides apply as today, now
keeping an existing style when content arrives. Hidden source sheets still resolve their
formulas, as their seeded copies had to, so a workbook with an opaque formula still refuses
structural edits exactly as it does today. Source style indices map through the formats
catalog the same way seeded style keys did, so models compare equal.

### Formulas in unedited cells under structural edits

The binding is computed against the same context the bootstrap uses today (keys `sheet:i`,
source names with the same duplicate suffixes, untouched axes) and resolved against the live
context. That is the computation the seed and projection already do, just not stored. The
differential script inserts two rows, deletes a column, undoes and redoes, deletes three rows
and merges cells on a sheet whose column G is `E*F` on every row; models and exports match
today's engine at every step.

### Concurrency and undo

Overrides use the same map keys, so concurrent edits of one cell resolve as today. Only a
concurrent clear and set of a source cell changes, because the clear is now a write, not a
key deletion.

| Engine | Clear by client 201, set by 202 | Clear by 302, set by 301 |
| --- | --- | --- |
| Today | `set` on both replicas | `set` on both replicas |
| Lazy prototype | `set` on both replicas | empty on both replicas |

(`race_probe.rs`.) Undo needs no change. Undoing an override deletes its item, undoing a revert
restores it, and the stable suites' undo, redo and peer-undo tests pass.

### Rebase and publication

- No edits after the capture: the new state is the lazy seed of B, 3.6 KB.
- Edits after the capture: today's overlay still works under the lazy engine (tests pass;
  measured 514,806 bytes of rebased state at 10k cells after 100 later edits, almost all of it
  the uncompressed worksheet XML). The recommended rebase re-expresses the latest model as
  overrides over B:
  1. `before` = A + captured, `current` = A + latest, `aliases = rebase_aliases(before, current)`
     (existing code).
  2. Open B lazily. Apply sheet adds, removes and renames, then per sheet the row and column
     deletions (captured positions whose alias target is none, bottom up) and insertions
     (latest positions no alias covers, top down).
  3. Project, compare with `current` cell by cell, and write overrides for every difference in
     one transaction (formulas bound at the rebased context, formats added to the catalog).
     Diff merges, links, freeze panes, names, dimensions and chart anchors through the existing
     ops.
  4. Verify the projection equals `current` (formula caches aside) and fail the publication
     with an error otherwise. No silent fallback.
  State then grows with the edits made during the reparse, about 130 bytes each.

### Source binding and seed-changing upgrades

Today the room binds to `SHA-256(sourceSHA + ":" + fingerprint)`, where the fingerprint hashes
the date system, names, shared strings, styles and every cell's value, formula and style
(`authority.rs:3475-3571`); the bootstrap client id is its head (`authority.rs:416`). A byte
SHA alone is not enough for lazy state: two engine builds can parse the same bytes
differently, and with lazy state that would silently show different unedited cells. So:

- With the binding kept (recommended now), a parser change still orphans saved rooms, as
  today. What changes is the cost of the planned procedure: reseeding writes 3.6 KB instead of
  27 MB, and the first open takes 1.7 s instead of 5.5 s in WASM at 100k cells.
- With a parser-tolerant binding (open question 3), only changes to what the bootstrap writes
  or to occupied coordinates orphan rooms. Unedited cells follow the new parser. Style
  overrides must then carry their own catalog entry, and the formats catalog and dimensions
  must come from the source too, or style and size parser fixes still change the bootstrap.
  The bootstrap client id must keep deriving from a hash of everything the bootstrap writes,
  or a changed bootstrap reuses item ids and replicas diverge silently.

## Q4. Pending effects without a baseline

Yes. With the rebase above, the Yjs base is always the indexed source, so the effects are:
- one entry per `contents` override whose text differs from the source cell (`before` from the
  parsed source, `after` from the projection, label at the current address, id
  `{sheetKey}:{identity}` as today);
- one visual entry per `styles` override;
- one entry per active row or column change (plus deleted cells' old text if question 2 is a
  yes);
- small diffs for sheets, merges, links, names and freeze panes, which are stored in full.

The prototype's `override_effects` (cells and axis changes) returns 100 effects in under 1 ms
and 10,000 in 62-101 ms natively, and the effect JSON has the same shape and size as today's
(about 257 bytes per changed cell in jsonb). The stored baseline goes to 44 bytes. Every save
skips `officeBaseline` and `compareBaselines`, which cost about 66 s at 100k cells in WASM.

Readers of the baseline (`indexed_baseline`, candidate `baseline`):
- `collaboration/src/sourceDocuments.ts`: `load` initializes it (`:347-361`), `baseline`
  (`:380-397`), `effects` decodes and compares (`:399-431`), `rebasePublication`
  (`:433-511`), `exportCandidate` (`:820-826`); `sourceHandoff.ts:263-300` for text only.
- Go: `SaveSourceCheckpoint` validates and gates it (`source_documents.go:297-302,312`),
  `readSourceSession` returns it in every bootstrap and checkpoint response
  (`source_documents.go:236-242`), `FinalizeSourceRefresh` (`source_refresh.go:177-196`),
  `PublishSourceRefresh` (`source_refresh.go:265-321`), `validSourceBaseline`
  (`source_documents.go:474-488`), accounting in `0001_init.sql:1510` and
  `0015_source_semantic_baseline.sql:9-14`.
- Frontend: only the generated `SourceSession` type and MSW mocks.

Readers of effects (`pending_effects`, `net_tokens`):
- Collaboration: `effects` carries captions forward (`sourceDocuments.ts:418-429`), `resolve`
  finds an image effect (`:742-775`), `scheduleRefreshes` uses `jsonb_array_length` and
  `net_tokens >= 5000` (`:847-860`), `rebasePublication` copies captions (`:494-500`).
- Go: stored and gated in `SaveSourceCheckpoint` (`source_documents.go:288-314`), captions in
  `source_caption.go:62-129`, image caption associations and flags in `PublishSourceRefresh`
  (`source_refresh.go:290-321`), the pending flag in `workspaceIndexCounts`
  (`source_refresh.go:403-404`).
- Pipeline: chat evidence `retrieval/pending.py:90-128`, `resolve` `:173-259`, the
  `resolve_source_change` offer in `retrieval/tools.py:1928-1937`, `parse/caption_cache.py:81-101`.

All of them keep working if the effect shape stays. XLSX edits produce no image effects, so
the caption paths go idle for XLSX.

## Q5. Sizes and CPU

### Bytes, measured

State without contributor markers (they add about 23 bytes per update either way). Edits are
numeric cell commits, one Yjs transaction each from a uint32 client, on distinct cells
(10,000 commits cover 8,991 cells of the 10k sheet). "Compact" writes the same edits with a
`R,C` key and an Any array value, a size estimate the prototype doesn't read.

| Workbook | Edited cells | State today | State lazy | State lazy, compact | Baseline today | Baseline lazy | Effects (jsonb) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cells-10k | 0 | 2,666,476 | 3,594 | 3,594 | 4,255,767 | 44 | 2 |
| cells-10k | 100 | 2,667,513 | 16,220 | 5,920 | 4,255,767 | 44 | 25,652 |
| cells-10k | 8,991 | 2,773,181 | 1,162,440 | 236,367 | 4,255,767 | 44 | 2,336,847 |
| cells-100k | 0 | 27,019,546 | 3,619 | 3,619 | 43,071,623 | 44 | 2 |
| cells-100k | 100 | 27,020,615 | 16,345 | 6,045 | 43,071,623 | 44 | 25,721 |
| cells-100k | 10,000 | 27,138,810 | 1,293,664 | 263,664 | 43,071,623 | 44 | 2,601,065 |

An override costs 126-129 bytes today-encoded and 23-26 bytes compact, against 10-12 bytes for
overwriting an already-seeded cell. Even with every cell of the 10k sheet edited, lazy state is
1.16 MB against 2.77 MB, because unedited cells cost nothing.

Charged bytes (source + state + baseline + effects):

| File | Today, first Edit open | Lazy, first Edit open | Today, 10,000 commits | Lazy, 10,000 commits |
| --- | ---: | ---: | ---: | ---: |
| grades.xlsx (5.5 KB) | 13.9 KB (2.51x) | 6.9 KB (1.25x) | | |
| feature-rich.xlsx (7.3 KB) | 73.7 KB (10.1x) | 19.6 KB (2.70x) | | |
| cells-1k (14.3 KB) | 704.4 KB (49.2x) | 18.0 KB (1.26x) | | |
| cells-10k (87.6 KB) | 7.01 MB (80x) | 91.2 KB (1.04x) | 9.45 MB | 3.59 MB (1.50 MB compact) |
| cells-50k (412.7 KB) | 35.42 MB (85.8x) | 416.4 KB (1.01x) | | |
| cells-100k (819.4 KB) | 70.91 MB (86.5x) | 823.1 KB (1.00x) | 73.63 MB | 4.71 MB (2.39 MB compact) |

For feature-rich.xlsx the lazy seed is 12.3 KB, 63% of it the formats catalog (17 formats,
456 bytes each) and 21% one chart record.

Refresh peak for cells-100k after 10,000 edits (source, state, baseline, effects, plus the
candidate's captured state, export, seed and baseline): **172.3 MB today, 7.05 MB lazy, 3.70 MB
lazy with compact encodings and compact effects**. After publication with no later edits:
71.1 MB today, 1.05 MB lazy (the export plus a 3.6 KB seed).

### CPU and memory, measured

WASM numbers come from `xlsx-wasm` built from the pinned sources and from the prototype with
the same `wasm-pack` command; the rebuilt pinned module is byte-identical to the live runtime
(`c4ade1d3…`). Node 22, one run each, this 16-core machine while other probes ran.

| Step | 10k today | 10k lazy | 100k today | 100k lazy |
| --- | ---: | ---: | ---: | ---: |
| Seed (first Edit open, `seedOffice`) | 456 ms | 173 ms | 5.47 s | 1.71 s |
| Open + apply state (every save, export, inspect, agent edit) | 668 ms | 149 ms | 7.81 s | 1.61 s |
| Same with 10,000 edited cells | 716 ms | 414 ms | 7.74 s | 1.95 s |
| Checkpoint projection (baseline only) | 640 ms | not needed | 55.8 s | not needed |
| Baseline entries in JS | 248 ms | not needed | 2.23 s | not needed |
| Override effects, 10,000 overrides (native) | | 101 ms | | 62 ms |
| Export (`saveBytesAt`) | 110 ms | 54 ms | 1.10 s | 0.48 s |
| One-cell commit in the editor (`editCellJson`) | about 300 ms | about 30 ms | 3.0-4.5 s | about 285 ms |
| WASM memory after open, 10k edits, export | | | 280 MB | 108 MB |
| JS heap of the room's Y.Doc (service) | 9.4 MB | 0.2 MB (5.6 MB with 8,991 edits) | 90.3 MB | 0.2 MB (5.9 MB with 10k edits) |

A checkpoint save at 100k cells is open + projection + entries + compare today, about 66 s in
the one shared Office worker. With override effects it is open + effects, about 2 s.
Natively the same ratios hold (100k: seed 3.46 s to 0.69 s, open + apply 6.5 s to 1.5 s,
commit 2.95 s to 0.27 s).

One finding outside storage: the checkpoint projection is superlinear in WASM only (native
0.27 s to 2.86 s from 10k to 100k cells, WASM 0.64 s to 55.8 s). Agent `apply`, `locate` and
`inspect` call it one to three times per command (`office-checkpoint.ts:880-954`), so an agent
edit on a 100k-cell sheet takes minutes. Lazy state doesn't fix that; reading the target cell
through `cellJson` and the sheet list through `sheetInfoJson` would.

## Q6. Effort, risk, files, the upstream merge

### Effort

- Fork: lazy seed, overlay and write semantics with a schema 8 bump and focused tests (clear
  marker, revert, undo over a source cell, concurrent clear and set, hidden-sheet formula
  validation), 1-2 days since the prototype exists. Override effects plus the `xlsx-wasm`
  binding and the XLSX branch in `office-checkpoint.ts`, 1 day. The overrides rebase with
  verification and tests (including post-capture inserts and deletes), 2 days. Golden seed
  test for schema 8, hours.
- Capy: `SourceDocumentStore.effects` calls the engine for XLSX, `load` and `exportCandidate`
  store the empty baseline, `officeRuntime.ts` gains the method; collaboration tests and the
  two openwiki pages. About 1 day. No Go, migration, pipeline or frontend change.

### Risk

- Unedited cells now depend on every replica parsing the same bytes the same way. The kept
  binding enforces that, as today.
- The overrides rebase is the one new algorithm with edge cases (range membership of rows
  inserted after capture). The verification step turns a mistake into a failed publication,
  not wrong data.
- Behavior changes for questions 1, 2 and 4.
- Projection is still O(N) per commit (about 10x cheaper). The single-materialize patch from
  the handoff still applies and still helps.

### Files

Fork: `crates/betteroffice-xlsx/src/authority/stable.rs` (most of it), `authority/topology.rs`
(`index_in`), `authority.rs` (two `WorkbookBase` fields, schema constant, effects accessor),
`workbook.rs` (public effects call), `workbook/rebase.rs` (overrides rebase; delete the parts
overlay and alias projection), `crates/xlsx-wasm/src/core.rs` and `lib.rs`,
`shared/office-checkpoint.ts`, `tests/stable_collaboration.rs`. In production, share one
`Arc` of the parsed sheets between `PreservedPackage` and `WorkbookBase` instead of the
prototype's clone.

Capy: `collaboration/src/sourceDocuments.ts`, `collaboration/src/officeRuntime.ts` and their
tests, `openwiki/frontend/office-files.md`, `openwiki/backend-storage-quota.md`.

### Upstream merge

- `stable.rs`, `topology.rs`, `workbook/rebase.rs` and `shared/office-checkpoint.ts` are
  fork-only, so most of the change can't conflict textually.
- `authority.rs`: upstream grows `WorkbookBase` (`col_styles` and sheet formats from
  `21d83b36`, `dfb5c824`, `91554bf6`; `tables` from `d1c6a553`) and moves it behind an `Arc`
  (`775f184f`). Adding two fields makes that existing hunk a little bigger. `187cebc9` and
  `e8c4f5b3` touch format interning and canonical checks next to the catalog code; they only
  conflict if the formats catalog also becomes lazy.
- `workbook.rs` and `xlsx-wasm`: additive functions next to upstream additions (`bcc90ba0`
  search). `1acc67b0` (single copy of package parts) is where the shared `Arc` belongs.
- The handoff already has to rebuild column styles, tables, array-formula ranges and preserved
  row markup for schema 7 by "rebuilding from the source file plus our row and column
  identities at load". That is the same mapping the lazy overlay introduces, so doing lazy
  first gives those ports one place to live.

### Riding the planned upgrade

Yes. Schema 8 is a seed change like the others. No migration code: publish pending edits on
the old engine, deploy, bump epochs and drop XLSX states in one statement, and old tabs get
403 and move their drafts to recovery (handoff review 1.3). If the upstream merge ships in the
same deploy, one reset covers both.

## Smaller savings, independent of lazy state

| Change | Size effect, measured on cells-10k unless noted |
| --- | --- |
| Short identity keys (`R,C` for source points; canonical parse and format) | -48 bytes per `contents` and `styles` entry: -0.72 MB (27%) of today's 2.67 MB seed; overrides 126 to about 78 bytes |
| Compact values (Any array instead of `Content` JSON; formula bindings as tuples without `original`, `prefix`, `suffix` and null fields) | with short keys and 16-hex style keys, today's cells and styles 2.66 MB to 0.54 MB (53.5 bytes per cell); lazy override 126 to 23-26 bytes |
| 16-hex format keys instead of 64-hex | -48 bytes per style entry and per catalog key |
| Formats catalog from the source (store only formats that overrides use) | -456 bytes per source format; 7.8 KB of feature-rich.xlsx's 12.3 KB lazy seed |
| Dimensions from the source | -40 to 52 bytes per source row or column size; LibreOffice writes `ht` on every row, about 5 MB for a 100k-row sheet (estimate) |
| Effects with short ids and plain cell text (`"501664"` instead of `{"kind":"number","value":501664.0}`) | 257 to 128 bytes per changed cell: 2.60 MB to 1.31 MB for 10k changed cells at 100k; 1.08 MB also without `before` |
| One effect per row or column change | one inserted row: 9,991 effects and 2.51 MB today, 1 effect and 94 bytes |
| Deflated rebase parts (only if today's overlay stays) | the overlay is uncompressed worksheet XML, 5.2 MB at 100k cells; the source zip holds the same sheet in about 1/8 of that (estimate) |
| Contributor markers without client-id rotation (storage report option F) | -23 bytes per update |

## Method

- Byte walk: `breakdown.mjs` recomputes each struct's update-v1 length (info byte, origins or
  parent and key, content) over the real seed and checks the sum.
- Prototype: `lazy-prototype.patch` (342 insertions, 50 deletions over four files; about 200
  lines are the lazy core, the rest is the effects probe) applied to a scratch worktree of
  `origin/capy-ci`. `cargo test -p betteroffice-xlsx -p xlsx-wasm` (release, raster on) passes
  all 211: 32 unit, 21 chart_render, 1 schema_migration, 15 stable_collaboration, 121 workbook
  and 21 xlsx-wasm. The fork's DOCX, PPTX and Bun suites were not run; the change doesn't touch
  them.
- Differential check: `lazy_probe diff` runs the same script on today's engine and the
  prototype over `cells-1k.xlsx`, `grades.xlsx` and `feature-rich.xlsx`: value, formula, clear
  and revert edits on source cells, a new cell, bold over source styles, clearing a styled
  header, a currency format, a concurrent two-row insert with edits in it, a column delete
  with undo and redo, a three-row delete and a merge, two undos, then a fresh replica. Model
  and export digests match at all 10 steps for all three files.
- Edits: `emulate.mjs` writes the engine's own payload for numeric commits into the room
  state; opening those states with both engines gives byte-identical exports at 10k and 100k
  cells for 100 and 10,000 edits.
- Timing: `lazy_probe` (native, release without LTO), `wasm_probe.mjs` and `wasm_commit.mjs`
  (WASM through the `wasm-pack` glue), `heap.mjs` (`--expose-gc`), `structural_effects.mjs`
  (today's baseline and compare code, copied verbatim), `race_probe.rs`.
- Raw results: `scratchpad/xlsx-lazy/runs/`, states in `states/`, exports in `exports/`,
  effects in `effects/`. The worktree and build directories were removed afterwards.

## Caveats

- The large workbooks are synthetic (10 columns, 10% formulas, half the cells styled, no row
  heights). Real files carry more formats, sometimes a size on every row, and more formulas,
  which moves bytes from cells to the catalog and dimensions.
- The prototype's effects cover cell overrides, style overrides and axis changes only. Sheet,
  merge, link, name and freeze-pane diffs and deleted-cell text are design, not code, and were
  not measured. WASM effects time was not measured (native only).
- The overrides rebase was not prototyped. Today's rebase was measured under the lazy engine.
- Edited states were emulated, not typed through the editor; the exports prove the payloads
  are the engine's own. Contributor markers are excluded.
- Timings are single runs on a shared machine; ratios between engines are more reliable than
  absolute values.
