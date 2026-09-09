# Paired answer review protocol v1

Freeze this protocol, the question fixture and the selected prompt before reviewing answers. This protocol was written without inspecting new answers or held-out questions. Review each attempted answer independently against the same frozen source rubric, then compare the matched answers. Use neutral answer labels while judging if practical; restore parser and candidate names after the verdicts are recorded. Keep development and held-out results separate.

## Three independent judgments

1. **Required-claim correctness:** Does the answer state each frozen required claim correctly, including its labels, units, conditions, ordering and qualifications? Use `correct`, `partial`, `incorrect`, `omitted`, or `uncertain`. Equivalent wording and mathematically equivalent expressions are acceptable when the source establishes the equivalence. Freeze numerical tolerances before seeing outputs; otherwise require the source's precision. A correct value assigned to the wrong row, model or condition is incorrect. Do not split or add required claims after seeing the answers.
2. **Grounding in evidence actually seen:** Does the text submitted to the model support that claim and its relationships? Use `supported`, `partial`, `unsupported`, `missing`, or `uncertain`. Inspect `rendered_tool_results[].text_sent_to_model`, its truncation flag, and the outbound request that produced the answer. A complete `calls[].passages` record alone does not establish that the model saw the passage, a needed label or a navigation locator. If compaction removed the original text, inspect the actual summary submitted in its place and its provenance. For calculated answers, all operands and their association must be available and the stated or unambiguous calculation must be valid.
3. **Source-PDF citation support:** Does an attached answer citation resolve to the right document and source page, and do its actual highlighted regions support the attached claim? Use `supported`, `partial`, `unsupported`, `missing`, or `uncertain`. Inspect the rendered source PDF, not just parser text or the citation's 400-character snippet. Record wrong source/page, wrong region and missing relationship separately in the note. If the correct page is cited but no region is provided, record `partial` and `page_only`; do not silently award full region support. A citation attached to one statement does not automatically support other statements in its paragraph.

Keep these axes separate. A memorized, correctly guessed or uncited correct value may be factually `correct`; it receives no strict grounded-answer credit. Conversely, accurately repeating a parser error may be grounded in returned text but is factually incorrect and unsupported by the source PDF. Citation numbers in the answer must resolve through that answer's own citation array, not the sibling parser's chunks.

## One JSON row per attempted answer

Write UTF-8 JSONL. The following is a shape example, not a real question or verdict. Claim indices refer to the frozen `required_claims` list, starting at 1. Message and region indices start at 0. The manifest paths and SHA256s identify the exact reviewed records; keep full answers and evidence in those original artifacts rather than duplicating them in every review row.

```json
{
  "schema": "odl-agentic-review-v1",
  "question_id": "example",
  "answer_id": "neutral-A",
  "turn_id": "eval_example",
  "repeat": 0,
  "split": "heldout",
  "reviewer": "reviewer-id",
  "inputs": {
    "questions_sha256": "...",
    "answer_jsonl": "relative/path.jsonl",
    "answer_jsonl_sha256": "...",
    "answer_line": 1,
    "provider_jsonl_sha256": "...",
    "protocol_sha256": "..."
  },
  "run_status": "complete",
  "scope_valid": true,
  "claims": [
    {
      "claim_index": 1,
      "correctness": "correct",
      "grounding": "supported",
      "citation_support": "supported",
      "answer_excerpt": "The value is 42 [1].",
      "seen_evidence": [
        {
          "attempt_id": "...",
          "message_index": 3,
          "rendered_result_index": 0,
          "chunk_ids": ["..."],
          "excerpt": "...",
          "truncated": false
        }
      ],
      "source_checks": [
        {
          "citation_number": 1,
          "source_id": "logical-source",
          "pdf_sha256": "...",
          "pdf_page": 1,
          "region_index": 0,
          "source_excerpt_or_visual_fact": "...",
          "support": "supported"
        }
      ],
      "note": "Labels and units agree in submitted evidence and the cited source region."
    }
  ],
  "additional_unsupported_claims": [],
  "abstention": null,
  "primary_error": null,
  "error_tags": [],
  "strict_pass": true,
  "uncertainties": [],
  "adjudication": null
}
```

