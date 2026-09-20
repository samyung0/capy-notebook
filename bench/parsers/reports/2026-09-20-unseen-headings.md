# Fresh PDF heading validation

Date: 2026-09-20. **Final original-source snapshot: 32 completed pairs, 11,446 pages**, from the frozen 34-document, 11,672-page manifest. Twenty pairs produce identical complete chunk records. Twelve change headings; source review supports the direct 4,281 margin banner demotions and 91 root-level changes. **One document, the Bank of Japan report, has a confirmed indirect breadcrumb regression.** The candidate removes one recurring header but exposes other false headings. Do not promote this frozen candidate as a generally regression-free fix.

Chemistry and Biology provide new complete-outline examples of the ancestry repair. BCcampus provides a smaller independent exporter example. The NIST publications extend the margin-banner result beyond OpenStax. Other OpenStax books often have unmatched roots, so the candidate abstains from changing their root levels; those books support only the footer result. No new body-text omission or matched-outline-heading loss was detected, but those retention checks do not rule out the BOJ ancestry regression.

## Confirmed regression: Bank of Japan

The 46 demoted instances of `金融システムレポート 2025 年 4 月` are genuine publication running headers. On alternating pages, a chapter/section running header is also incorrectly classified as a level-10 heading. The baseline publication header pops the preceding same-level running header and deeper false headings. Removing only the publication header lets those other false headings persist into the next page.

After excluding the intended removed banner component from both arms, **419 cited source boxes on eight PDF pages gain other breadcrumb components, affecting 25 candidate chunks**. Of these boxes, 418 gain alternate chapter/section running-header components; one body box on page 59 gains the preceding page's diagram label `8兆円` (8 trillion yen), which the baseline had incorrectly classified as level 11.

| Source content | Baseline path after excluding the targeted publication banner | Candidate adds |
| --- | --- | --- |
| PDF page 35 opening paragraph | `… › Ⅳ．金融機関が直面するリスク › １．信用リスク › （１）国内の信用リスク 企業の倒産動向` | The prior page's combined `Ⅳ．金融機関が直面するリスク １．信用リスク` running header |
| PDF page 51 opening paragraph/chart content | `… › Ⅴ．金融循環と環境変化に伴う課題 › １．国内の金融循環 › （１）金融循環と経済変動リスク` | The prior page's combined chapter-V/section-one running header |
| PDF page 59 opening paragraph | `… › Ⅴ．金融循環と環境変化に伴う課題 › ２．内外ノンバンク部門を巡るリスクと金融安定上の含意` | `8兆円`, from a diagram on page 58 |

The source pages 34/35, 50/51 and 58/59 were visually reviewed. Exact before/after paths, source boxes, affected chunk records and input hashes are saved in `heading-evaluation/boj-financial2025/source-review/region-path-comparison.json` and `region-path-regression.json`. The generic alert also remains active: stale-root chunks increase 56 → 57, and unexpected-root prose chunks 248 → 249. Targeted publication-banner paths fall 83 → 0; all 4,495 previously covered body units and eight matched outline headings remain retained. Those improvements do not erase the new breadcrumb errors.

This supports a coherent furniture/heading-role pass before building heading context, including interactions with alternate running heads and diagram labels. It does not justify tuning this frozen candidate on the holdout. No new implementation was attempted.

## Changed comparisons

