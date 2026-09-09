# OpenDataLoader column-order experiment

The selected benchmark candidate repairs both known German column continuations
in native output and in individual production chunks. It uses saved native
geometry and a small amount of source PDF inspection. It makes no OCR or model
calls. Production parsing and chunking remain unchanged.

This is a narrow repair for intact prose blocks. It does not establish general
OpenDataLoader accuracy or remove the need for visual recovery.

## Source evidence and controls

The inputs are the frozen OpenDataLoader 2.5.7 Java outputs from the
[new-document experiment](2026-09-09-java-new-documents.md). The screening corpus
has 48 pages, including eight derived raster controls; the intact corpus has
254 original pages. The baseline uses cluster tables and header/footer inclusion.

German source pages 3 and 23 were visually reviewed before candidate code was
written. Both contain conventional left-to-right columns. The bottom-left
paragraph continues at the top of the right column, but native block order puts
that right-column continuation too early. The source text itself is present.

Source-only order checks were also frozen for Attention source page 2, Japanese
migration source page 6, and NIST source page 3. These are controls for an ordinary
single column, methodological/contact text, and historical scanned columns.
NIST already fails its order check; rejecting it is safe abstention, not recovery.

`checks-v1.json` predates implementation. `checks-v2.json` corrects one ambiguous
Attention anchor: the phrase naming the architecture also occurs earlier in
running prose, so the probe now uses the unique following paragraph start.
The original rubric remains available. An initial evaluator mistake compared
zero-based source pages with one-based chunk pages; all reported results use
the corrected comparison. Section headings are checked through actual
`indexed_text()`, since they live in chunk metadata rather than body text.

`checks-full-v2.json` maps these same frozen checks to intact source IDs and
page offsets through `corpus.json`; it changes no anchor. The final intact runs
contain executed checks, rather than reusing the screening IDs and scoring zero
questions. Source PDF hashes, native input receipts, script and production
chunker hashes are recorded by the runner.

## Strategies tested

1. **Column order only.** Require an all-text/list native page, at least two
   substantial blocks per column, two tall columns, an empty central gutter and
   no body block crossing that gutter. Sort the eligible blocks by column and
   then vertical position. Preserve every block's bytes, page, box and ID;
   verify the complete block multiset. This repairs both order checks, but only
   one continuation reaches an individual chunk.
2. **Demote the vertical sidebar heading.** On reordered pages, verify a heading
   against source lines with vertical text direction, matching normalized text
   and overlapping geometry. Move it before the prose and remove its heading
   level. This does not fix the remaining split and leaves more of the page under
   the preceding unrelated heading. Rejected.
3. **Move the sidebar heading intact and expose the continuation prefix.** Keep
   the source-confirmed sidebar heading's existing level and move it ahead of
   the prose. At the column turn, require an incomplete left ending, horizontal
   source text, and matching source font/size. Split the first sentence of the
   right block into a short block so the existing chunker can pack it with the
   left tail. Both derived blocks retain the original right-column box; the two
   text slices reconstruct the exact original string. This is the selected
   candidate, using `--move-rotated --split-continuations`.

The first version of strategy 3 accepted a text block on the left. Intact Java
output represents part of German page 23 as a one-item list, although the
screening output calls it text. The final candidate also accepts the existing
list text representation. It retains the list and its source box and applies
the same source-font check. Earlier `full-bridge-r*` runs retain the failed
intact result; final runs are named `full-bridge-list-r*`.

## Quality result

| Development checks | Baseline | Order only | Demote sidebar | Selected candidate |
| --- | ---: | ---: | ---: | ---: |
| Correct raw column-continuation order | 0/2 | 2/2 | 2/2 | 2/2 |
| Correct order in the actual chunk stream | 0/2 | 2/2 | 2/2 | 2/2 |
| Both sides of the continuation in one chunk | 0/2 | 1/2 | 1/2 | 2/2 |

The selected result holds on both screening and intact originals. For intact
German page 23, the recovered sentence occupies one chunk with three original
regions: the two native left-column blocks and the right-column block. Every
region cites source page 23. No cross-page merge or union box is introduced.
The right-column citation remains broad because it comes from the original
large native paragraph.

