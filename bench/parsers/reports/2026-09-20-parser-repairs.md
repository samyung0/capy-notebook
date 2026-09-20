# Parser repairs after the capture-first decision

Implemented the three approved changes: visual verification in the agent loop,
source-confirmed heading repairs, and one bounded retry for the demonstrated
Java page-tree failure. Nothing was deployed or re-ingested. This round did not
change knowledge-base builder code, data, jobs or publication state.

## Why these changes

The investigation found three different problems:

- Extraction confidence measures agreement with the PDF text layer. It can be
  high even when an equation or table's visual meaning is missing. Chat and
  curate prompts now require page capture before using source-specific numerical
  results, formulas, table relationships or figures, regardless of confidence.
  Captures must retain the labels needed to interpret a detail. Unavailable or
  illegible details must be reported as unverified. No new recognition model or
  numerical reconstruction heuristic was added.
- Java's inferred heading levels can keep a book's Contents heading above later
  chapters, or make recurring page banners ancestors of prose. Complete source
  outline matches now establish roots. Repeated literal titles establish a
  narrow running-banner band; alternate titles require every rendered line to
  match a larger body heading on the same or an earlier page. Matching is based
  on source spans, geometry and typography, with no book-specific names.
- The ECB source has an xref/page-tree representation that the Java reader rejects.
  The exact `unknown type of page tree node` failure now permits one PyMuPDF
  rewrite with encryption preserved, followed by one Java retry in a clean
  output directory. Both calls and the rewrite share the original Java deadline.
  Other errors and timeouts propagate normally.

Removing a banner also removes a boundary that previously stopped a deeper
heading. This caused the earlier BOJ candidate to carry chart labels into later
pages. Newly discarded banners now retain their former heading-level boundary
without adding banner text to the section path. Both packing paths clear that
level and deeper levels. This avoids adding another graphic-label classifier.

Root promotion is also guarded against expanding beyond an existing section
boundary. A uniquely source-confirmed outline child or split-title continuation
can extend the root's scope. Unproven peer headings and neutral banner boundaries
cause the document's root promotions to abstain; banner repair still applies.
This guard caught and prevents new Copyright→Contents ancestry in LibreOffice
and Contributors→back-cover ancestry in OECD. It preserves the original levels
on those two documents, deliberately giving up the earlier OECD Part A correction.

The original PDF remains the capture source. If font or page-tree repair changes
the measured PDF, its bytes travel in `parsed.pdf` for later heading and confidence
checks. Artifact schema remains bundle-v4; parser/client implementation is
`odl-2.5.7-refined-rapidocr-v5`, and chunker identity is v11. A future rollout must
keep parser and client identities aligned. Existing indexed content is unchanged
by these working-tree edits.

## Broad regression evidence

The earlier independent corpus contains 34 public PDFs, 11,672 pages, seven
languages and 12 exporter families. Its failures and incomplete runs remain in
the [original report](2026-09-20-unseen-pdf-validation.md).

The completed 32-document caches were replayed with the corrected banner
behavior. These are regression inputs now, not unseen validation:

| Check | Result |
| --- | ---: |
| Banner demotions | 4,323 |
| Chunks before → after | 33,156 → 31,996 |
| Shared cited regions without unintended path changes | 120,913 / 120,913 |
| Body occurrences without unexpected heading-scope changes | 121,157 / 121,157 |
| Previously covered body units retained | 120,225 / 120,225 |
| Matched outline anchors retained | 2,554 / 2,554 |

The original Physics cache separately passes. BOJ's 88 banners include the 42
alternating headers missed by the prior candidate. The source-span classifier
took 0.268 seconds total after evidence collection; evidence collection took
49.7 seconds across the 32 documents. These are local replay observations, not
service latency measurements.

Fresh production BOJ and Chemistry runs match the cached tested candidate at
every final block (19,540 dictionaries) and every chunk text/path/page/region
signature (3,118 chunks). Confidence annotations were excluded because the
cached packing experiment did not score them. All 13,447 previously covered
body units and 262 matched anchors survive. This closes the gap between cached
role experiments and the complete parser/refinement/packing path.

