# Qwen review sample pack

Historical version 1, retained to match the previously shared ZIP. The active
workflow and runner now use [text-only book review version 2](../knowledge-review-v2/README.md).
The material and visual checks below are no longer assigned to Qwen.

Draft inputs for developer review, with no Qwen results yet. Start with
[the exact review prompt](system-prompt.txt). The proposed Sol assignment and
scheduler changes are in the [prompt proposal](../../reports/2026-09-21-qwen-review-proposal.md).
The scheduler remains paused; this pack does not change it or write to the library.

## Sample inputs

Each JSON file is self-contained apart from its explicitly listed image files.
The small constructed cases make expected behavior inspectable; they do not
replace trials on actual Sol outputs, new-topic books or large split books.

| Case | What to check |
| --- | --- |
| [01-claims](cases/01-claims.json) | A school association becomes a universal guarantee; an Athens detail is unsupported; a labeled practice adaptation should survive. |
| [02-claims-control](cases/02-claims-control.json) | Supported, qualified statements and the same valid adaptation. |
| [03-pages](cases/03-pages.json) | Actual OpenIntro software estimates, with their matching page image. |
| [04-pages-other](cases/04-pages-other.json) | Same text, but the attached page has summary statistics instead of the software table. Text support and visual verification differ. |
| [05-pages-mixed](cases/05-pages-mixed.json) | One matching image and a second example with only a capture receipt. A receipt must not verify the missing image. |
| [06-book](cases/06-book.json) | Objectives tagged as an exercise, redundant median topic, unjustified R requirement, missing bootstrap topic and lost full notes. |
| [07-book-control](cases/07-book-control.json) | The corrected mini-book, including justified creation of a bootstrap topic. |
| [08-book-split](cases/08-book-split.json) | A whole-book completion claim despite an explicitly missing review scope. A live importer should reject this before a model call. |
| [09-examples](cases/09-examples.json) | Duplicate, complementary and distinct examples, including a different model on the same dataset. |
| [10-extraction](cases/10-extraction.json) | An inverted slope formula, swapped table columns and a question missing its data link. |
| [11-extraction-control](cases/11-extraction-control.json) | Correct formula, table associations and source-context link. |

[Expected findings](expected-findings.json) are for the human evaluator. The
runner never reads that file into the model request. Judge supported findings
and erroneous accusations, not exact wording. Some overall statuses have
multiple acceptable values; the individual checks matter more.

Example from `01-claims`:

> Source: In the school settings examined by the authors, shared instructional
> leadership was associated with stronger teacher collaboration. This
> observational finding does not establish causation or guarantee an outcome.
>
> Draft: Shared leadership guarantees effective collaboration for managers in
> every industry.

Expected: flag both the unsupported guarantee and the broadened setting.
For `04-pages-other`, the coefficient values have text support, but a screenshot
of another page cannot visually verify their software table. Do not mark the
values false merely because their page image is missing.

## Run one case yourself

From the repository root, prepare the exact request without reading a key or
making a network call:

```powershell
uv run python bench/rag/scripts/knowledge_review_samples.py --case 03-pages --output bench/rag/reports/local/qwen-review-03-dry --dry-run
```

To send that case using your existing `.env.local` Alibaba settings:

```powershell
uv run python bench/rag/scripts/knowledge_review_samples.py --case 03-pages --output bench/rag/reports/local/qwen-review-03-live --env-file .env.local --send
```

Use a new output directory for each run. `--send` makes one model request and
does not retry or change models. It requires `ALIBABA_API_KEY` and
`ALIBABA_BASE_URL`; shell variables take precedence over the chosen env file.
No key is written into the request or results. The sample runner calls Max
directly; it does not use the builder helper fixed to Flash.

The proposed [request settings](request-settings.json) select `qwen3.8-max`,
temperature 0, thinking enabled, an 8,192-token output limit and JSON output.
These settings are included in the saved request. They have not yet been tested
against this workspace's Max endpoint. A fixed prompt and temperature 0 do not
guarantee identical answers.

The output directory holds `request.json`, a receipt, the provider's raw
`response.json` when available, and `review.json` if local schema and check
coverage validation passes. The raw response includes reported usage and model
identity. Passing those local checks does not prove the review is accurate;
compare it with the source and the separate expected findings.

You can also use another client: send `system-prompt.txt` and
`response-schema.json` as the instructions, the selected case JSON as data,
and every listed image as an actual image attachment labeled with its source,
version and physical PDF page. Sending filenames or image captions alone will
not test visual review. Do not include `expected-findings.json`.

## Sources and attribution

Cases 01, 02 and 06-09 are synthetic, written for this test. The second example
in case 05 is also synthetic. Their candidate artifacts are intentionally
constructed inputs, not recorded Sol outputs or historical research evidence.

The OpenIntro images and source-derived text in cases 03-05 and 10-11 come from
*OpenIntro Statistics*, David Diez, Mine Cetinkaya-Rundel and Christopher D. Barr,
4th edition, screen-reader PDF updated 2022-10-21. Source:
[OpenIntro Statistics](https://www.openintro.org/book/os/).
They are provided under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
The PNGs are unaltered full-page renders of physical PDF pages 358 and 359.
Text is normalized for the fixtures; deliberately incorrect candidate
transcriptions are test mutations, not representations of the original page.
Source-derived adaptations retain the same attribution and licence.

The images are bundled, so the original full PDF, library database, builder
state and original agent traces are not needed to run these samples.
Source identity is recorded in [manifest.json](manifest.json), and each case
binds its attached images by SHA-256. Expected findings were checked against
both full page renders locally.