| Source | Pages | Matched roots | Banner demotions | Root-level changes | Baseline → candidate chunks | Banner breadcrumb chunks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BCcampus Accessibility Toolkit | 101 | 14/14 | 0 | 2 | 238 → 238 | 0 → 0 |
| OpenStax Psychology 2e | 755 | 4/20 | 374 | 0 | 2,415 → 2,324 | 752 → 0 |
| OpenStax Introductory Statistics 2e | 847 | 16/24 | 420 | 0 | 2,548 → 2,453 | 210 → 0 |
| OpenStax Introduction to Computer Science | 939 | 3/18 | 466 | 0 | 2,731 → 2,622 | 611 → 0 |
| NIST AI Risk Management Framework | 48 | 6/13 | 32 | 0 | 167 → 167 | 43 → 0 |
| NIST FIPS 203 | 56 | 1/1 | 53 | 0 | 128 → 120 | 55 → 0 |
| OpenStax Chemistry 2e | 1,203 | 38/38 | 588 | 37 | 2,988 → 2,809 | 549 → 0 |
| OpenStax Biology 2e | 1,475 | 53/53 | 734 | 52 | 4,462 → 4,323 | 879 → 0 |
| OpenStax Astronomy 2e | 1,151 | 3/46 | 572 | 0 | 3,603 → 3,463 | 733 → 0 |
| Bank of Japan Financial System Report | 100 | 8/11 | 46 | 0 | 308 → 305 | 83 → 0; other errors grow |
| OpenStax Precalculus 2e | 1,411 | 16/17 | 702 | 0 | 4,243 → 3,871 | 530 → 0 |
| OpenStax Principles of Microeconomics 3e | 595 | 8/28 | 294 | 0 | 1,895 → 1,832 | 335 → 0 |

The 20 unchanged controls are Prince math/textbook/Icelandic samples; three W3C table/column samples; CTAN axessibility; Lille probability/course guide; MIT Strang Calculus; Bookdown; DMOI4; NTNU linear algebra; SNU admissions; MU calculus; the 1949 J-STAGE statistics paper; the ACL multilingual paper; QMUL probability; Census Income 2024; and INSEE Digital Economy 2025. Identical outputs do not validate their underlying extraction, math, reading order, or citation geometry.

## Retention and ancestry

Across all 32 completed pairs, the candidate retains all **120,225 previously source-bound, literally covered body units** from 121,157 eligible baseline units. No exact body payload was removed or reshaped, no newly missing covered unit was found, and no new citation/grouping displacement was found. All **2,554 matched outline anchors** remain headings and readable on their pages. The 932 baseline body units that were not literally covered are not counted as candidate successes. Unmatched outline headings are outside the anchor metric.

| Complete-root case | Stale prior-root ancestors | Unexpected root prefix on prose | Previously covered body retained | Matched anchors retained |
| --- | ---: | ---: | ---: | ---: |
| BCcampus | 1 → 0 | 124 → 122 | 568/568 | 119/119 |
| Chemistry | 2,867 → 0 | 2,339 → 0 | 8,952/8,952 | 254/254 |
| Biology | 4,300 → 0 | 3,954 → 0 | 11,180/11,180 | 530/530 |

For example, Chemistry's chapter-one prose changes from `Contents › PREFACE › Essential Ideas › 1.1 Chemistry in Context` to the chapter root and its section. Contents and Preface remain readable headings. Biology shows the same correction across its chapter roots. BCcampus's `KEY CONCEPTS` and `BEST PRACTICES` are visibly PART I/II headings on PDF pages 19 and 31. Its 122 remaining prefix mismatches reflect existing child-level/outline differences; correcting only roots does not repair an entire outline tree.

Chunk count changes from 33,156 to 31,957. There are 4,086 removed and 2,887 added canonical chunk strings, chiefly because discarding furniture permits different packing boundaries. These counts are **not text-loss counts**: the source-bound body and heading checks above remain unchanged. BCcampus and NIST AI RMF preserve the entire canonical chunk-text sequence while their breadcrumbs change. Targeted banner breadcrumb chunks fall 4,780 → 0 overall; this metric excludes the alternate-header pollution found in BOJ.

## Source adjudication

Every changed or discarded heading receives a review entry, including headings absent from the PDF outline. An unreviewed, uncertain, or regression decision keeps `requires_review` true even when automated proxies raise no alarm. `proxy_alarm=false` alone is not evidence that a repeated genuine heading was correctly discarded.