Detailed receipts and the occurrence audit are retained under
`reports/local/2026-09-20-unseen-pdf-validation/coherent-role-experiment/`.
The receipt distinguishes the baseline functions captured at process start
from later on-disk hashes observed during integration.

The subsequent 37-document scope-guard replay changes only LibreOffice's one
and OECD's five proposed root promotions. Chemistry retains 37, Biology 52,
BCcampus 2, and the separate original Physics case 26. Both affected documents
preserve all source payloads and covered body units, with zero unintended
breadcrumb changes against baseline after excluding intended banner removals.
OECD retains its 493 banner repairs.

## Fresh full-document runs

Five more public PDFs were selected and downloaded independently of candidate
output. Their source hashes were checked against the prior fixture inventory.
Twenty source-only visual witnesses were frozen before parsing. After those
sources exposed the scope regressions, two untouched manuals and six further
source-only witnesses were frozen for final validation. The wider investigation
now includes 41 distinct online PDFs and 13,347 pages.

All eleven final production runs completed: seven newly collected sources plus
four regression controls, 3,190 pages in total. Every final block list and chunk
text/path/page/region signature matches its tested reference. References are the
earlier fresh run for unchanged cases, the guarded prototype for LibreOffice and
OECD, and paired old-production output for the two untouched controls.

