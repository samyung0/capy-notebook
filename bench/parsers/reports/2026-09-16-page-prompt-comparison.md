# Page-description prompt for selective recovery

## Finding

Epo's prompt works on cropped regions as well as full pages in this small
DeepSeek V4.1 Flash experiment. It preserves the tested table associations and
produces useful searchable text. It does not guarantee exact transcription:
one crop loses square-root scope, and a dense full page loses a limit condition.
A region-specific revision fixes that grouping error but misreads a Latin `v`
as Greek `ν`. Neither prompt is ready for unchecked source replacement.

This is a prompt experiment, not a production parser/provider change or an
end-to-end retrieval evaluation. Qwen was not rerun with these prompts.

## Method

- Native `https://api.deepseek.com/responses`, model `deepseek-flash`,
  `reasoning.effort=none`, temperature 0, four workers, no retries.
- One user message containing the image and prompt. No additional system
  instruction, JSON schema, text-layer content or expected answer.
- The literal prompt was used unchanged, including its trailing space, on
  all 16 existing crop images and four additional full-page images.
- The region revision was designed after examining the literal arm and tested
  once on the same 16 crops. These are development results, not held-out proof
  of a general improvement.
- Full-page fixtures were selected and visually inspected before their
  responses. They are rendered at 2.5 pixels per PDF point. Their checks are
  in `bench/parsers/fixtures/page-prompt-cases.json`.
- Frozen semantic gold and previous abstentions were retained. Neither plain
  text nor Markdown tables are penalized for lacking HTML. The literal prompt
  does not require LaTeX; mathematical meaning still has to be preserved.
- An independent reviewer inspected both crop arms against source images.
  See [source review](2026-09-16-page-prompt-source-review.md). Root separately
  inspected the four full-page results.

## Crop results

All requests returned completed, nonempty text. This is transport success,
not a claim that every response is correct.

| Prompt | Math targets | Correctly associated cells | Complete semantic tables | Neighbor anchors | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Earlier exact-transcription prompt, JSON object | 57/57 | 35/36 | 5/6 | 27/27 | 7.35 s |
| Epo's literal page prompt, plain text | 56/57 | 36/36 | 6/6 | 27/27 | 7.05 s |
| Region revision, plain text | 57/57 | 35/36 | 5/6 | 27/27 | 6.33 s |

The earlier baseline also differs in its system instructions and output format.
These single runs do not isolate one wording change or establish a speed
difference. The math/cell targets do not cover every character in each crop.

### Concrete differences

- The literal prompt outputs `√ℓ/g` for source `√(ℓ/g)` in the pendulum
  equation. That changes the radical's scope. The revision outputs
  `\sqrt{\ell/g}` correctly.
- A neighboring expression outside the pinned math targets becomes
  `pᴾ¹ℓᴾ²mᴾ³gᴾ⁴θᴾ⁵` with the literal prompt. The source has lower-case
  exponent variables with subscript indices, such as `p^{p_1}`. The revision
  preserves them. Passing the 27 prose anchors does not certify neighboring
  equations.
- The literal prompt keeps the wave's Latin `v`; the revision emits `\nu`.
  The dimensional expression is correct in both. This is why the revision
  loses one associated-cell check and one complete-table check.
- Both prompts preserve the LSJ table's four beta expressions in the correct
  attendance/textbook cells. Their formats differ, but the associations are
  recoverable from the text.
- Both preserve the printed AHSS coefficient inconsistency, `0.0431` on one
  line and `0.431(1000)` on the next. Source fidelity must be evaluated
  separately from whether a textbook's calculation is correct.
- The literal orbit caption calls the dotted line "representing mean
  separation". This is a contextual interpretation rather than an explicit
  label on the diagram. The revision only describes the visible spheres and
  dotted line.

## Full-page observations

These four pages received the literal prompt only, and finished in 4.42 seconds
combined. They have source-reviewed observations, not a new aggregate accuracy
denominator.

