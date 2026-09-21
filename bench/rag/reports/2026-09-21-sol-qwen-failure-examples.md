# Sol failure examples and Qwen prompt comparisons

The Sol example file now includes observed conditional-link failures, an
unsupported inherited note, unresolved extraction versus completed metadata,
overstated page checks, catalog conflicts and overwritten packet baselines.
The fixed assignment explicitly tells Sol to revisit applicable examples before
completion. No new Sol processing or library publication was performed here.

Qwen's prompt embeds its examples because remote reviewers cannot open local
files. Findings must concern the current final artifacts. Old notes remain an
immutable comparison baseline; a short retrieval summary is separate from the
full synopsis. Exact quotes, existing links and page-supported annotations must
survive review. Qwen still has no visual, numerical or generated-material task.

## Reproducible inputs

Canonical prompt: `bench/rag/fixtures/knowledge-review-v2/system-prompt.txt`.
Final prompt SHA256:
`3233f9fb4c47c2d69b453ffae08f6b9864eeb13340b9c67ae3d04fe063bd85fb`.

Requests, responses, receipts, frozen prompts and manual assessments are under
`bench/rag/reports/local/2026-09-21-qwen-failure-examples/`. The original four
requests are at that directory's top level; subsequent iterations are in
`round-2`, `round-3` and `round-4`. Nothing was overwritten to hide a failure.

The helper accepts a named fixture or an actual saved Sol packet. Its explicit
`--send` boundary remains separate from Sol processing. Examples:

```sh
python bench/rag/scripts/knowledge_review_samples.py --case 09-real-book-repaired-control --output runs/control --env-file .env --send
python bench/rag/scripts/knowledge_review_samples.py --packet my-book.packet.json --output runs/book --env-file .env --send
```

The default remains Qwen3.8-Max, thinking disabled, temperature zero, strict JSON
Schema and no caller output-token cap or thinking budget. `--thinking` enables
thinking for an individual comparison without changing those saved defaults.
The API parameter and model support were checked against Alibaba's
[structured-output documentation](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)
and [thinking documentation](https://www.alibabacloud.com/help/en/model-studio/deep-thinking).

## Non-thinking results

All 34 requests across the four prompt iterations returned schema-valid JSON
and passed target coverage, field-category, quote and status validation. Saved
request hashes match their receipts and frozen request builders. Provider usage
totals 368,061 prompt tokens and 15,652 completion tokens. These are
provider-reported counts, not dollar-cost calculations.

Two control failures led to targeted prompt changes: Qwen first proposed fixing
an already-corrected error in the historical baseline, then mistook a short
retrieval summary for loss of the preserved full synopsis. The larger packet
also caused Qwen to reject teaching diagrams solely because their images were
absent from extracted text, despite supplied Sol inspection records.

Results using the final prompt:

| Case | Result after inspecting the response |
| --- | --- |
| 01 book defects | All five seeded defect types found in six field-level findings |
| 02, 05, 07 clean controls | All passed with no findings |
| 03 missing scope | Correctly incomplete; identifies the absent scope without invented source evidence |
| 04 wrong context link | Correctly replaces the wrong question/model link |
| 06 scope defects | All five defects found with exact source quotes |
| 08 real book sample | Finds three wrong roles and the inherited creditor-direction claim; no exc_10 no-op; does not surface the catalog scope/source-section conflict |
| 09 repaired real control | Passes; accepts the supported correction while retaining the erroneous historical baseline |
| 10 actual 79-target Sol packet | Three false positives and a missed necessary instruction link |
| 11 focused two-target packet | Finds the necessary instruction link, plus one unnecessary synopsis-edit finding |
| 12 repaired focused control | Passes after adding the necessary link and scope dependency; source and synopsis unchanged |

In case 10, Qwen emits a role finding whose action keeps the current role,
demands that the synopsis repeat an extraction warning already present in scope,
and requests link 156 for excerpt 157 even though it already has links 156 and
158. It misses the genuinely absent link from excerpt 155 to instructions in
154. The smaller packet retains the same affected annotations and necessary
context. That comparison suggests scope size matters, but one diagnostic does
not establish an optimal batch size. Smaller input does not eliminate every
unnecessary finding.

These are prompt-visible regression examples. The large packet became a
regression case after its first failure was added to the prompt. None of these
results is an estimate of accuracy on unseen books. Strict JSON acceptance
does not establish semantic correctness, and no findings were applied.

## Thinking comparison

The developer then requested thinking mode. Eight paired requests used exactly
the final prompt and previous packet bodies, changing only `enable_thinking`
to true. The provider's reasoning effort was left unspecified. No token cap or
thinking budget was sent, and strict JSON Schema remained enabled.

Seven returned valid reviews with nonempty provider reasoning and passed local
validation. Case 08 hit the helper's existing 600-second HTTP read timeout;
no response or usage was returned and it was not retried. This was a request
timeout, not an output-token limit. Returned responses reported 120,470 prompt
tokens and 55,689 completion tokens, including 51,886 reasoning tokens. Usage
for the timed-out request is unknown.

| Paired case | Thinking result | Non-thinking time | Thinking time |
| --- | --- | ---: | ---: |
| 02 book control | Pass | 4.3 s | 65.5 s |
| 06 scope defects | All five seeded scope defects found | 12.3 s | 63.8 s |
| 07 scope control | Pass | 2.5 s | 37.3 s |
| 08 real book sample | HTTP read timeout; no review to assess | 17.4 s | 601.2 s |
| 09 repaired book control | Pass | 5.3 s | 175.0 s |
| 10 actual 79-target packet | Finds the absent instruction link; avoids the three earlier false positives | 46.7 s | 505.8 s |
| 11 focused defect | Finds the missing link, plus one unnecessary synopsis finding | 13.6 s | 234.4 s |
| 12 focused repaired control | Pass | 5.2 s | 405.3 s |

For the large packet, completion usage rose from 2,383 to 19,590 tokens, of
which the provider attributed 17,642 to reasoning. In the focused defect case,
thinking still incorrectly says the inspection record does not establish tile
patterns even though that record explicitly describes growing tile patterns.
Thinking improves the observed large-packet failure; it does not eliminate all
unnecessary findings. This is one paired run per case, not a stable latency or
accuracy estimate. Saved details are in `thinking-results.json` and `thinking/`.

Qwen remains a source of suggestions for a separate assessor. These results
do not gate Sol processing, and no more prompt tuning is required for this pass.
The default settings file stays non-thinking; the portable helper's explicit
`--thinking` flag reproduces this comparison when the developer wants it.

## Verification and remaining builder work

Python formatting/lint passed. Sixteen focused checks passed for fixture/packet
inputs, both thinking modes, exact JSON and evidence rules, the no-send
boundary, enrichment and topic handling. Source book text in the new repaired control is unchanged; its
annotations and catalog scope are deliberately corrected test inputs.

Packet export now requires `--baseline-notes` and `--baseline-sha256` from the
assignment and rejects a mismatch. A focused test runs the real `enrich --apply`
path, rejects updated live notes as the original baseline, then exports from
the existing immutable backup with both old and revised notes intact. The
actual 79-target packet reproduces exactly under the new input contract.
The Sol assignment, examples and trial preparation all carry this binding.
New Sol examples have not yet been tested on unseen books. The scheduler remains
paused. Deduplication and runtime agent-loop work
remain deferred, and optional Qwen findings still go to a separate assessor.
