# Parser repairs on new public PDFs

The held-out corpus contains **34 newly downloaded PDFs, 11,672 pages, seven
languages, and 12 exporter families**. The source-only visual gold contains
**144 regions across 70 pages and every document**. These are execution and
sample-review counts, not an all-page extraction accuracy estimate.

**The broader tests do not support shipping the frozen repairs unchanged.**
The heading candidate improves several books but introduces a breadcrumb
regression in an alternating-header report. Native alternatives can insert
misleading descriptions or change mathematical meaning. The geometry gate
misses most of the frozen missing-math cases. A separate, post-holdout ECB
structure-repair experiment is described below.

This extends the [handoff investigation](2026-09-20-parser-handoff-investigation.md).
The heading, native-alternative, and geometry prototypes were frozen before
evaluating these sources. No production parser, deployment, ingest database,
or library material was changed.

## Corpus and selection

The [source manifest](../fixtures/unseen-pdf-sources-2026-09-20.json) records
requested/resolved URLs, source SHA-256, page count, producer, language and
licensing. The selected sources include eight new OpenStax subjects, Prince
examples, Pressbooks, LaTeX/XeTeX/LuaTeX books and papers, W3C accessibility
examples, a historical scan, Korean/Arabic/Chinese material, and NIST, Census,
Japanese, French and ECB reports. Sources were selected for exporter and layout
diversity before candidate output was inspected. All pages are submitted to
the parser; the visual checks are purposive samples.

An independent review found no exact source SHA or requested/resolved URL
matches across 78 prior fixture JSON files. This proves novelty against the
recorded fixtures, not against unrecorded past work. Eight new OpenStax books
still share the development publisher and Prince exporter family.

The binaries total about 1,068 MiB and remain in the ignored
`fixtures/local/2026-09-20-unseen-pdfs/` directory. This is private local
measurement, not library ingestion or republication. Publisher licensing is
retained in the manifest. Initial download failures, including size bounds,
transient Windows rename locks and access denials, remain in the receipts;
successful recovered downloads retain their identity.

## Frozen evidence and comparisons

- Sources: manifest SHA `6a8bb30ed4e1d1a15736329f7c63f8c99a17173b51a9b3ce77d973ab467f4eda`.
- [Initial visual gold](../fixtures/unseen-pdf-visual-witnesses-2026-09-20.json):
  104 cases, 21 documents, SHA
  `07c2e8d0391870146d7b9417f7ef04dff0a86ac3e4b11649ebe67fdec81a37c8`.
- [Visual extension](../fixtures/unseen-pdf-visual-extension-2026-09-20.json):
  40 cases covering the remaining 13 documents, SHA
  `8ca9988a41686fb077a4af3927fe0fa5fe67b4f79f729fc9abfb14e2b33e5d71`.
- Heading prototype SHA
  `5ab0ca12119547ff7c201a6ebed34d980d43fb43e2314f7a5964afe3421ab5e6`.
- Native-alternative prototype SHA
  `49788c0554626bf82f1331d01b266b27b6e97d9fd75eda6243adfba112fb1ddd`.
- Geometry prototype SHA
  `136de0218bda281e34a50454b5aff6d969c93d7ae5a074f6be7b9ac2cd897e35`.

The source reviewer inspected rendered pages, native text and source outlines
before seeing detector, parser or repair output. Both gold tranches remain
unchanged after that freeze. Labels are assistant-reviewed, not human-certified.
Missing glyphs, incorrect spatial relationships, corrupt OCR and intact native
math are distinguished. A detector true negative does not certify extraction.

Each full document receives fresh Java extraction using current repository
parser code. The heading arm reuses byte-identical native Java files, verified
by hashes, and applies the frozen change immediately after `correct_roles`,
before context, furniture and table recovery. Both arms are packed with current
code and their own furniture and repaired PDF. Native alternatives are then
applied to the heading arm, forming a combined experimental arm.

Every changed heading is queued for source review, including headings absent
from the outline. Exact body retention and unchanged chunks are separate
proxies. They cannot certify a discarded heading's role. Native-Alt evaluation
checks source/parse receipts, common implementation identities, original
character subsequences, metadata and list-item counts. Those invariants do not
prove that a source-authored alternative describes the visible equation well.

## Full-document outcomes