| PDF | Pages | Parse seconds | Chunks |
| --- | ---: | ---: | ---: |
| An Introduction to R | 103 | 9.73 | 279 |
| forall x Calgary | 437 | 72.00 | 617 |
| OECD Education at a Glance 2024 | 498 | 79.47 | 1,476 |
| LibreOffice Getting Started 7.5 | 531 | 50.96 | 1,772 |
| WeasyPrint sample report | 8 | 9.24 | 17 |
| ECB Annual Report 2024 | 200 | 27.60 | 477 |
| BOJ Financial System Report | 100 | 26.36 | 297 |
| OpenStax Chemistry 2e | 1,203 | 196.67 | 2,821 |
| J-STAGE 1949 statistics scan | 12 | 4.75 | 36 |
| [Lua 5.0 Reference Manual](https://www.lua.org/ftp/refman-5.0.pdf) | 71 | 15.14 | 169 |
| [LaTeX for authors](https://www.latex-project.org/help/documentation/usrguide.pdf) | 27 | 3.11 | 76 |

These times exclude downstream packing/scoring and include contention from
concurrent isolated containers. Each container had two CPUs, a 6 GiB limit,
no network, a read-only repository mount and a 600-second per-document process-
group deadline. All three final-run containers exited successfully without OOM. They used
`capy-kb-parser:pilot-v4` only as a dependency image; current parser code was
loaded from the mounted repository. No shared parser or database was called.

ECB retried once: initial Java failure 0.95 s, rewrite 0.24 s, successful Java
retry 10.01 s. All 200 pages retained identical text and rendered pixels;
geometry, outline, permissions and encryption also matched. The encrypted
J-STAGE control used one Java call and kept the exact original PDF bytes.

## What the independent witnesses still miss

The five-source tranche's final result is **13 passes, six failures and one
abstention** on 20 frozen role witnesses, matching old-production outcomes on
those selected checks. The image-only chart label is an abstention, not successful
text extraction. The first integrated candidate scored 14/5/1 but introduced two
scope regressions outside the frozen cases. Those failed outputs remain preserved.
The final guard removes both regressions and withdraws its Part A improvement.

The two untouched manuals pass **all six** final witnesses, with complete blocks
and chunks identical to old production. They validate preservation, not six new
repairs. Their [paired review](2026-09-20-heading-scope-release-review.md) records
the source-only freeze, following-prose scope and residual folio noise.

The failures are useful limits on this patch:

- Three forall x part roots are split between heading and body blocks. The
  complete-outline rule abstains and their part ancestry remains wrong.
- An even-page LibreOffice footer still enters later prose ancestry.
- A WeasyPrint price is still classified as a heading. Exact prices can be read
  through capture, but the false section path remains a retrieval-quality issue.
- OECD Part A retains its earlier false ancestry because the complete-root guard
  declines the document's promotions after detecting the unlisted back-cover boundary.

An OECD executive-summary folio also remains a false child heading; that extra
observation is outside the frozen denominator. These cases should inform a
separate structural repair experiment rather than be counted as resolved by
more lenient numeric accuracy. See the [independent release review](2026-09-20-heading-release-review.md)
for source links, page-level evidence and scoring limits.

## Agent and test validation

The production chat loop, updated prompt, capture guard and renderer were tested
with real GLM-5.3-Flash responses on three high-confidence passages. All three
retrieved, captured and read the expected formula or table fact. Each case first
attempted capture before retrieval; the existing guard refused it, and the model
then retrieved and captured successfully. The [capture probe report](../../rag/reports/2026-09-20-capture-visual-probe.md)
records all calls and limitations. This is a three-case feasibility check with
deterministic local retrieval, not a model reliability estimate or live KB test.

- 293 focused offline tests pass across roles, refinement, Java retry, client,
  capture, agent, retrieval helpers and both chunkers.
- 35 parser-app/Java tests pass in an isolated Linux dependency image. The
  persistent spawned parser-child test hangs under the Windows harness, so its
  service-boundary tests were run on Linux.
- Banner/boundary cases cover source evidence, alternating titles,
  abstention, outline protection, both packing branches, citations and unchanged
  scope continuity. Root tests also cover unmatched peers, uniquely proven children,
  split roots with descending numeric levels, and neutral boundary interaction.
  Java tests cover the one-retry limit, shared deadline,
  failed-attempt asset isolation and encryption/source fidelity.
- Independent implementation review is closed. Its test-coverage and neutral-
  boundary findings were addressed; no actionable findings remain in that review.
- Targeted Ruff format/lint checks and `git diff --check` pass. Formatting was
  limited to the changed files so the excluded knowledge-base code was not touched.

## Reproduction and retained artifacts

Source manifests and gold:

- `fixtures/unseen-pdf-sources-2026-09-20.json`, SHA-256
  `6a8bb30ed4e1d1a15736329f7c63f8c99a17173b51a9b3ce77d973ab467f4eda`.
- `fixtures/heading-release-sources-2026-09-20.json`, SHA-256
  `87447bf832777f9f1c29a9588270acb20d9e96115a9607f4bfbd1ba282262a43`.
- `fixtures/heading-release-gold-2026-09-20.json`, SHA-256
  `35d69a416c98a9be7ebf0e998ca779a5d4b92c6b6b85818c3f17ac93452c3e95`.
- `fixtures/heading-scope-release-sources-2026-09-20.json`, SHA-256
  `a359204a411525de6d12494d0f923b54e183a2006ee43892563b11165131d0e4`.
- `fixtures/heading-scope-release-gold-2026-09-20.json`, SHA-256
  `ba393e2bc21d8d9bf5c2a51a0010408bdfa3895edbdf15eee783ca6dfaf0191a`.

The fresh runner is `scripts/validate_parser_repairs.py`. In the isolated Linux
dependency image, mount this repository at `/repo` read-only and a writable local
volume at `/output`, then run:

```sh
python /repo/bench/parsers/scripts/validate_parser_repairs.py \
  --manifest /repo/bench/parsers/fixtures/heading-release-sources-2026-09-20.json \
  --output /output/new-sources
```

The output directory must be new. `--only` selects explicit manifest IDs. Each
worker verifies code/source identities before and after parsing, records heading
changes, and exports full chunks plus fidelity results. The local Docker volume
`capy-parser-release-validation-20260920` retains full work/native assets.
Selected receipts, logs and JSON outputs are copied to the ignored
`reports/local/2026-09-20-parser-repairs/`. Final guarded outputs and their frozen
code identities are under `final/`; `final-parity.json` records all eleven reference
comparisons and fidelity checks. Earlier candidate and paired baseline outputs
remain separate. One mixed newline in `parser/app.py` was normalized before the
final freeze; `format-receipt.json` retains the earlier byte hashes and proves its
AST unchanged. Capture-probe import ordering was also formatted after the live
run; the prompt and agent behavior were unchanged.

Cached/fresh integration comparison:

```powershell
uv run --frozen python bench/parsers/scripts/compare_parser_repair_regressions.py --only boj-financial2025 openstax-chemistry-2e
```

No automatic library migration or background refresh accompanies this patch.
