# OpenDataLoader accuracy, third pass

Date: 2026-09-09. Benchmark experiments only; production parsing is unchanged.

The selected native candidate takes **63.316 seconds for 335 pages**, including
fresh Java parsing, source repairs and final chunking. The matched existing
MinerU configuration takes **1,073.408 seconds for parsing**, before chunking.
That is a **16.95× observed parser-stage advantage** despite including chunking
on the OpenDataLoader side. Uploads, captioning, embeddings, queues and model
downloads are outside both measurements. Qwen captioning was not investigated.

The repairs materially improve source text, citations, section context,
scientific notation and selected tables. They do **not establish general
quality parity with MinerU**. On the initially independent numeric-table set,
neither parser consistently preserves complete table meaning, and MinerU does
better. The remaining safe native strategies tested in this pass have reached
a practical stopping point; relaxing their source guards caused errors or
could not resolve the remaining ambiguities.

## Corpus and comparison method

The main corpus contains 13 complete publisher PDFs, 335 pages:

- The previous eight documents, 254 pages: Attention, TALN complexity, CCL
  feedback, Spanish figures, Japanese migration, German education, Hong Kong
  figures and NIST accelerometers.
- Two neighboring CCL papers, COT and children, 45 pages.
- BERT, ResNet and NIST Shot, 36 pages, added with frozen source identities and
  source-rendered checks before testing the candidate on them.

The source manifests and checks are
[`odl-independent-sources.json`](../fixtures/odl-independent-sources.json) and
[`odl-independent-checks.json`](../fixtures/odl-independent-checks.json), plus
the earlier font-transfer fixtures. Full local manifests are
`local/2026-09-09-odl-third-pass/{all-sources,extended-r1-sources}.json`.
They bind original PDFs, parsed PDFs, native outputs and chunks by SHA-256.

BERT and ResNet later informed the exponent and continuation repairs. They are
therefore **not untouched final holdouts**. A further 22 historical document
entries, 430 pages, exercise multilingual PDFs, lecture decks and Office
conversions. Some are related or derived documents. This is regression
coverage, not 22 independent samples. Source selection and audit plans were
frozen before inspecting the new candidate; one discovered duplication led to
a documented fix and replay on that same corpus.

Quality judgments use rendered source pages and actual indexed chunks. They
are scoped model-reviewed source checks, not a human-certified overall
accuracy benchmark. Literal value presence, ordered row sequences, complete
table meaning and styling are kept separate. Production MinerU chunking is the
comparison arm; an alternate bounded packing replay is retained only as a
diagnostic.

## Selected native changes

The candidate retains cluster table detection and `--include-header-footer`.
It builds on the second pass's font-map repair, Japanese table context, French
cell highlights, source headings and hidden-text reading order.

| Addition | Verified result on 335 pages |
| --- | --- |
| Source-proven overprint deletion | 76 text blocks repaired, removing 1,064 duplicated glyph characters |
| Paragraph-role repair | Two NIST continuations remain body text rather than section labels |
| List descendant geometry | 64 list boxes expanded using exact same-page native descendants; source text and final citations checked |
| List overprint deletion | 35 lists repaired, removing 1,012 duplicated glyph characters; item and whitespace boundaries preserved |
| Scientific exponents | 18 source-raised powers restored; two ambiguous identical occurrences abstain |
| Column continuations | Two complete blocks moved ahead of intervening small print; five frozen prose checks improve from 3/5 to 5/5 |
| Native source tables | 26 reviewed replacements, 135 rows, with headers, units, notes, explicit spans and numeric emphasis |
| Omitted source labels | 38 source-visible labels retained, including the final Hong Kong map-title recovery |
| Footer ancestry | 49 Hong Kong table blocks retain all their raw data and boxes but inherit the native parent's explicit footer classification |

List geometry runs before text repair. It requires exact Java list identity,
text and parent geometry, and follows only descendants that the adapter
actually flattens. This corrects under-sized citation boxes without guessing a
larger page region. The corrected boxes unlock ten additional list repairs.

Table replacement requires complete source/native coverage and preserves
every retained block. All 26 recovered table objects are identical to the
earlier source-reviewed composition. Glyph recovery makes two children-paper
tables recoverable without relaxing the table guard. Numeric bold and shaded
cell markers survive; full typographic fidelity is not claimed, notably for
bold row labels.

The footer fix follows parser metadata rather than guessing from page numbers.
It requires a unique native ID, matching page and identical re-adapted table
HTML under an explicit `footer` ancestor. Header ancestry remains separate.
Across 335 pages, every chunk change caused by this final addition is explained:
49 footer chunks disappear, one valid map-heading chunk appears, the other
199 Hong Kong chunks remain exactly equal, and the other 12 documents' complete
content and chunk arrays remain equal. Japanese repeated table headers survive.

Implementation and focused checks live in
[`refine_odl_output.py`](../scripts/refine_odl_output.py). It composes these
repairs before one final chunk pass and retains phase evidence. The fresh
runner calls the same helper; all 13 fresh outputs before the footer addition
match their independently replayed composition exactly.

## Comparison with existing MinerU