Use JSON `null` for absent fields, never fabricate an artifact locator. For unsupported or missing evidence, leave the relevant evidence list empty and explain the failed check. A request message can contain a summary or file description rather than a numbered passage; identify that message directly and use an empty `chunk_ids` list. Record source render/crop artifact paths in `note` when a visual relationship is hard to describe. Append adjudication to the same logical review row in a new versioned review file, retaining the original file and its hash.

## Failure attribution

Use the earliest demonstrated failure as `primary_error` and retain secondary `error_tags`. Classification requires inspecting the necessary stage; when it cannot be established, use `uncertain` and identify the missing comparison.

| Tag | Required evidence |
| --- | --- |
| `extraction` | The source PDF contains the required fact or relationship, but the corresponding final indexed parser chunks/captions omit or corrupt it. Preserve a source-to-index comparison. This tag includes measured parser, recovery, caption or chunking loss; name the stage if identifiable. |
| `retrieval` | The needed fact and relationship exist in the index but do not reach the model's actual answer-producing request. Examples include missed search hits, insufficient document reads, clipped labels or lost context. Note `truncation` or `context_loss` when proven. |
| `association` | The answer joins available components incorrectly, such as putting the right number under the wrong row or treating a qualifier as another group's value. If extraction already destroyed that relationship, extraction is primary and association may be secondary. |
| `unsupported` | The answer introduces a material claim without adequate submitted evidence, or its attached source citation does not support it. Include unsupported correct guesses and wrong/missing citations. Do not infer model memorization as a cause. |
| `empty` | No substantive final answer. Preserve telemetry, partial narration and provider errors. An explicit, relevant abstention is an answer, not an empty response. |
| `runtime` | A provider, database, source-scope or agent error prevents a valid result. Record the actual error and whether it happened before or after provider output. It remains in the attempted-answer denominator. |
| `uncertain` | Source pixels, evidence provenance or failure stage cannot be resolved. Describe exactly what remains undecided. |

Additional material factual claims outside the frozen rubric also require support. Record each unsupported addition with an answer excerpt, reason and available source/evidence locators in `additional_unsupported_claims`; do not inflate success by scoring only the requested values and ignoring an invented explanation.

## Abstentions and scoped negatives

For a question frozen as unanswerable, fill `abstention` with `{"verdict":"correct|incorrect|uncertain","scope_respected":true,"adequate_check":true,"evidence_note":"..."}`. A correct response explicitly limits its conclusion to the requested sources and does not invent the requested answer. Check the actual tool calls and submitted evidence against the frozen negative rationale. A top-k miss does not prove that the whole source is silent. Distinguish a careful statement that the retrieved material is insufficient from an unsupported assertion that no such fact exists.

Negative answers need no fabricated citation to an absent fact. Mark per-claim citation support `missing` with `absence_not_citable` where applicable; strict negative credit instead requires a correct scoped abstention, a source-verified negative rubric, a reasonable documented search/read check of that scope, and no material unsupported claims. If adequacy cannot be established from the trace, mark it uncertain. For answerable questions, abstaining leaves unmet claims `omitted`; do not grant strict success for safe but incomplete answers.

## Aggregation and paired comparison

- An answerable answer has `strict_pass=true` only when every required claim is correct, grounded in evidence actually submitted, and supported by its source-PDF citation, with no material unsupported additions, invalid scope, runtime error or unresolved uncertainty. Report factual correctness and grounding/citation rates alongside this strict measure so page-only citations or extraction errors remain visible.
- An unanswerable answer follows the explicit negative rule above. Report answerable and negative rates separately before any combined score. Empty and failed attempts count as failures; report provider/setup failures separately as well. A setup failure before a question was attempted is not an answer row.
- Give every question equal weight within its split. Report per-question fractions of correct required claims, fully grounded claims and fully supported citations; do not silently pool all claims and overweight questions with longer rubrics. Keep `partial` and `uncertain` counts explicit. Do not turn uncertain judgments into half-credit or silently drop them.
- Pair the same question, repeat, prompt candidate and model/budget configuration. Report both-pass, ODL-only-pass, MinerU-only-pass, neither-pass and unresolved pairs, with per-family and language counts when sample sizes are clear. Do not describe differences as causal if captions, prompts, budgets or source scopes differ. Repeated answers share a question and are not independent new questions.
- Resolve source ambiguity and disputed claim/citation judgments before a final win/loss count. Preserve both the initial judgment and the adjudication reason. Do not tune a prompt from held-out mistakes and then describe that same set as held out.