All 34 originals were attempted. **32 complete paired runs cover 11,446 pages.**
These are 32 fresh Java extractions followed by paired refinement, not 64
independent Java runs. Two original comparisons remain unmeasured:

| Original source | Observed outcome | Interpretation |
| --- | --- | --- |
| MHLW Population 2024, 26 pages | Baseline completes in 429.3 s, including 417.4 s of OCR on 12 pages. The candidate exceeds the shared 600 s paired deadline. | Budget-censored comparison, not a baseline parse failure or a proven candidate slowdown. |
| ECB Annual Report 2024, 200 pages | Java fails in about 2 s with xref warnings and `unknown type of page tree node`. | Original input failure before either repair is applied. The derived-copy experiment is kept separate. |

### Heading candidate

Of 32 completed pairs, **20 have identical complete chunk records** and 12
change headings. The candidate demotes 4,281 recurring margin blocks and changes
91 root levels. It retains all 120,225 previously covered body units and all
2,554 matched outline anchors; no exact body payload changes are found. These
retention checks are not semantic-accuracy scores.

Chemistry matches 38/38 source roots and corrects 37 levels; Biology matches
53/53 and corrects 52. Their stale-prior-root proxy falls from 2,867 and 4,300
chunks respectively to zero. BCcampus contributes two source-verified root
corrections, and NIST extends the running-header checks beyond Prince. Source
review checks every changed margin text/box, visually samples their full pages,
and visually inspects all changed roots. Incomplete-root books abstain on root
correction, even when their publisher footers are removed.

**BOJ exposes an interaction that prevents a no-regression verdict.** Removing
the recurring publication header leaves an alternating chapter/section header
in the heading stream. That other header can now persist into later breadcrumb
paths. The direct demotions are genuine furniture and body text survives, yet
the resulting paths gain unwanted header components. PDF pages 35 and 51 are
concrete examples. The [heading review](2026-09-20-unseen-headings.md) retains
the source-region comparison and before/after paths; the document remains
flagged for review.

The source-region audit identifies 419 cited boxes on eight pages, across 25
candidate chunks: 418 gain chapter running-header components, and one body box
on p59 inherits the diagram label `8兆円` from p58. All 4,372 direct changes were
source-adjudicated; this indirect regression remains flagged despite zero
pending direct-change reviews.

### Native-alternative candidate

The combined arm inventories 40,014 supported source alternatives and inserts
13,987 into 5,839 blocks. **All seven modified documents are new OpenStax
Prince PDFs.** Twenty-one completed documents have no alternatives supported
by this prototype; four have supported candidates but no insertions. Those
25 documents are abstentions/no-change controls, not recovery successes.

| New source | Insertions | Modified blocks |
| --- | ---: | ---: |
| Introductory Statistics | 1,187 | 494 |
| Computer Science | 11 | 9 |
| Chemistry | 1,796 | 711 |
| Biology | 29 | 13 |
| Precalculus | 10,846 | 4,535 |
| Microeconomics | 12 | 8 |
| Astronomy | 106 | 69 |

All 14 frozen missing-math witnesses received semantic output judgments:
**2 pass, 10 fail, 2 are partial**. The two partial cases retain part of the
relationship through nearby prose while the display itself remains absent.
These purposive cases are not a prevalence or whole-book recovery estimate.
Preserving original characters did not prevent the false insertions described
below.

## Geometry result

The unchanged detector found **2 of 14** frozen math-loss regions, missed
**12**, and falsely marked **1 of 62** negative controls. The remaining 68
heading, furniture or corrupt-OCR cases are outside the binary detection task.
Evaluation covered 70 pages in about 5.44 seconds.

The two detections were an inline fraction in Statistics p111 and inline
`f(March) = 31` in Precalculus p21. Display/raster math losses in different
exporter families were missed. The false positive was a graph in the MIT
calculus source. This candidate is not a reliable general math-loss gate.
See the [visual review](2026-09-20-unseen-pdf-visual-review.md) for individual
cases and actual-output assessment.

## New failures exposed by the holdout

The native-Alt prototype is not safe to promote as literal text recovery. In
Statistics, a systematic post-run sample of 12 actual insertions found a
decorative description of an ENTER key inserted into an instruction on p835,
and an ambiguous rendering of the logarithm operator as letter multiplication
on p328. Ten other sampled alternatives corresponded visibly to their
formulas. This small, systematic diagnostic sample is not a document-wide
error-rate estimate. It demonstrates that `/Placement` being absent and exact
native-character agreement do not establish literal inline semantics.