These are distinct denominators, not components of one overall score.

| Frozen source check | Fresh Java baseline | Selected native candidate | Existing MinerU |
| --- | ---: | ---: | ---: |
| Text and paragraph checks | 7/16 | 16/16 | 14/16 |
| List-label checks | 0/8 | 7/8 | 8/8 |
| Section-context checks | 2/12 | 12/12 | 4/12 |
| Omitted-label and negative controls | 3/30 | 30/30 | 29/30 |
| BERT/ResNet prose order in chunks | 3/5 | 5/5 | 5/5 |
| Ordered rows in the 61-row numeric rubric | 22/61 | 22/61 | 29/61 |

The shared literal scorer checks chunk body and indexed text separately, so an
ancestor label adjoining a body label cannot cause a false mismatch. Frozen
source strings and boundary rules remain unchanged. Scores and individual
verdicts are written by
[`score_odl_refined.py`](../scripts/score_odl_refined.py) and
[`score_odl_independent.py`](../scripts/score_odl_independent.py).

The [37-table source comparison](2026-09-09-odl-mineru-table-comparison.md)
examines complete table-local meaning: row labels and values, column/group
scope, table identity, units, notes and citations.

| Source-table set | Selected OpenDataLoader | MinerU |
| --- | ---: | ---: |
| 26 selected development recoveries, 135 rows | 26/26 complete | 7/26 complete |
| 10 initially independent numeric tables, 61 rows | 0/10 complete | 4/10 complete |
| Complex ResNet architecture table | Incomplete | Incomplete |

The development subset was selected while improving the native recovery and
must not be presented as representative parser accuracy. MinerU also makes
source-visible errors: shifted Hong Kong rows, lost shared cost spans in
Attention, collapsed BERT rows and incorrect caption/header associations.
The independent results show the remaining OpenDataLoader weakness clearly:
complex or collapsed existing tables do not become correct merely because all
their numbers are present. The conservative recovery abstains on them.

Earlier verified gains survive composition. The Japanese table retains all
48 rows and 384 numeric cells with self-contained header/title/unit context.
TALN's entire source-styled raw output and chunk array remain exactly equal to
the verified second-pass output.

## Selective formula strategy

The [formula experiment](2026-09-09-odl-math-recovery-experiment.md) uses the
installed MinerU layout/formula components selectively with OpenDataLoader.
It is a hybrid option, not part of the native timing above.

The complete 335-page source audit admits 19 historical-scan pages, rejects
316 digital pages, detects nine formula regions and makes 18 recognition calls
at two crop margins. Final recovery yields **6/7 complete accelerometer
expressions**, compared with **2/7 for the matched MinerU output**. All five
selected citation regions cover the source formulas. The two paragraph repairs
and eight prose checks survive composition. The other 12 documents remain
byte-for-byte equal to their native candidate inputs.

The independent NIST Shot formulas remain **0/5 for both parsers**. Crop
agreement alone is insufficient: both crops repeated an incorrect `M3` to
`M8` substitution in a short definition. That failed arm is retained. A
revised source-prose guard prevents the replacement; equation 4 remains an
explicit abstention. This guard was developed after that failure, not validated
on an untouched holdout.

The sequential model processes take **55.032 seconds**, including Python/model
imports. Peak process RSS is 993.6 MiB for layout and 2,993.2 MiB for formula
recognition. Those are component measurements, excluding container creation
and OpenDataLoader parsing. No integrated hybrid latency is claimed by adding
unlike timers. No provider or Qwen calls were made in this pass.

## Rejected alternatives and regression findings

| Strategy | Result |
| --- | --- |
| Default built-in table detector | Same independent numeric/prose scores; one extra valid Hong Kong table, but loses seven explicit telecom label/value associations. Rejected globally. |
| Omit `--include-header-footer` | Removes 49 false Hong Kong footer tables, but also removes genuine Japanese repeated table headers on source pages 49 and 51. Rejected globally. |
| Broader table integration | Failed variants lose source/native values or assign wrong header/group scope. Full-coverage guards retain the failures and abstain. |
| OCR confidence or two-engine consensus | Confidence does not prove source fidelity; stricter consensus supplies no safe new text replacement. |
| Formula crop agreement alone | Admits the wrong `M8` definition; protected prose and native alignment are required. |
| Missing-hyphen repair restricted to inline source glyphs | All three remaining target hyphens occur at physical line ends. The source precondition fails; no implementation or repair is admitted. |

The [hyphen rejection](2026-09-09-odl-inline-hyphen-experiment.md) preserves
source crops for `GPT-` / `3.5`, `low-` / `quality`, and `Gemini-1.0-` / `pro`.
The other list abstentions include prime/subscript ordering and a whitespace
boundary ambiguity. Their source text is insufficient for the current exact
proof; no fuzzy correction is substituted.

The 430-page regression selects no font, exponent, text-overprint, list-overprint,
column-continuation, source-table or footer-table repairs. It adds 25 supported
list-box expansions and 16 source-visible labels after one fix. These are
negative controls for most rules, not new positive transfer evidence.