Only German pages 3 and 23 change in screening. In the intact corpus, only
German source pages 3, 23 and 29 change. All blocks and chunks of the other seven
documents remain identical. The Attention and Japanese screening controls keep
their passing results. The NIST control remains broken and unchanged; the
Japanese intact chunk check also retains its pre-existing failure.

German source page 29 was inspected after the full replay, so it is a post-hoc
diagnostic, not a held-out accuracy score. Its prose columns are now ordered
left then right and its vertical sidebar heading moves before the prose.
Its two visible vector icons are absent from native image blocks, illustrating
why an all-text native page is not proof of an all-text source page.

These changes still leave incorrect ancestor headings. The screening page 23
chunk ends its path with the correct sidebar label but retains unrelated
`Im Überblick > 78 > 25` ancestors. Clearing those ancestors would require a
separate source heading decision. The experiment does not invent that decision.
The source checks measure these specific continuations, not complete paragraph
transcription, all citations, or retrieval accuracy.

## Timing

Runs used an isolated, network-disabled container on `159.195.61.195`, the
retained `capy-java-native:20260909` image, one CPU, 1 GiB memory and no swap.
All input artifacts were mounted read-only. Each table entry is the median of
three sequential repeats. No parser, OCR model or caption request was run.

| Transformation | 48 screening pages | 254 intact pages |
| --- | ---: | ---: |
| Column order only | 0.0108 s | 0.0855 s |
| Order and source-confirmed sidebar demotion | 0.0242 s | 0.1101 s |
| Selected candidate, final list-aware version | 0.0381 s | 0.1359 s |

The transformation timer includes page/block inspection, block preservation
assertions and, when used, source PDF opening, source line inspection and
continuation splitting. It excludes input JSON loading, output serialization,
Python imports, self-checks and production chunking. A separate process timer
includes those operations and emits both before/after chunks; it is benchmark
harness cost, not ingest latency. Existing Java/OCR extraction timing must not be
added to these independent measurements and presented as a measured combined run.
Selected process medians were 0.9435 seconds for screening and 2.6871 seconds for
intact documents, including both complete before/after chunk dumps.

## Reproduction and artifacts

Runner: [`experiment_odl_reading_order.py`](../scripts/experiment_odl_reading_order.py).
It requires a new output directory and validates the native receipt against
the corpus PDF hash. Geometry/sentence checks are deterministic heuristics.
They abstain on mixed layouts represented by images, tables or equations and
do not support arbitrary multi-column/vertical document reading order.

```sh
uv run --with pymupdf==1.28.2 python \
  bench/parsers/scripts/experiment_odl_reading_order.py \
  --self-check --move-rotated --split-continuations

# Within the isolated VM runner tree; /baseline is the original read-only run.
python /eval/bench/parsers/scripts/experiment_odl_reading_order.py \
  /baseline /eval/full-new-run \
  --run full-odl-java-headers-full-r1 \
  --checks /eval/checks-full-v2.json \
  --move-rotated --split-continuations
```

VM results live at `/opt/capy-odl-reading-order-20260909/`. Local artifacts live
under `bench/parsers/reports/local/2026-09-09-odl-reading-order/`. The local `vm/`
copy contains the exact final runner tree, checks, raw content lists, before/after
chunks, rotation/continuation receipts and every timing repeat. Selected raw
outputs are `vm/screen-bridge-list-r1/` and `vm/full-bridge-list-r1/`.
`vm-timing.json` records the first three strategies; `vm-timing-final.json`
records the selected list-aware repeats.

The copied VM archive verified all 1,693 files against `MANIFEST.sha256`.
`vm-final.tar.gz` has SHA-256
`cc181dddc8687929ce2ef641a090549ce412b147bf84a4d9d9800f3682022292`.
The final repository runner matches the VM runner hash
`aa174cd1e1adc04a77fdd0492cd45b91dd9d954e137283d04578e42e68d22d39`.

The focused executable checks cover column sorting, byte preservation,
idempotence, mixed-layout abstention, source-confirmed rotation handling, text
and list continuation splitting, exact text reconstruction and retained boxes.
Isolated Ruff check/format passed. The required root `pnpm run fmt:py` passed
without formatting changes; final benchmark-only edits also passed isolated
checks. Production parser, chunker, services and databases were unchanged.