The source-only p111 median-fraction witness is repaired. Its two display mean
equations remain absent, as do the mean and standard-deviation displays on p242.
The p242 combined chunk still has confidence **1.0 with no reasons**. Accessible
alternatives exist for those displays but the conservative prototype excludes
block placement. It therefore both repairs some real omissions and leaves
other known omissions untouched.

The new corpus also exposes failures beyond missing glyphs:

| Source witness | What survives or fails | Why the current assurance misses it |
| --- | --- | --- |
| Computer Science p217 | Signed integer bounds lose exponent scope and become `[–2n – 1,+2n – 1 – 1]` | Glyphs are native; detector is correctly negative for missing glyphs, but chunk confidence is 0.992 without reasons. |
| NIST FIPS 203 | `3329 = 2^8 × 13 + 1` and the BitsToBytes exponent lose superscript scope | The same structural loss occurs in a LuaTeX document, with chunk confidence 0.996/1.0. |
| NTNU linear algebra p2 | Three matrices lose row/column grouping and mix bracket, vector and variable pieces | All/most native symbols can survive while the relation becomes unusable; chunk confidence is 1.0. |
| J-STAGE historical statistics p1 | Mean and variance displays are missing from raw blocks and chunks | Dense surrounding prose prevents whole-page selective OCR; confidence remains 1.0 without reasons. |
| W3C complex table p1 | Raw rowspan/colspan structure is flattened during packing | Word retention does not preserve the multi-level Results header relationship; table-width checks flag unevenness but do not reconstruct associations. |
| Arabic calculus p2/p4 | A credit label/value is absent and text order reverses | Low confidence flags these examples, but neither experimental repair fixes them. |
| SNU admissions p5/p6 | A simple date row survives; a grouping column separates into other chunks | A passing simple table control does not establish grouped-table fidelity. |

Raw blocks, final chunks, scores and source crops are retained in the visual
review artifacts. Cases without an output judgment are explicitly unassessed.
Neither source-only gold nor a detector true negative is counted as a passing
extraction test.

The final output join has 138 available witness records and six unavailable
records from the original ECB/MHLW runs. Of all 144 source witnesses, **37 have
manual semantic judgments and 107 are explicitly unassessed**. The assessed
subset has 12 passes, 18 failures and seven partial results; it was selected for
diagnosis and is not a corpus accuracy denominator. The separate insertion
audit covers 29 alternatives and finds one prose-description insertion and six
degraded mathematical meanings.

A further post-freeze insertion audit found cardinality described as absolute
value and two different outer-join symbols rendered as the same word in
Computer Science. A Chemistry alternative describes chemical state notation
using multiplication/power language. These are additional diagnostic findings,
separate from the 144 frozen source witnesses.

## A separate repair for the ECB reader failure

The [ECB development experiment](2026-09-20-unseen-ecb-repair.md) tests a derived
copy after the original failure. An independent publisher download is
byte-identical to the frozen source, and Java fails again on those original
bytes. The evidence points to reader incompatibility with this PDF's six
incremental revisions and hybrid cross-reference structure; it does not prove
the source violates the PDF specification.

The smallest successful arm reserializes with PyMuPDF 1.28.2:

```python
derived = document.tobytes(
    garbage=0, deflate=False, no_new_id=True,
    encryption=pymupdf.PDF_ENCRYPT_KEEP,
)
```

The rewritten ECB copy completes the full current parser in **25.129 seconds**.
Its 200 page-text hashes, RGB pixel hashes at 72 dpi, geometry, all 96 outline
destinations, links and metadata match the original. Cross-reference history
is flattened; other decoded streams and catalog key/value mappings are
preserved in the measured comparisons.

Eight additional corpus controls add 230 pages across Prince/Pressbooks,
LaTeX, W3C tables/columns, Korean, Arabic and a historical scan. These controls
caught a real defect in the initial save settings: default serialization
removed the scan's encryption. The revised explicit keep-encryption arm
preserves that source's encryption dictionary and permissions. **All 430 pages
across nine PDFs pass the repeated text, pixel, geometry, outline and link
checks**, with metadata equal. Both experimental arms and their receipts are
retained.

