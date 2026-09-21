# Qwen book review, September 21

The developer narrowed the trial to text-only book-artifact review. The active
[version 2 pack](../fixtures/knowledge-review-v2/README.md) replaces the earlier
combined material/page/book proposal. Version 1 is retained as a historical
snapshot matching the previously uploaded ZIP.

## Responsibilities

| Owner | Responsibility | Completion |
| --- | --- | --- |
| Sol medium | Initial parsing/source recovery, source-page checks, full notes, roles, retrieval scope, context links, topic proposals and final tagging | Complete its assigned initial workflow; save full local artifacts and a text handoff |
| Qwen3.8-Max | Independently compare book annotations with supplied corrected source text | Return findings for later triage in a separate asynchronous batch |
| User-selected runtime model | Realtime study-material research and writing | Existing user-initiated agent loop |

Qwen has no material review, numerical accuracy checks, page or formula/table
verification, or separate duplicate-example audit. Sol's initial source-page
checks remain in the review contract. No extra image cache is needed for Qwen.
Sol does not submit, poll, wait for, or repair Qwen reviews. Qwen findings neither
edit the library automatically nor gate initial publication.

## Fixed inputs

The [Qwen system prompt](../fixtures/knowledge-review-v2/system-prompt.txt) covers
roles, note fidelity and preservation, retrieval scope, topic reuse/fit and
necessary context links. It requires evidence for findings and distinguishes
missing text from a contradiction. Metadata not yet reviewed is backlog.

The [Sol assignment template](../../../lab/knowledge/sol-assignment.txt) is the
fixed initial-processing message. The paused kb scheduler sends it verbatim,
then a separate assignment record. It saves the exact message, template hash
and frozen review contract. The record identifies the book, paths, hashes,
explicit coverage, allowed stages, stopping stage and split-book ownership.
Fixed wording makes variation inspectable; it does not guarantee identical
model output or tool choices. This remains prompt-directed dispatch, not a new
scheduler implementation.

The handoff references corrected source text, full reviewed notes, final tags,
the catalog/proposal/merged IDs, validation receipts and unresolved items. Hashes
bind mutable local artifacts so a later batch can detect changes. A batch
exporter should consume that saved snapshot rather than reconstruct context
from a chat. No production batch submission or repair service is added here.

## Evaluation

Seven synthetic cases test seeded book defects and clean controls. A separate
real case assigns 13 unchanged candidate tags from the earlier Chinese Contract
Law topic-owner trial and supplies all 58 corrected excerpts for context. Most
notes and roles in that candidate were inherited from previous processing; Sol
proposed topics, preserved notes and corrected five administrative roles after
feedback. Findings cannot all be attributed to new Sol work.

The trial uses isolated requests through the existing Alibaba credentials.
These are prompt tests, not a realtime agent loop. The helper saves request
hashes, responses and usage, checks JSON shape, target coverage and verbatim
quotes, and never imports suggested changes. Expected answers are kept out of
the requests. The sample has no numerical/page accuracy claim.

## Results with the requested configuration

All eight cases ran with Qwen3.8-Max, thinking disabled, strict JSON Schema and
no caller-specified token limit. Each returned valid JSON and supplied every
assigned target. Four affected cases were rechecked after one prompt refinement.
The settings are sent on the wire, not merely mentioned in the prompt.

| Case | First strict run | Targeted recheck |
| --- | --- | --- |
| Book defects | Found wrong role/topic, redundant/missing topics and unsupported R requirement; missed the shortened full note | Found the full-note loss as well |
| Corrected book control | Pass | Pass |
| Missing review scope | Incomplete; no whole-book pass | Not rerun |
| Wrong context link | Found the wrong question/model link | Not rerun |
| Correct context link | Pass | Not rerun |
| Cross-domain scope defects | Found all five affected scope fields | Not rerun |
| Clean cross-domain scope | Three unnecessary or out-of-scope findings, including rejecting a valid limit on evidence | Pass |
| Real candidate sample | Mixed useful and incorrect findings | Five findings: two clear role errors, one incorrect role change, one unnecessary note edit and one topic recommendation requiring catalog triage |

The refinement explicitly requires comparing every final synopsis with the full
reviewed note; keeps independent errors separate; distinguishes an evidence limit
from a factual exclusion; preserves definitions inside course overviews; and
requires reading the whole topic catalog entry. Strict schema categories now
match the assigned fields, preventing scope-only trials from returning unrelated
note findings.

On the real candidate, excerpts 19 and 39 are incorrectly tagged as exercises:
one continues a definition and one supplies statutory lookup text. These are
inherited tags. Qwen also tried to turn an objectives-only transition into
teaching content, proposed an unnecessary wording edit, and recommended removing
a topic despite that catalog entry explicitly including the section. It still
missed excerpt 6's explanatory/reference role mismatch and excerpt 57's invented
claim that a creditor directed repayment. The latter can be checked from text;
no visual or numerical review is needed to find it.

**Use Qwen as an advisory review, not automatic acceptance or repair.** The small
synthetic tests demonstrate some useful checks. They do not establish reliable
whole-library quality, especially after tuning on those same cases. The real
sample exposes both missed errors and overreaching suggestions. No Qwen findings
were applied to canonical books, and no Sol/Qwen correction loop was started.

The eight first strict calls took 2.97-25.70 seconds each and reported 39,774
input plus 3,187 completion tokens. Four targeted rechecks took 2.67-22.13 seconds
each and reported 33,679 input plus 1,879 completion tokens. Totals for this
configuration are 73,453 input and 5,066 completion tokens. These are provider
usage fields, not an invoice estimate. Existing Alibaba credentials worked.

[Saved results and manual adjudication](2026-09-21-qwen-book-review/results.json)
include each response, request/prompt hashes and usage. Raw local requests and
responses are under `bench/rag/reports/local/2026-09-21-qwen-review-v2-*/`.
Two focused offline tests pass, covering no-send/answer-key isolation, the exact
request settings, schema/coverage, field scope, verbatim evidence and status
consistency. Formatting and lint checks pass.

## Preliminary attempts retained for audit

Before the developer specified non-thinking mode, the first call hit a
180-second timeout with unknown provider completion/usage. Nine thinking-mode
responses were obtained during initial checks. The intended book control
contained an unsupported `normally` hedge; it was removed from both baseline
and final notes before the current trials. One real-book thinking response
failed exact-quote validation after replacing curly quotation marks with straight
ones. The initial non-thinking schema request returned HTTP 400 because Alibaba
rejects `uniqueItems` on arrays. Array uniqueness is now checked locally while
the provider enforces the supported strict schema. No model or JSON-mode fallback
was used, and the helper never retries automatically.

The old 8,192-token cap and reasoning budget have been removed. Current calls
set `enable_thinking=false` and omit all caller token limits. Provider/model
limits still apply. The preliminary attempts are excluded from the usage totals
above and retained in the result record.

## Reproduction and credentials

Use the commands in the pack README. Dry run reads no credentials and sends
nothing. Send mode reads ALIBABA_API_KEY and ALIBABA_BASE_URL from the supplied
local env file or environment, makes one request, and has no retries or model
fallback. Region/workspace and model access must match the key.

The request uses `response_format.type=json_schema`, `strict=true`, thinking
disabled and no caller token limit, following
[Alibaba's structured-output documentation](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output).
Exact settings and the schema are in the pack.

Agent stalling and material-ledger completion remain deferred. Additional
metadata coverage is normal processing work, not a blocker for this trial.