| Source, one-based PDF page | Observation |
| --- | --- |
| OpenIntro Statistics, page 3 | All 38 TOC entries, their order and page-number associations are retained. Dot leaders are omitted. In particular, 1.2.1 remains between 1.2 and 1.2.2, addressing the missing-entry example from the earlier evidence discussion. |
| Learning Statistics with Jamovi, page 369 | Table 14.9 preserves all four beta expressions and both row/column dimensions. The displayed prediction, assumptions and surrounding numerical examples are retained. Markdown cannot directly express the original merged header, but the textual associations remain clear. |
| Exo7 Analyse, page 80 | Both derivative tables and the five differentiation rules are retained. In the product-rule proof, the source arrow has `x → x₀` beneath it; the response emits a bare arrow and omits that limiting condition. |
| Exo7 Analyse, page 84 | The critical-point and local/global-extremum definitions, inequalities and theorem assumptions are retained. The brief curve caption lists the visible labels without inventing numerical coordinates. |

The results retain source headings, paragraph breaks, table rows and some
Markdown emphasis. "No unnecessary line breaks" does not produce a uniform
single-line format. Source running headers can also repeat section titles.
The TOC output also matches the PDF's text layer after Unicode, whitespace
and dot-leader normalization; this supplements the visual review.

This extraction result does not establish that the separate topic-tagging
model will quote evidence verbatim. That task has different inputs and a
different output contract. Use exact source spans for evidence, and keep
generated image captions distinguishable from quotations.

## Prompts

### Literal user prompt

```text
Describe this page from a study document so a student's search can find the information it carries. Extract all visible raw facts such as text, tables, formulas, data, labels, etc. Caption any images in brief and simple sentence. Do not add any text that is not visible in the page or depicted in the images. Do not duplicate information. Do not add any unnecessary summary, title, line breaks, the response is processed automatically by a RAG pipeline.
```

The recorded request includes the final space from Epo's message.

### Tested region revision

```text
Describe this cropped region from a study document so a student's search can find the information it carries. Extract all visible raw facts such as text, tables, formulas, data, labels, etc. Preserve the exact wording, numbers, symbols, conditions and table row/column associations. Write formulas in LaTeX, with explicit grouping for fractions, square roots, exponents and subscripts. Do not correct printed errors or complete clipped text. Caption any images in a brief and simple sentence, separate from transcribed text. Do not add any text that is not visible in the region or depicted in the images. Do not duplicate information. Do not add any unnecessary summary or title. Keep line breaks needed for formulas and table structure; the response is processed automatically by a RAG pipeline.
```

The revision is a candidate for further testing. Its grouping instructions
helped these examples, while a symbol error remains. Neither prompt supplies
a confidence score or structured uncertainty report. Lack of an uncertainty
warning therefore cannot be used as evidence that extraction is exact.

## Receipts and checks

| Arm | Requests | Input tokens | Output tokens | Cached input | Reported reasoning tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Literal crops | 16 | 5,003 | 1,852 | 0 | 0 |
| Literal full pages | 4 | 4,401 | 2,544 | 0 | 0 |
| Region crops | 16 | 5,995 | 2,086 | 512 | 0 |
| Total | 36 | 15,399 | 6,482 | 512 | 0 |

All 36 requests have native receipts and reported usage. Raw responses, frozen
inputs, manifests and transcripts live under the ignored directory
`bench/parsers/reports/local/2026-09-16-selective-recovery/r2/`:

- `deepseek-page-prompt/crops/`
- `deepseek-page-prompt/pages/`
- `deepseek-page-prompt/images/`
- `deepseek-region-prompt/crops/`
- `page-prompt-request-audit.json`

The audit confirms identical crop-image bytes across comparison arms, exact
prompt placement, full-page image identity and thinking disabled. Offline
runner checks pass, including plain-text handling, empty-output rejection and
the existing no-retry/schema/usage checks. Python formatting and explicit
Ruff checks pass. No corpus reindex or production prompt switch was performed.