All changed margin occurrences were checked independently against literal source PDF text in their bounding boxes and margin positions. Full-page visual samples cover early, middle, and late occurrences in each changed document: Psychology 8/382/754; Statistics 8/428/846; Computer Science 8/474/938; NIST AI RMF 5/22/47; FIPS 203 3/30/56; Chemistry 8/596/1202; Biology 8/742/1474; Astronomy 8/580/1150; BOJ 7/49/53/97; Precalculus 8/710/1410; Microeconomics 8/302/594. They are publisher access footers or publication running headers outside the real section flow. Visual review was sampled; literal and geometry checks cover every direct banner demotion. BOJ's direct demotions are source-supported while its indirect regression keeps the document's review flag active.

All 91 changed roots were visually reviewed in source contact sheets and tied to level-one PDF outline entries on the same page. Chapter bounding boxes can also contain a separate `CHAPTER` label; those labels are preserved. Source checks, rendered pages, review decisions and their hashes are saved under each document's `source-review/` and `source-reviews.json`.

## Measurement rules and limits

Both arms use the current repository parser and fresh Java output. The candidate reuses byte-identical native output and applies the unchanged [heading prototype](../scripts/experiment_prince_headings.py) at the production heading-role stage, before context, furniture freezing and table recovery. Each arm uses current `pack_blocks`, its own furniture and current `retain_headings`, measured against its own repaired PDF when present.

Body identity uses page, block type, bounding box and exact text-bearing payload; it does not assume stable block indices after later parser stages. Readability normalizes whitespace and the chunker's inline representation while preserving case, punctuation, numbers and symbols. A previously covered unit must still appear in chunks citing its source box. Text found only elsewhere on the same page is reported separately as citation/grouping displacement. These are retention proxies, not rendered-page fidelity scores.

Outline anchors are relocated independently in each final block list. Ancestry scoring abstains across unmatched or ambiguous root intervals and before the first source-matched root. It never extends a matched Preface across an unmatched chapter. A prior root counts as stale only when it is an ancestor of the active root, not a legitimate later subheading in a links index. Native tables with independent titles are excluded from the prose-prefix check. Chunk regrouping changes the number of eligible contexts, so partial-outline counts are not direct accuracy rates. Earlier evaluator versions and summaries are preserved.

## Execution and provenance

The initial Windows bind-mounted run was stopped because shared-filesystem I/O dominated execution; its artifacts remain under `parse-bindmount`. Results here use reruns with the same frozen code/source hashes in a local Docker volume. No initial-run timings are used to claim throughput. All 34 original statuses are terminal: 32 completed pairs, MHLW Population 2024 timed out during the candidate after completing its baseline, and ECB Annual Report 2024 failed Java before baseline completion. Both incomplete pairs remain unmeasured. MHLW is a paired-budget timeout, not baseline parser failure. Any separate PDF-repair experiment is outside this original-source holdout.

Frozen manifest SHA-256: `6a8bb30ed4e1d1a15736329f7c63f8c99a17173b51a9b3ce77d973ab467f4eda`.
Frozen heading prototype SHA-256: `5ab0ca12119547ff7c201a6ebed34d980d43fb43e2314f7a5964afe3421ab5e6`.
Current evaluator SHA-256: `d061e53af3e5bfc7c61146c3b41ff826d508e4ffb2fcc34d50cd3e1276714786`.
Per-document records include PDF/parse-artifact hashes, evaluator/chunker hashes, chunk records, body differences, source reviews and the complete heading queue. Changed input/code versions get separate `run-<hash>` directories.

```powershell
uv run --frozen python bench/parsers/scripts/evaluate_unseen_headings.py --self-check
uv run --frozen python bench/parsers/scripts/evaluate_unseen_headings.py
uv run --frozen --with ruff ruff check --no-force-exclude bench/parsers/scripts/evaluate_unseen_headings.py
```

Self-check and Ruff pass. The self-check exercises reordered block identities, regrouping, body loss, changed citation geometry, case preservation, mandatory review of non-outline heading demotions, unmatched-root abstention, and a legitimate repeated chapter title beneath a links-index root.

Results are under `bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/heading-evaluation/`. No production code, parser identity, deployment or frozen candidate was changed.