That corpus exposed an unnecessary standalone German bullet ending in `fest-`.
Its text already existed in a section path, but normalization joined it with
the following body `stellen`, hiding the match. The corrected presence check
inspects body and section path separately. All 335-page outputs remain exact;
the 430-page replay removes only that duplicate chunk. The final fresh run has
999 chunks versus 1,000 before the fix.

An inherited limitation remains: a short CamemBERT bibliography tail is present
in raw output but absent from both baseline and candidate chunks because of
existing minimum-size packing. It is documented rather than counted as a new
geometry failure or silently repaired in production.

## Timing and reproducibility

All fresh runs use the idle ingest VM with sequential document execution,
8 CPUs, 14 GiB memory and 28 GiB combined memory/swap limit. Native runtime:
OpenDataLoader 2.5.7, PyMuPDF 1.28.2, pypdf 6.18.0, Python 3.12.14, Java
threads 1. MinerU uses the existing 3.4.5 production worker configuration,
CPU inference, four slice workers and the retained model cache. No warm-up
request was issued for the fresh full MinerU run.

| Run | Pages | Seconds | Peak sampled cgroup memory |
| --- | ---: | ---: | ---: |
| Fresh Java baseline | 335 | 34.186 | 661,028,864 B |
| Prior extended native candidate | 335 | 41.182 | 674,820,096 B |
| Third-pass precursor, three repeats | 335 | 64.144 median, 60.728–68.103 | 724,672,512–734,797,824 B |
| Final candidate including footer ancestry | 335 | 63.316 | 758,919,168 B |
| Existing MinerU parsing | 335 | 1,073.408 | 12,335,665,152 B |
| Historical Java baseline | 430 | 52.726 | 580,792,320 B |
| Historical final candidate | 430 | 71.234 | 726,429,696 B |

Each final-configuration row is one observation. The three precursor repeats
have identical content and chunk hashes; they precede the footer-only addition
and the presence-check fix. They are reported separately rather than treated
as three repetitions of the exact final code. MinerU's kernel cgroup peak is
12,498,546,688 B; no OOM or OOM kill was recorded. Sampled memory is not the same
measurement as process RSS used in the formula component experiment.

Native timers include per-document JVM execution, adaptation, repairs and one
chunk pass, but exclude interpreter/container startup and source-snapshot setup.
MinerU's configuration timer includes its cold parser/model startup and excludes
chunking. These scope differences prevent a precise full-ingest speedup claim.

Runnable entry points:

```sh
python bench/parsers/scripts/measure_odl_native_pipeline.py ROOT NEW_OUTPUT --variant refined
python bench/parsers/scripts/refine_odl_output.py --check
python bench/parsers/scripts/refine_odl_output.py --sources MANIFEST --output NEW_OUTPUT --arm tables
python bench/parsers/scripts/score_odl_refined.py --local bench/parsers/reports/local --runs RUN_DIR --output NEW.json
python bench/parsers/scripts/score_odl_independent.py --checks bench/parsers/fixtures/odl-independent-checks.json --runs RUN_DIR --output NEW.json
```

Use the pinned dependencies recorded above and new output paths. The production
parser is not changed by these benchmark scripts. Alternate detector/header
flags are explicit experiments; their existing defaults remain unchanged.

Primary VM roots are `/opt/capy-odl-third-pass-20260909`,
`/opt/capy-odl-third-regression-20260909` and
`/opt/capy-odl-math-recovery-20260909`. Local raw records are under the matching
dated directories in `bench/parsers/reports/local/`:

- `refined-final-r1/`: fresh selected native outputs, receipts, timing and snapshots.
- `refined-cluster-r1/` through `r3/`: repeated precursor measurements.
- `extended-default-r1/` and `refined-nofooter-r1/`: rejected configuration controls.
- `composed-footer-r3/`: independent final replay with per-stage evidence.
- `results/full-mineru-auto-r1/` and `mineru-production-r1/`: fresh existing parser and actual chunks.
- `composed-hybrid-final/`: selected native outputs with the verified selective formula recovery, source bindings and citation/prose checks.
- `curated-final.json`, `independent-final.json` and `final-fresh-verification.json`: final scores and fresh/replay/regression equality checks.
- `2026-09-09-odl-mineru-table-comparison/`: source verdicts and complete footer/table chunk conservation.
- `2026-09-09-odl-third-regression/{native-review,font-exponent-review}/`: frozen audit plans, source reviews and fix verification.

Independent code review covered composition, source binding, unique native
identity, page bounds, final chunking, scoring and footer ancestry. Earlier
reviewed overprint-whitespace and exponent-occurrence bugs were fixed and
replayed without changing the real-corpus outputs. The source reviews and
configuration failures remain available to prevent the selected result from
being mistaken for unrestricted parser equivalence.

Final verification ran `pnpm run fmt:py`, isolated Ruff lint/format checks on
13 current scripts, and nine focused parser checks. They pass. The final fresh
335-page content/chunk arrays equal the reviewed footer-only replay. Across
the 430-page rerun, every raw block remains exact and the only chunk change is
the one documented duplicate removal. No benchmark container remains running.
