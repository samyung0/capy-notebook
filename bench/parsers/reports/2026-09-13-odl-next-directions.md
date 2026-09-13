# ODL parser: next directions after the repair experiments

Date: 2026-09-13. This is a read-only code, artifact and literature review plus
one isolated native-parser diagnostic. It does not change the parser, chunker,
deployment or any database. No VM work was needed.

## Position

The next parser work should start at the ODL-to-Capy boundary, not with another
document-specific text repair. Capy discards useful relationships that ODL
already emits, then tries to infer some of them again from proximity. Preserving
those relationships and measuring structure-aware chunking is cheaper and less
risky than changing extracted text.

The JLPT failure has a chunk-packing cause, not a missing native boundary. A
fresh ODL 2.5.7 native parse of the exact retained PDF separates question 57's
four choices (list 263) from `問題 10` and the first passage segment (list 268,
item 269). The adapter preserves these as separate list blocks. The current
400-token packer then joins both blocks into one 392-token chunk and gives that
chunk both source regions. Preserving the native block boundary as a hard or
scored chunk boundary is therefore the direct experiment for the preceding
answer-choice contamination. A source-line splitter would address only finer
boundaries within item 269 and is not needed to separate question 57 from
question 10.

## What is lost today

OpenDataLoader's [documented JSON schema](https://opendataloader.org/docs/reference/json-schema)
contains a hierarchy, element IDs, caption-to-content links, cross-page table and
list links, table-cell coordinates and spans, heading levels, font attributes and
hidden-text flags. Capy's adapter keeps the top-level node ID/type, text, one
block box and table span values. It flattens the hierarchy and drops relation
fields, text styles and cell geometry. See
[`adapter.py`](../../../parser/odl/adapter.py#L20). The chunker later rebuilds a
heading stack from the flattened sequence and discards the remaining native IDs.
See [`chunking.py`](../../../pipeline/pipeline/retrieval/chunking.py#L504).

A small audit used eight saved real PDFs spanning Japanese, Chinese, French,
German and English documents. It read existing native JSON, direct adapter
output and final chunks. It made no parser calls. These files were selected from
the existing development and control artifacts, so this measures field survival,
not parser accuracy or prevalence in user traffic.

| Field or relation | Native ODL | Adapted blocks | Final chunks |
| --- | ---: | ---: | ---: |
| Typed nodes | 5,873 | 3,736 blocks | 725 chunks |
| Nested typed nodes | 2,256 | 0 parent links | 0 native IDs |
| Caption links | 33, to 24 tables and 9 images | 0 | 0 |
| Table/list continuation links | 160 linked nodes | 0 | 0 |
| Table cells with their own box | 559 | cell text and spans retained in HTML; cell boxes dropped | 0 |
| Text nodes with font, size and color | 4,402 | 0 | 0 |

The runnable inventory is
[`odl_structure_audit.py`](../scripts/odl_structure_audit.py). It also found 389
source regions reused by more than one chunk, with at most four chunks sharing a
region. Overlap and long-block splitting can both cause reuse, so this is not an
error count. It does establish that one parser box is not always a precise final
chunk box. The cited-text locator is the appropriate fix for citation geometry.

### Exact JLPT native-node check

No retained native ODL JSON existed for
`/private/tmp/capy-uat-rag-inspect/n1.pdf`. I parsed those exact bytes in an
isolated local scratch directory with the cached `opendataloader-pdf==2.5.7`
JAR, Java 17.0.11 and the flags currently pinned in
[`java.py`](../../../parser/odl/java.py#L11):

```sh
java -Xmx3g -Djava.awt.headless=true \
  -jar /private/tmp/capy-odl-quality-20260913/py312/lib/python3.12/site-packages/opendataloader_pdf/jar/opendataloader-pdf-cli.jar \
  /private/tmp/capy-uat-rag-inspect/n1.pdf \
  --output-dir /private/tmp/capy-odl-jlpt-native-20260913-r1.G0zxLj \
  --format json,markdown --image-output external --markdown-with-html \
  --threads 1 --table-method cluster --include-header-footer
```

This is fresh raw native output, not the historical refined UAT bundle. It
matches the current parser version and Java flags. The current
`fonts.repair_fonts()` returns zero repairs and byte-identical input for this
PDF, so this is also the native input that today's refinement path would use.
It cannot prove that the historical deployment ran identical code.

| Artifact | SHA-256 |
| --- | --- |
| Source `n1.pdf` | `98ef94c2fd3e7cd9dc103f936ccf6c4b624137e4c25cc059e7b1fe50f40d3aca` |
| ODL CLI JAR | `74f0d797bea8088bd4a58137e372eb38a5fa24639e06b633cef7f78eba14cd62` |
| Raw native `n1.json` | `c91f2175d4fa474748563880e11eea7c648e1c281c6524b504591da96f0d8f69` |
| Raw native `n1.md` | `6e2a48a512faa9b8f65f341612f87966918d9015a5bf4b50fc0d637d1506e841` |

On source page 10, ODL emits list 263 with items 264-267 for question 57's
answers, then list 268 with one item, 269, beginning `問題 10` and continuing
through `そのため、人間は`. Their native boxes are respectively
`[90.024, 537.663, 468.020, 596.493]` and
`[90.024, 397.263, 505.344, 534.063]` in ODL's bottom-left point space. The
adapter converts these to separate blocks 60 and 61 with distinct normalized
boxes. See [`adapter.py`](../../../parser/odl/adapter.py#L52).

ODL marks list 268's `previous list id` as 192 rather than the adjacent list
263. That is another concrete reason to validate continuation links before
using them: native relationships are useful signals, not ground truth.

Running those raw adapted blocks through `chunk_content_list()` with the current
defaults reproduces chunk 29: 392 estimated tokens containing all four question
57 choices, followed by item 269. Its two regions are the two adapted block
boxes. The join follows the normal pending-block packing path in
[`chunking.py`](../../../pipeline/pipeline/retrieval/chunking.py#L535); no ODL
node was lost.

A second replay ran the complete current `parse_pdf()` refinement and the
production `pack_blocks()` → `retain_headings()` → `score_chunks()` path. It
produced the same 392-token text and two regions as production chunk 30, with
confidence 1.0 and no confidence reasons. The frozen furniture set was empty;
selective OCR routed only page 19 and did not affect page 10. This confirms the
cause in current code, but it does not substitute for the unavailable historical
refined UAT bundle.

An independent comparison with the frozen UAT retrieval snapshot found exact
equality for chunk 30's body text, indexed text, section path and page span
against `chk_5901ee92e1a8f428`. The native/refinement artifacts remain a fresh
replay, but the actual indexed passage under investigation is reproduced.
Its confidence of 1.0 measures agreement with source text; it does not detect
the unrelated question choices packed into the same retrieval unit.

The raw JSON/Markdown, both adapted block sets, production chunks, Q10 replay
summary, runtime/flag/hash receipt and source symlink are preserved in the
gitignored [local diagnostic receipt](local/2026-09-13-odl-next-directions/README.md).

`context.contextualize()` currently searches up to three preceding flat blocks
for a caption-looking string and attaches it only to supported tables. See
[`context.py`](../../../parser/odl/context.py#L49). This can recover some visible
titles, but it ignores ODL's explicit `linked content id`, image-caption links and
cross-page continuation IDs. The upstream links are predictions and still need
validation. Their presence is not proof they are correct.

## What earlier work ruled out

- All-page OCR and automatic OCR prose replacement are poor defaults. Existing
  tests found new errors in already-correct prose, including a 99.75% confidence
  result that changed one correct proper noun into an error. Confidence cannot
  decide which transcription is right. The selected production path remains
  OCR only for pages with fewer than 40 native characters. See the
  [OCR disagreement experiment](2026-09-09-odl-ocr-disagreement-experiment.md).
- ODL hybrid and full RapidOCR did not preserve enough table relationships on
  the Capy corpus and had large CPU/memory costs. Repeating that parser swap
  without a new hypothesis would rerun a rejected arm. See the
  [ODL versus MinerU comparison](2026-09-08-opendataloader-vs-mineru.md).
- More table and order thresholds have reached their useful limit. The latest
  source-family-separated validation gave the refined candidate and matched raw
  Java the same 38/41 row and 238/256 cell result. Both retained 12/52 wrong
  source-region pairs and 18/61 wrong final-chunk pairs. The Frontiers panel
  order and MDPI flattened table remained broken. See the
  [repair validation](2026-09-13-odl-repair-validation.md).
- The learned OCR layout arm fixed four known pages when every line mapped to a
  region, but applied on only two of five additional documents and delivered no
  new gain there. The permissive arm reordered Japanese and Spanish content
  incorrectly. Adding another cutoff to that arm lacks evidence. See the
  [layout OCR report](2026-09-13-odl-layout-ocr.md).
- OpenDataLoader 2.5.8 was released after Capy's 2.5.7 pin, but its listed quality
  change preserves heading depth in the hybrid path. Capy uses the Java native
  path plus its own selective OCR, so the [2.5.8 release](https://github.com/opendataloader-project/opendataloader-pdf/releases/tag/v2.5.8)
  does not identify a fix for these native failures. A compatibility replay is
  cheap, but it is not the next quality strategy.

These observations argue against more phrase-specific repairs. They do not show
that ODL's native output is generally accurate. ODL's own public benchmark says
the Java-only path scores much lower than its hybrid path on table structure,
and the project tracks unresolved multi-column and borderless-table failures.
See the official [benchmark repository](https://github.com/opendataloader-project/opendataloader-bench)
and [reading-order issue 294](https://github.com/opendataloader-project/opendataloader-pdf/issues/294).

## Four justified experiments

### 1. Preserve and use ODL relationships

Carry native parent ID, caption target ID, previous/next table or list ID and
cell source boxes through the adapter. Keep them as metadata rather than adding
font/style strings to embedding text. Build chunks from linked elements, repeat
table headers when a table splits, and attach captions by ID before using spatial
fallbacks. This follows the same principle as Docling's official
[hierarchical and hybrid chunkers](https://github.com/docling-project/docling/blob/main/docs/concepts/chunking.md),
which retain document-item references, headings and captions and merge only
same-heading peers.

The evaluation should verify every consumed link against page, geometry and
target type, then compare current versus relationship-aware chunks on source
families kept out of rule development. Labels should cover caption attachment,
cross-page table/list continuity, header repetition, complete answer evidence
and unrelated-text contamination. Report link coverage and abstentions as well
as precision. A bad explicit link must fall back to current behavior rather than
move text.

This is the best first experiment. It tests data Capy already paid to extract and
does not rewrite characters or source order.

The exact audit command was:

```sh
ODL_AUDIT_ROOT=bench/parsers/reports/local/2026-09-13-odl-native-improvements
python bench/parsers/scripts/odl_structure_audit.py \
  "$ODL_AUDIT_ROOT/default-r1/hongkong-figures" \
  "$ODL_AUDIT_ROOT/default-r1/rag__fr__camembert-taln" \
  "$ODL_AUDIT_ROOT/default-r1/resnet" \
  "$ODL_AUDIT_ROOT/default-r1/bert" \
  "$ODL_AUDIT_ROOT/default-r1/rag__zh__zh-CN" \
  "$ODL_AUDIT_ROOT/controls-native-r3/german-education" \
  "$ODL_AUDIT_ROOT/controls-native-r3/rag__fr__wikiner-fr-gold" \
  "$ODL_AUDIT_ROOT/controls-native-r3/rag__ja__jp_llm"
```

The exact UTF-8 JSON stdout has SHA-256
`cccc0eb8f10a0701ae6842369ffa15340541b6841251d9783939a1fa6b35f4e3`.
The local artifact tree is gitignored and required for reproduction.

### 2. Preserve semantic boundaries while packing

First, test list/block boundaries as scored or hard packing boundaries. The JLPT
diagnostic shows that ODL and the adapter already distinguish the prior answer
list from the new passage, while the generic token packer recombines them. A
general arm can keep a new numbered-question/list block with its following prose
and flush an unrelated preceding list. Candidate signals should be native node
type and ID, page geometry, list start/continuation relationships and section
transitions. Do not encode `問題10`, an answer phrase or a document ID in the
rule.

For a single ODL item that still exceeds the chunk budget, a second arm can
recover source PDF lines and score candidate boundaries using vertical gaps,
font/size changes, indentation, list-marker transitions and Unicode sentence
endings. Split only at a matched source line and compute each piece's box from
its glyphs. Item 269 is one native item containing the instruction and first
passage segment; line-aware splitting is justified only if evaluation needs a
tighter citation or retrieval unit within that item.

Controls need prose pages where an apparent line gap is only wrapping, tables
represented as prose, multi-column pages and the supported languages. Measure
boundary precision/recall against manually marked source units, preceding and
following contamination, evidence completeness, chunk token distribution and
exact citation-box coverage. Then rerun retrieval with frozen queries and
vectors regenerated for both arms. Parser-only text scores cannot select this
change.

This experiment is related to Late Chunking, which embeds a longer context before
pooling chunk representations, but it is simpler and works with the current
embedding API. [Late Chunking](https://arxiv.org/abs/2409.04701) is worth a later
model experiment if structural splitting still loses context.

### 3. Index uncertain pages as locators

Do not force a single reading order when native and learned layout disagree or
the strict layout model abstains. Create a page-level locator record containing
order-insensitive text plus page and file identity. It may retrieve a page and
trigger `capture_page`, but it must not become quoted answer evidence. Keep the
ordinary chunks for text answers and citations.

Evaluate page Recall@40 and Recall@5 on the known Frontiers continuation,
infographics, tables and numbered sections, with ordinary prose controls. Also
measure duplicate pressure on the five returned results. This experiment tests
whether uncertain layout can remain visible to search without accepting a
possibly wrong reorder. Visual page retrieval methods such as
[ColPali](https://arxiv.org/abs/2407.01449) support the general direction, but a
small text locator is the cheaper first arm. A visual index should be considered
only if the text locator misses layout-dependent questions.

### 4. OCR source regions that have no native text

The current page gate counts characters. A page with a native header and a
rasterized body can exceed 40 characters and skip OCR. Test a region gate that
selects a large raster region only when no native glyph boxes overlap it. Append
OCR blocks for that empty region. Never replace native prose based on OCR score
or agreement.

Use genuine mixed native/raster pages, scans, full-page background images and
born-digital controls. Freeze visible text and boxes before inference. Measure
region selection precision/recall, character edits against human transcription,
reading order, duplicate text and added parser time. The existing NIST result
shows why image coverage alone is unsafe: digital German pages had 81% and 98%
raster backgrounds with legitimate visible text.

## Evaluation shape

Parser evaluation and retrieval evaluation should stay separate, then meet in a
small end-to-end set:

1. Run standard structure metrics on source-family-separated PDFs: NID-S for
   narrative order, TEDS-S plus cell text for tables, and MHS for heading
   topology. These are the metrics used by the official ODL benchmark. Add
   relation accuracy because those metrics do not cover caption/continuation IDs.
2. Score final chunks for source-unit boundary accuracy, complete evidence,
   contamination, section/caption context and citation localization. Record the
   percentage of pages where a candidate abstains.
3. Re-embed both arms and measure retrieval Recall@40, Recall@5, nDCG@5,
   complete-passage recall and page recall. Include content questions and
   structural locators such as section, question, table and figure references.
4. Keep development and held-out source families separate. Add real Korean and
   distinct simplified/traditional Chinese PDFs before claiming coverage for the
   planned language set. The current eight-file metadata audit contains no
   Korean document and cannot support a language-quality conclusion.

RAPTOR and recursive summary trees address document-level or multi-step context,
not the observed page-boundary and relationship loss. Its
[published method](https://arxiv.org/abs/2401.18059) is useful when the retrieval
benchmark shows missing global context. It would add generation and indexing
machinery before resolving the simpler losses above, so it should not be the
next parser experiment.

## Observation and inference boundary

Observed: the JLPT passage exists; the fresh matched ODL 2.5.7 parse separates
question 57's choices from question 10; the adapter keeps the two native lists
as separate blocks; the generic 400-token packer rejoins them in one 392-token
chunk with two regions. ODL emits other relationships and cell geometry that
Capy's adapter drops. Recent repair validation found no gain over matched Java
on new source families.

Inferred: preserving verified relationships and native semantic boundaries
should improve context with less regression risk than another text repair;
source-line boundaries may make the item-269 citation tighter; page locators may
rescue uncertain layouts. Each inference still needs the paired experiments
above. None is a selected production change.
