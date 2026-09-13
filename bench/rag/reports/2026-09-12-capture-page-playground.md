# capture_page in the agent loop: first playground runs

September 12, 2026. Four turns through the new
[playground](../playground/README.md) against the frozen ODL workspace, one
question, plus direct reads of the same scanned table crop by each available
vision reader. Small sample; this fixes the setup and the first signal, not a
result.

Question (held-out `odl-agentic-054`): the average diameter, its standard
deviation and coefficient of variation in Table 2 of the NIST shot-classifier
paper. The printed page says 1.267 mm, 0.0033 mm and 0.3 % (page 4, a scan
with an OCR text layer). The indexed text and the pre-generated caption both
say 0.0023, so every arm starts from wrong evidence. The September 9
evaluation left this question empty or wrong in both parser arms.

## Turns

| Run | Chat model | capture_page | What happened | Answer | Time |
| --- | --- | --- | --- | --- | ---: |
| `20260912-105052-f49ca5` | deepseek-v4-flash-vision-exp | off | list, search, read; noticed the 0.0023 / 0.0033 conflict in the text and picked 0.0023 | 1.267 / **0.0023** / 0.3 | 31 s |
| `20260912-105152-89f8f5` | deepseek-v4-flash-vision-exp | pixels, notes shown | two captures of the left half of the page, then said it "read directly from the printed table" | 1.267 / **0.0023** / 0.3 | 30 s |
| `20260912-105515-39715c` | glm-5.3-flash (thinking low) | pixels, notes shown (0.72 on the table chunk) | never called capture_page | 1.267 / **0.0023** / 0.3 | 33 s |
| `20260912-105714-58136d` | glm-5.3-flash + `capture-pixels-glm-forced` addon | pixels | one full-page capture, then overrode the extracted value | 1.267 / **0.0033** / 0.3 | 47 s |

Configs: `baseline`, `capture-pixels`, `capture-pixels-glm`,
`capture-pixels-glm-forced` under `bench/rag/playground/configs`. The forced
addon says: when a passage's confidence is below 0.9 and the answer would
quote numbers from it, capture that region and prefer the image when they
disagree. Provider usage for the correct turn: 11,699 input and 326 output
tokens over three GLM calls.

## Direct reads of the same crop

The summary rows of Table 2 (`bbox [0, 380, 500, 1000]`, 1568 px long edge)
sent once to each reader with "transcribe these rows exactly":

| Reader | Average / SD / CV of the first column | Note |
| --- | --- | --- |
| deepseek-v4-flash-vision-exp | 1.237 / 0.0085 / 0.7 | wrong on every cell; also mis-read two count cells |
| glm-5.3-flash via DeepInfra | 1.267 / 0.0033 / .3 | correct, flagged the final 3 as degraded |
| Qwen3.5-OCR `document_parsing`, full page | ten data rows correct; the three summary cells of this column absent | see the [scan report](../../parsers/reports/2026-09-12-qwen35-ocr-scans.md) |
| Qwen3.5-OCR chat route, full page | degenerate repetition after the table header | `finish_reason: repeated` |
| OpenAI, Anthropic | not run | the UAT environment carries empty keys for both |

DeepSeek's failure in the loop is therefore a reader failure, not a plumbing
failure: the image reached the provider (input tokens rose from 5,028 to 6,289
with two images attached) and the model still echoed the text-layer value.

## Read

- The idea works end to end when three things line up: a confidence note that
  names the weak passage, a prompt that ties a capture to that note, and a chat
  model whose vision can read the scan. Remove any one and this question fails.
- GLM-5.3-flash is the only reader in UAT's catalog that read the scan
  correctly, and it needed the explicit instruction; the softer wording in the
  default addon was ignored.
- `require_seen_page` held in every run; no model asked for an unseen page.
- One question, one page, one run each. Next: the 48 held-out questions under
  the forced-GLM config against baseline, and the same on the MinerU workspace,
  through `odl_agentic_run.py`-style batching or a loop over `/api/turn`.

Artifacts: `bench/rag/playground/local/runs/<id>/run.json` and the captured
JPEGs beside them; `local/quality/lab-odl_eval_odl.json` (2,846 chunks, median
0.993, 696 below 0.7) and `lab-odl_eval_mineru.json` (2,868, median 0.931,
1,039 below 0.7).

## Citation modes, same question, GLM-5.3-flash via DeepInfra

Both new modes ran once on the developer-edited forced-capture config.

| Mode | Model wrote | User sees | Final list |
| --- | --- | --- | --- |
| `renumber` (`20260912-132805-d87f4e`) | `[2]` … `[3]` | `[1]` … `[2]` | 2 used, 3 unused |
| `structured` (`20260912-132922-05eff7`) | `{"answer":[{"text":…,"passages":[8,4,6]}]}` | prose + `[1][2][3]` | 3 used, 5 unused, no repair call |

The JSON contract held without `response_format` on the tool-capable calls.
Setting `json_object` on such a call made GLM skip the search and answer
"1.24" with no passages, so the mode enforces it only on tool-less calls.
Both runs still answered 0.0023 for the standard deviation: the renumber run
made no capture under the edited config, and the structured run captured
three regions and still repeated the text-layer value. The earlier 0.0033
result is not yet a repeatable one.

Tencent TokenHub (`tokenhub-intl.tencentcloudmaas.com`) accepts the supplied
key but the account has no balance (`INSUFFICIENT_BALANCE`, HTTP 402); the
transport override is wired and waits on funding.

## Tencent TokenHub, five earlier failures

After the account was funded, the same structured config through
`tokenhub-intl.tencentcloudmaas.com` answered the NIST Table 2 question in
67.8 s against 108.6 s on DeepInfra (per-call latency 5.5 to 9.9 s versus
11.8 to 27.6 s), same tool sequence, same wrong 0.0023.

