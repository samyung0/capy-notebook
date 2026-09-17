# DeepSeek V4.1 Flash comparison

## Result

DeepSeek was faster on this bounded run, but abbreviated table-of-contents
quotations failed the pilot's literal evidence check. Its documented JSON Schema mode
passed all 12 ordinary tag requests, yet both explicit conflict probes violated
their schemas. Treat successful local validation as an observed result, not a
provider guarantee.

The comparison made 45 native API calls with thinking disabled and no retries or
output repair. It changed no corpus, index, embedding pin, or production provider.
Independent review found 57/57 semantic math targets correct in the 16 crop
transcriptions, with one wrong wave-variable symbol and incomplete compliance
with the requested LaTeX encoding.

## Method and preserved inputs

The native endpoint was `https://api.deepseek.com/responses`, requesting
`deepseek-flash`. Every response reported that same model name. DeepSeek's
[model documentation](https://api-docs.deepseek.com/quick_start/pricing/)
identified this name as DeepSeek V4.1 Flash on September 16, 2026 and documented
native vision support.

Requests used `reasoning: {"effort": "none"}`, `temperature: 0`, and
`stream: false`. The [Responses reference](https://api-docs.deepseek.com/api/create-response/)
documents `reasoning.effort: none`, image input, and
`text.format: {"type": "json_schema", "name": ..., "schema": ...}`.
It did not document a `strict` field. The additional `strict: true` request was
therefore a labeled compatibility diagnostic, not a documented guarantee.

The runner copied the frozen Qwen system/user text and image data URLs. It only
translated message content parts into Responses API names, changed the model
and thinking parameters, and selected the explicitly named output-format arm.
The JSON Schema arm transmitted the original schema. The JSON-object arm
retained that schema for local validation but sent `text.format.type=json_object`.
Image payload equality and SHA-256 were checked for all 16 crops. No image was
rendered again or resized by the benchmark.

| Input | Fixed sample | Frozen input SHA-256 |
| --- | --- | --- |
| Crops | All 16 from Qwen's `normal-structured-explicit/batch/input.jsonl` | `074b5854c97d490a8f772588ca2ec8d3e6640bb008f1635a6879ddb1c3c1004a` |
| Tags | First six `evidence_verified=false` and first six `true`, selected before calls and kept in request order | `fa6aaebed594a68816268778134c04122d917d06c03395dba44765a2956b40f5` |
| Summaries | All three original source-summary requests | `405ee847b8311183658d1dc40dedcd935478436a4f6237acbd5b84cac8ffcc93` |

The tag selection is OS4 front matter and contents entries. It is deliberately
small and biased by request order, not a representative estimate of the full
2,315-excerpt corpus. The schema tag arm reused exactly the same selection after
the JSON-object arm; it did not select new examples based on DeepSeek's results.
Eleven preserved Qwen tag outputs are inherited Batch results originally
requested with JSON-object mode. One, `_5`, has a normal strict-schema receipt.
Current frozen request files contain strict schemas, but that does not make
reused outputs strict-schema generations. All 12 preserved outputs passed local
validation against the current schema.

Four workers were the maximum, with a 300-second timeout. Summaries used three
concurrent calls. Each result was saved as it arrived. Existing receipts are
revalidated without another API call, including invalid and uncertain results.

## Schema enforcement probes

Both probes asked for `{"marker":"prompt_wins","extra":1}` while the
request schema required `marker` to equal `schema_wins` and prohibited extra
properties. Both returned HTTP 200 and the requested conflicting object.

| Format | Seconds | Input/output tokens | Result |
| --- | ---: | ---: | --- |
| Documented `json_schema` | 1.09 | 86 / 13 | Enum and extra-property violations |
| `json_schema` with additional `strict:true` | 0.84 | 86 / 13 | Same violations |

The native bodies echoed the schema and reported `reasoning.effort=none`.
Both reported zero reasoning tokens. These are direct counterexamples to
assuming these accepted requests enforce this schema. They do not establish
how every supported schema or future provider version behaves.

## Crop transcription

| Provider and format | Local schema validity | Wall time, four workers | Median request | Input/output tokens |
| --- | ---: | ---: | ---: | ---: |
| Qwen3.8 Flash, strict JSON Schema | 16/16 | 17.14 s | See Qwen receipts | 8,610 / 3,337 |
| DeepSeek, JSON object | 16/16 | 7.35 s | 1.61 s | 7,003 / 3,341 |

All 16 DeepSeek requests completed without retries. The independent
[source review](2026-09-16-deepseek-source-review.md) checked the frozen crops,
gold targets, actual provider bodies, and unchanged request images/text.

| Source check | Qwen strict schema with explicit instruction | DeepSeek JSON object |
| --- | ---: | ---: |
| Semantic math targets | 55/57 | 57/57 |
| Correct associated cells | 32/36 | 35/36 |
| Semantically complete tables | 5/6 | 5/6 |
| Tables using HTML | 5/6 | 6/6 |
| Semantically correct HTML tables | 4/6 | 5/6 |
| Scored neighboring prose/caption anchors | 27/27 | 27/27 |

DeepSeek corrected the difficult LSJ row/column associations. It changed the
Hefferon wave table's Latin `v` into Greek `ν`, which fails one cell and keeps
that table from being semantically complete. All 16 outputs had empty
uncertainty arrays, including this error.

The three Hefferon tables also used HTML superscripts and subscripts instead
of the requested LaTeX inside mathematical cells. Fourteen math targets retain
the correct values and exponent scope but use that different encoding. Thus
43/57 math targets use the requested LaTeX, and only 3/6 tables satisfy semantic
correctness plus both requested formats, HTML tables and LaTeX mathematics.
These selected semantic checks do not establish complete transcription
compliance or whole-book accuracy.

## Tag evidence

An exact evidence pass means a nonempty returned evidence string occurs
contiguously in the exact source text sent to that request. Whitespace-only
normalization did not change these sample counts. Schema failures retain their
original content and also receive an evidence check.

| Arm, same 12 excerpts | Schema valid | Exact contiguous evidence | Both checks | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Preserved Qwen, locally schema-validated | 12/12 | 6/12 | 6/12 | Mixed historical receipts |
| DeepSeek JSON object | 10/12 | 8/12 | 8/12 | 4.53 s |
| DeepSeek documented JSON Schema | 12/12 | 7/12 | 7/12 | 4.83 s |

In JSON-object mode, cases `_1` and `_3` added an unrequested
`"type":"json_object"` property. Local validation rejected those outputs.
Cases `_1`, `_3`, `_4`, and `_5` joined separated headings with `. . .` inside
the evidence string. For example, `_4` combined the normal, geometric,
binomial, negative-binomial, and Poisson distribution headings into one quote.
Each heading is real, but that combined quote is absent from the source.

JSON Schema removed the extra-property failures in this sample. Cases `_1`
through `_5` still failed exact evidence, including `_2`, which passed in the
JSON-object arm. All five are table-of-contents excerpts. On subsequent
inspection, `_3`, `_4` and `_5` differ only in shortened dotted leaders and
whitespace: each quote becomes a contiguous match when those leaders are
normalized. `_1` skips an intervening heading and page numbers; `_2` omits page
numbers between consecutive headings. The named headings are real. These
failures establish a mismatch with the literal-quote contract, not invented
facts or incorrect topic assignments. The original exact-match scores remain
unchanged; this normalization check is a post-hoc diagnosis, not a new scoring
rule. This TOC-heavy selection cannot estimate body-text quotation fidelity
or establish an accuracy ranking between output modes.

The JSON-object arm used 35,431 input and 1,576 output tokens, including 18,432
cached input tokens. The schema arm used 39,187 input and 1,517 output tokens,
including 21,760 cached input tokens. Only one of the 12 Qwen cases had a local
synchronous latency receipt, so a paired tag throughput comparison is not
available.

## Source summaries

All three DeepSeek JSON-object responses passed the original summary schema.
They used the identical input text sent to Qwen, consisting of the pilot's
source synopses. They were not regenerated from textbook pages.

| Source | DeepSeek seconds | Input/output tokens | Summary words | Preserved Qwen result |
| --- | ---: | ---: | ---: | --- |
| OS4 | 5.97 | 89,135 / 616 | 349 | Read timeout after 300 s |
| AHSS4 | 6.39 | 112,711 / 743 | 415 | Read timeout after 300 s |
| LSJ | 4.20 | 42,461 / 567 | 292 | 103.27 s, 44,606 input and 672 output tokens |

DeepSeek's three-call wall time was 6.95 seconds. All usage receipts reported
zero reasoning tokens. The prompt requested about 500 summary words; these
outputs were shorter. Their schema accepts strings and does not enforce word
count or factual support. This run measured completion, format, and latency,
not an independent factual audit of the summaries. The two timed-out Qwen
calls have unknown usage and were left intact.

## Accounting and limitations

All 45 calls completed with usage receipts: 326,100 input tokens, 8,386 output
tokens, 40,192 cached input tokens, and explicitly reported zero reasoning
tokens. Calls ran from 12:42:43 to 12:46:08 UTC on September 16. This interval
includes preparation and inspection between stages, not continuous throughput.

Using the [published off-peak prices](https://api-docs.deepseek.com/quick_start/pricing/)
for the actual call times, estimated cost was **$0.04804**. The calculation uses
$0.15 per million uncached input tokens, $0.003 per million cached input tokens,
and $0.60 per million output tokens. This is a list-price estimate, not an
account billing receipt.

The comparison has one run per case, different provider tokenizers, and
provider-specific format interfaces. These results justify keeping local
schema and source checks. They do not justify a production provider switch or
a corpus-wide quality claim.

## Artifacts and verification

Runner: [`compare_deepseek_recovery.py`](../scripts/compare_deepseek_recovery.py).
Ignored artifacts are under
`bench/parsers/reports/local/2026-09-16-selective-recovery/r2/`:

- `deepseek-schema/probe/` and `deepseek-schema-strict/probe/` contain both
  format probes, including the failed outputs.
- `deepseek-json-object/crops/`, `tags/`, and `summaries/` contain the first 31
  substantive comparisons.
- `deepseek-schema/tags/` contains the same 12 tag requests in the documented
  schema arm.
- `deepseek-comparison-audit.json` records per-request usage and latency,
  evidence checks, source input hashes, and the complete 16 crop image hashes.

Each stage has an immutable input file and manifest, original native response
bodies, exact semantic request bodies with SHA-256, local validation results,
and an aggregate receipt. The additional schema tag arm also records the
request wire SHA-256. The first 33 calls predate that extra wire-hash field;
their semantic request hashes and bodies are preserved. No credential headers
are written into receipts. Crop Markdown files are in `crops/transcripts/`.

The focused offline `check` covers unchanged message/image conversion, exact
evidence matching, schema rejection, no retries, missing usage detail remaining
unknown, and preservation of original timing during receipt replay. It passed,
as did explicit Ruff formatting and linting of the runner. The repository's
Ruff configuration excludes `bench`, so this check uses `--no-force-exclude`.

```powershell
python bench/parsers/scripts/compare_deepseek_recovery.py check
python bench/parsers/scripts/compare_deepseek_recovery.py probe --mode schema
python bench/parsers/scripts/compare_deepseek_recovery.py probe --mode schema-strict
python bench/parsers/scripts/compare_deepseek_recovery.py crops --mode json-object
python bench/parsers/scripts/compare_deepseek_recovery.py tags --mode json-object
python bench/parsers/scripts/compare_deepseek_recovery.py summaries --mode json-object
python bench/parsers/scripts/compare_deepseek_recovery.py tags --mode schema
```