This is evidence for a narrowly triggered retry on the demonstrated reader
failure, not automatic normalization of every upload. It does not certify all
extracted blocks, signatures, interactive behavior, other encryption types or
every PDF viewer. No production retry was added. The ECB original remains a
failed holdout input; neither its derivative nor these reused controls increase
the 32 completed original pairs.

## What to change next

1. Resolve alternating running headers together before rebuilding section
   context. Keep source-outline protection and complete-root abstention. The
   current single-header deletion is insufficient; do not add per-book strings.
2. Keep PDF-supplied alternatives distinguishable from literal extracted text.
   Test recovery against visible operator, exponent, matrix and chemical-state
   meaning. Source authenticity and correct placement are insufficient gates.
3. Preserve or expose display equations, matrices and grouped chart/table
   regions as structured or visual evidence. Dense native prose and a high
   text-layer-agreement score cannot certify those relations. The current
   small-vector detector cannot be the sole selector or warning gate.

These sources now become regression cases. Any candidate changed in response
to them needs a further unseen tranche; tuning and then rescoring the same
holdout would not establish generalization.

## Execution conditions and limits

Parsing runs in isolated local containers with networking disabled and two CPU
cores per worker. The main workers use 6 GiB memory caps; the separate Astronomy
worker uses 4 GiB. They use dependency image
`capy-kb-parser:pilot-v4` (`sha256:495258462aeb92d238512c26c33862fa762baba490651b2c53f4d75696530b67`).
The implementation comes from the read-only current checkout, not the image's
bundled parser. Model hashes and environment details are recorded separately.
The deadline is 600 seconds for the whole paired document, not per arm.

The first bind-mounted run was interrupted because large-PDF random reads
spent minutes in Docker's Windows filesystem bridge (`p9_client_rpc`). Those
artifacts remain in `parse-bindmount/`. The scored run uses a Docker named
volume for temporary files; completed structured artifacts are exported after
parsing. Native/image assets remain on that volume. This setup change does not
change source or candidate code hashes.

This calls `refine.parse_pdf` directly. HTTP admission, artifact envelopes,
storage quota, embedding, retrieval and model answers are outside the measured
path. Four PDFs exceed the HTTP endpoint's default 100 MiB source limit; their
results exercise parser algorithms, not acceptance by the deployed endpoint.
Candidate Java-cache timing and shared OCR initialization cannot establish a
parser speedup or an independent throughput result.

Benchmark checks were corrected before accepting the final results. Every
heading change now requires source review; root-context metrics abstain across
unmatched outline intervals. The visual collector originally scored only
selected baseline chunks, which incorrectly changed the page-coverage score.
Version 2 scores the full book before selecting witnesses and uses the measured
PDF. Its earlier J-STAGE 0.829-to-1.0 contrast is withdrawn. A separate invariant
checks complete chunk/confidence equality on zero-intervention documents.
Old diagnostic outputs remain distinct from the accepted versions.

Targeted Ruff formatting/lint checks, runner/heading self-checks, source/parse
identity checks and an independent closing review accompany these runs. No
production behavior was changed by those harness corrections.

## Reproduction and retained artifacts

The dependency image must already be present. Use container-local storage for
`/output`, mount this checkout read-only at `/repo`, and run:

```sh
python /repo/bench/parsers/scripts/run_unseen_pdf_parse.py \
  --manifest /repo/bench/parsers/fixtures/unseen-pdf-sources-2026-09-20.json \
  --output /output
```

Export completed receipts, content lists, refinement metadata and any
`parsed.pdf` to the local `parse/` directory. Retain the full volume when native
assets are needed. Then run:

```powershell
uv run --frozen python bench/parsers/scripts/evaluate_unseen_headings.py
uv run --frozen python bench/parsers/scripts/evaluate_unseen_native_alt.py --manifest bench/parsers/fixtures/unseen-pdf-sources-2026-09-20.json --parses bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/parse --output bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/native-alt-r2
```

All local receipts are under
`bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/`:
`parse/`, `heading-evaluation/`, `native-alt-r2/`, `visual/`,
`parse/environment.json`, download receipts and `methodology-review.md`.
Completed and unmeasured documents are reported separately; unchanged or
abstained documents are not recovery successes.