Five questions the ODL arm failed on September 9, one run each through that
config (`local/batches/structured-glm-tencent-20260912-143229.json`):

| Question | September 9 failure | Now | Capture |
| --- | --- | --- | --- |
| 027 CIL ablation, Table 4 | checkmark columns misaligned | every row and delta correct | 1 |
| 035 Spain CPI chart | rates on wrong groups | groups and individual products correct | 0 |
| 051 ResNet Table 2 | grid lost, answered from Table 3 | 28.54 vs 25.03, 3.51 points | 1 |
| stress-002 BERT Table 1 | QQP / QNLI swapped | all eight claims | 0 |
| stress-003 NIST equations | square root invented in (3) | both equations exact | 1 |

Two were fixed by the agent alone (no capture), three by capturing the region
ODL had flattened. Single runs; the NIST scan shows the same model can capture
the right region and still misread it.

## Image density and context

GLM has no `detail` switch; its image cost tracks pixels on a 28-pixel patch
grid (a 1568 × 1211 page cost about 2,400 input tokens, a cropped strip about
1,900), so `capture.max_edge` and the model's `bbox` are the knobs. The page
now shows pixel size and the patch estimate per capture, a per-call context
breakdown, and the checkpoint/compaction cards; `context.input_limit_tokens`
forces folds on short conversations for testing.

## Captures reuse the page's citations

`capture.citation = "page"` (now the default): when retrieved passages already
cite the captured page, the tool result names their numbers ("already in the
evidence as [1][2][3]; cite those") and adds no citation of its own. Run
`20260912-145657-1a8a4d` (Tencent, structured): search, one full-page capture
of page 4, answer 1.267 / **0.0033** / 0.3 citing [1][2][3], all three indexed
page-4 passages, with no capture entry in the list. The value is the printed
one; it is the second correct read of that cell in eight attempts.

## Caption-free workspace

`odl_eval_odl_nocaption` indexes the frozen refined-ODL chunks with no
caption step (figures keep only native caption and footnote text): 2,217
chunks against 2,846 in the captioned arm, the same 27 usable sources (the
Hong Kong source fails Alibaba's content filter at summary time in every arm)
and one new hole: the newspaper scan has no chunks at all, since the refined
ODL run carries no OCR text for it, so nothing can ever cite it and
`capture_page` can never reach it. Chunk quality: median 1.0, 55 below 0.7
(the captioned arm's 696 were mostly the captions themselves).

Twelve questions through `nocaption-glm-tencent`, one run each
(`local/batches/nocaption-glm-tencent-20260912-151743.json`), 571 s and 15
captures in total:

| Question | Needs | Captures | Result |
| --- | --- | --- | ---: |
| 019 MoE routing (ja slides) | slide text | 0 | correct |
| 027 CIL ablation table | table cells | 2 | correct |
| 035 Spain CPI | chart, prose | 0 | correct |
| 038 Japan migration Figure 2 | chart values | 0 | correct (values also in Table 1 text) |
| 051 ResNet Table 2 | table | 2 | correct |
| 054 NIST Table 2 SD (scan) | blurry cell | 1 | **0.0033**, correct |
| 055 RLHF slide diagram (zh) | diagram labels | 2 | correct, both sides and the "easier" reason |
| 056 Attention Figure 2 | diagram | 1 | correct, Mask (opt.) |
| 057 ResNet Figure 5 + Table 1 | diagram + table | 4 | correct, 1×1/64, 3×3/64, 1×1/256, 3.8 and 11.3 billion |
| 060 NIST Figure 6 serial (negative) | scanned photo | 2 | abstains; lists part labels A to M3 |
| stress-002 BERT Table 1 | table | 0 | correct |
| stress-003 NIST equations | scanned formulas | 1 | equation (1) correct; (3) loses the squares on S_r |

Eleven of twelve fully correct. The three diagram questions that only captions
could answer on September 9 (055, 056, 057) were answered from captures, and
055 had been empty in both captioned arms. The one miss is a formula
transcription from a scan where the earlier captioned run had got it right;
same model, so this is run-to-run vision variance, not the missing captions.
Single runs throughout.

## Refined ODL with selective OCR

The refined ODL arm had never run OCR: a page with no text layer came out as
image blocks only, so the caption-free workspace has zero chunks for the
newspaper scan and `capture_page` cannot reach it (no passage can cite a
page). `odl_eval_odl_ocr` adds the September 8 selective RapidOCR
configuration (PP-OCRv6 small, 2560 px, 8 threads, text score 0.5) on the
eleven corpus pages with under 40 native characters
([`experiment_odl_selective_ocr.py`](../../parsers/scripts/experiment_odl_selective_ocr.py)):
the two newspaper pages, four slides of the Taiwanese LLM deck, two covers and
three blank pages. Model load 0.55 s; the newspaper pages took 6.2 and 2.7 s,
the slides about 1 s each, blank pages under a second with no lines. Result:
8 more chunks than the caption-free arm (2,225), the newspaper gaining six and
the deck's slides merging into their neighbours' chunks.

| Question | caption-free arm | OCR arm |
| --- | --- | --- |
| 006 harbour vote (newspaper) | "sources don't cover this" | correct, and notes every article line is cut mid-sentence |
| 059 which city (negative, newspaper) | cannot determine, tool finds nothing to render | correct abstention, after capturing both pages |
| 055 RLHF slide diagram | correct via two captures | correct from OCR'd slide text plus reads, no capture |

On this corpus the OCR-routed pages are 11 of 663 and cost about 15 s of CPU
in total, so the "OCR page" is a real but small unit of work under this
pipeline; what it buys is that a text-less page exists in the index at all.
