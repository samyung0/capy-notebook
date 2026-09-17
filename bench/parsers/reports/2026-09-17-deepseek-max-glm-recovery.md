# DeepSeek thinking-max and GLM-5.3-Flash recovery comparison

Date: 2026-09-17 local, 2026-09-16 15:45 to 15:47 UTC. Requested by the
developer after the Sonnet arm, with fresh DeepSeek and Tencent TokenHub
keys, to compare quality and cost of two more transcription arms over the
same 16 frozen crops.

## Result

Both arms returned 16/16 schema-valid transcriptions with no retries.

- **DeepSeek Flash, reasoning max.** 57/57 mathematical targets, 35/36
  cells, 5/6 complete tables. It made the same Greek `ν` substitution as the
  no-thinking arm on the Hefferon wave table, but this time reported the
  symbol as ambiguous in `uncertain`. The orbit table still uses HTML
  superscripts instead of LaTeX. Thinking spent 35,438 reasoning tokens on
  16 crops, about eight times the no-thinking cost and three and a half times
  its median latency. The two heaviest crops were the two Hefferon tables.
- **GLM-5.3-Flash, reasoning low, TokenHub.** 57/57 mathematical targets,
  36/36 cells, Latin `v` retained, LaTeX in every table cell. One table
  fails semantic completeness: the LSJ `read textbook` header spans three
  columns from the left instead of the two data columns. TokenHub reported
  zero reasoning tokens and returned no reasoning content at `low`. It is the
  fastest and cheapest arm measured so far.

Neither arm changes the earlier conclusion: an empty uncertainty list is not
evidence of correctness, and no arm supports automatic replacement without
a region selector and review.

## Method

- Same 16 crops, system and user text, image bytes and JSON-object output
  contract as the reviewed DeepSeek no-thinking arm. Schema checked locally.
- DeepSeek: Responses API, `reasoning.effort: max`, `temperature: 0`, added
  as a `--reasoning` option to
  [`compare_deepseek_recovery.py`](../scripts/compare_deepseek_recovery.py).
  The default stays `none`, so earlier receipts are unchanged.
- GLM: chat completions at the production TokenHub gateway with
  `reasoning_effort: low`, `temperature: 0`, `max_tokens: 8192`, the same
  contract as `pipeline/elitellm/client.py`, through the new
  [`compare_tokenhub_recovery.py`](../scripts/compare_tokenhub_recovery.py).
- Four workers, no retries, replay without new calls. Keys live only in the
  ignored local secrets file.

Receipts under ignored `bench/parsers/reports/local/2026-09-16-selective-recovery/r2/`:
`deepseek-json-object-think-max/crops/` and `tokenhub-glm-5.3-flash-low/crops/`.
Review: `provider-arms-source-review.json`.

```powershell
python bench/parsers/scripts/compare_deepseek_recovery.py crops --mode json-object --reasoning max
python bench/parsers/scripts/compare_tokenhub_recovery.py crops --reasoning low
```

## Source checks

Same gold, adjudication and abstentions as the earlier reviews.

| Measure | GLM-5.3-Flash low | DeepSeek max | DeepSeek none | Sonnet 4.6 run 2 | Qwen strict |
| --- | ---: | ---: | ---: | ---: | ---: |
| Semantic math targets | 57/57 | 57/57 | 57/57 | 57/57 | 55/57 |
| Correct associated cells | 36/36 | 35/36 | 35/36 | 36/36 | 32/36 |
| Semantically complete tables | 5/6 | 5/6 | 5/6 | 6/6 | 5/6 |
| HTML tables with LaTeX cells | 6/6 | 5/6 | 3/6 | 6/6 | 5/6 |
| Neighbor anchors | 27/27 | 27/27 | 27/27 | 27/27 | 27/27 |
| Non-empty uncertainty lists | 0 | 1, on the wrong cell | 0 | 0 | n/a |

Findings by case:

- `hefferon-wave-table`: DeepSeek max writes `ν` and flags it as ambiguous.
  GLM writes Latin `v`. GLM also prints `The equation` before the table
  where the source has it after.
- `lsj-formula-table`: DeepSeek max spans `read textbook` correctly over the
  two data columns. GLM uses `colspan="3"` from the first column, so the
  header covers the label column and one data column.
- `hefferon-orbit-table`: DeepSeek max keeps HTML `<sup>` with a Unicode
  minus. Values and associations are correct. GLM uses LaTeX.
- `hefferon-pendulum-table`: DeepSeek max loses the subscript binding in the
  neighboring formula (`p^{p1}`), GLM capitalizes it (`P_1`), and GLM adds an
  empty spanning first column. None of these is a scored target; the five
  cells are correct in both.
- `ahss-source-typo`: both arms retain the printed `0.431(1000)`.

## Usage, latency and cost

| Arm | Wall, 4 workers | Median crop | Input tokens | Output tokens | Reasoning tokens | List-price estimate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GLM-5.3-Flash low, TokenHub | 15.5 s | 3.3 s | 9,688 | 3,023 | 0 reported | CNY 0.016, about US$0.002 |
| DeepSeek max | 62.5 s | 5.7 s | 7,403 | 38,805 | 35,438 | US$0.024 |
| DeepSeek none, earlier | 7.4 s | 1.6 s | 7,003 | 3,341 | 0 | US$0.003 |
| Sonnet 4.6 medium, CLI run 2 | 47.9 s | 9.6 s | 141k, mostly cache reads | 7,118 | not exposed | US$0.17 CLI estimate, unbilled |

Rates: TokenHub lists GLM-5.3-Flash at CNY 0.8 input and CNY 2.8 output per
million tokens ([price list](https://cloud.tencent.com/document/product/1823/130055)).
DeepSeek calls fell outside the documented weekday peak windows, so the
off-peak US$0.15 input and US$0.60 output rates apply
([pricing](https://api-docs.deepseek.com/quick_start/pricing/)); reasoning
tokens are inside the reported output count. These are list-price estimates
from returned usage, not invoices. The DeepSeek max median hides a long tail:
the two Hefferon tables took 40 and 48 seconds with 9k to 11k reasoning
tokens each.

## What this does and does not establish

- Thinking at max did not fix DeepSeek's one symbol error. It made the error
  visible, which is worth something for a review queue, at eight times the
  cost. It did not fix the HTML-superscript habit either.
- GLM-5.3-Flash at low matches the best semantic scores at the lowest cost
  and latency, on the same gateway production already uses. Its one defect
  is a table-span error, the kind of structural fault a cell-level checker
  catches but a whole-region replacement would not.
- Sixteen manually chosen crops and one draw per arm do not rank the
  models. The Sonnet arm showed run-to-run variance on a rubric-critical
  case; the same could apply here.
- No arm was run with automatic region selection, which remains untested.
- No production transcription backend is selected by this comparison.
