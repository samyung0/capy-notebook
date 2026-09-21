# Text-only Qwen book review samples

Qwen reviews processed book artifacts against supplied text: teaching roles,
full notes, retrieval scope, topics and necessary context links. Sol owns initial
source/page inspection. There is no material review, image upload, formula/table
verification or separate duplicate-example audit in this pack.

The production plan is a separate asynchronous batch. This helper sends one
isolated request for prompt testing; it does not implement a batch service or
run inside Sol or the realtime study agent. Findings are proposals, not edits.

## Cases

| Case | Purpose |
| --- | --- |
| `01-book-defects` | Objectives misclassified, duplicate/missing topics, R restriction and lost full notes |
| `02-book-control` | Corrected book; should pass |
| `03-missing-scope` | Absent review assignment blocks a whole-book coverage claim |
| `04-context-defect` | Solution linked to a different dataset/model |
| `05-context-control` | Correct question/solution link; should pass |
| `06-scope-defects` | Population, causal claim, jurisdiction/period, incidental example, method and unit scope |
| `07-scope-control` | Supported cross-domain scope; should pass |
| `08-real-book-sample` | 13 unchanged candidate tags from the saved Sol topic-owner trial, with all 58 source excerpts for context |
| `09-real-book-repaired-control` | Three selected passages from case 08 with supported note/role corrections and consistent catalog coverage; should pass |

The first seven cases are synthetic. Their errors are deliberately seeded, not
observed Sol errors. The real sample has mixed provenance: most notes and roles
were inherited; Sol did topic work and corrected five administrative roles after
feedback. Missing retrieval metadata is declared backlog. It is not a new
full-book Sol source review or a prescored benchmark.
Case 09 is a deliberately repaired control derived from that real source, not
an untouched Sol output. It keeps the old erroneous synopsis for comparison
with its corrected final note and retains the already-correct transition tags.

The system prompt includes concrete previous failures, including no-op fixes,
inherited unsupported notes, non-verbatim quotes and catalog conflicts. Reruns
of those examples measure regression behavior, not unseen-book accuracy. The
corrected control checks that example IDs do not trigger automatic findings.

`expected-findings.json` is a separate human answer key. It is never sent to the
model. Review substantive findings against the text; schema/quote validation
alone cannot establish that a proposed correction is useful.

## Run from the repository or extracted portable pack

Use Python 3.11 or newer. From the root containing `bench/`, install:

```sh
python -m pip install -r bench/rag/fixtures/knowledge-review-v2/requirements.txt
python bench/rag/scripts/knowledge_review_samples.py --case 01-book-defects --output runs/book-dry --dry-run
```

Dry run does not read credentials or call a provider. Inspect `request.json`.
For a paid call, supply `ALIBABA_API_KEY` and `ALIBABA_BASE_URL` in the environment
or your own local `.env` file. Use the OpenAI-compatible base URL for the key's
Alibaba workspace and region, ending in `/compatible-mode/v1`.

```sh
python bench/rag/scripts/knowledge_review_samples.py --case 01-book-defects --output runs/book-live --env-file .env --send
```

To test an actual packet emitted by Sol, replace `--case` with `--packet`:

```sh
python bench/rag/scripts/knowledge_review_samples.py --packet my-book.packet.json --output runs/my-book --env-file .env --send
```

This uses the current prompt and unchanged packet text. It has the same explicit
`--dry-run`/`--send` boundary and does not modify the packet or library.

For a thinking-mode comparison, add `--thinking` to either command. It changes
only `enable_thinking` for that request; the saved fixture settings remain
non-thinking. Both modes retain strict JSON Schema and omit output-token and
thinking-budget limits. The saved response retains provider-reported usage.

By default, each invocation makes one call with `request-settings.json`: Qwen3.8-Max,
thinking disabled, temperature zero and a 600-second request timeout. The runner
sends `response_format.type=json_schema` with `strict=true` and
`response-schema.json`, restricting finding categories to the assigned fields.
It sends no output-token limit or thinking budget;
provider/model limits still apply.
There are no retries or model fallbacks. Use a new output directory for each run.
The runner saves the exact request/hash, receipt, raw response, usage and a
validated review. Failed validation leaves the raw response for inspection.
HTTP errors are saved locally with the configured key redacted. Do not share
your `.env` file. Model output may vary despite a fixed prompt and temperature.

The compact response lists reviewed targets, findings and missing text/artifacts.
Every assigned target must be accounted for. Source quotes must match supplied
excerpts exactly. Missing images do not make a review incomplete. The reviewer
does not certify numerical correctness or agreement with the original PDF.
Array uniqueness is checked locally because this provider rejects `uniqueItems`
in strict JSON schemas. Provider-enforced JSON structure does not certify the
reviewer's judgments; see the accompanying report for missed errors and
unnecessary findings in the [trial report](../../reports/2026-09-21-qwen-review-proposal.md).
The [failure-example comparison](../../reports/2026-09-21-sol-qwen-failure-examples.md)
records later prompt revisions, repaired controls and actual Sol-packet results.

## Source attribution

The real source is *Chinese Contract Law*, Walter Lee, Jenny Chung, Caroline
Leung, Dr Zhang Xiaoyang and Shi Xuemei, The Open University of Hong Kong, 2009.
It is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
[Book page](https://www.opentextbooks.org.hk/tertiary-institutions/18118).
The real fixture records the PDF and local input hashes. Source text was
extracted and corrected in the existing pipeline; the pack omits geometry and
retains text, IDs, sections and page locators. All 58 excerpts are included as
context, with 13 selected candidate tags unchanged. Adapted source portions
remain under CC BY-SA 4.0. No PDF or images are bundled.
