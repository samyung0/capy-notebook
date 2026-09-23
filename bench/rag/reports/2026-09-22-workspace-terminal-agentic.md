# Workspace final-response instruction through the chat loop

Keep the existing workspace catalog and five-passage search. The bounded
follow-up supports an explicit final-response instruction as the next workspace
change to consider. It does not support a ranking, catalog or top-k change.

The candidate answered the Mayor-Rocher/Reviriego request correctly in all three
fresh trials. Each answer used the changed eighth, tools-off completion. The
baseline answered correctly zero times: twice it returned another tool call and
ended empty, and once it falsely claimed the authors were absent. The candidate
used the existing catalog and source reads to reach the correct author evidence.

This is evidence for the demonstrated completion failure, not complete
application-promotion evidence. All candidate negative controls finished before
the eighth completion, so none tested refusal behavior under the new instruction.
The comparison also uses Ollama, not the application's Tencent transport. No
application code or configuration changed, and this investigation ends here.

## What was already tested

The [workspace abstention comparison](2026-09-21-workspace-agentic-retrieval.md)
ran 34 turns. The current loop answered all eight available-source primary
questions; lexical-protected distance abstention answered seven and stalled on
the author lookup. Repeats exposed a baseline false refusal too. Wider k had no
demonstrated final-answer failure to repair.

The [source-opening comparison](2026-09-21-workspace-opening-agentic.md) ran 20
fresh turns. Adding first-chunk headings to `list_sources` produced no author
answer in three pairs. Two empty turns had already reached correct source
evidence. All three empty turns received the reserved eighth completion without
tool schemas, but the model returned another tool call. That concrete failure
justified this follow-up. Neither earlier candidate is ready for promotion.

## Fresh paired results

The primary comparison contains five pairs. Two further author pairs were fixed
before the run. Requested claims and correct evidence gaps are scored separately
from the correctness of every added aside and compliance with page capture.

| Primary request | Baseline | Final instruction | Baseline / candidate LLM tokens | Baseline / candidate seconds |
| --- | --- | --- | ---: | ---: |
| Mayor-Rocher/Reviriego | Correct opening read, then empty at cap | Supported author and affiliation answer | 69,731 / 72,496 | 24.8 / 28.2 |
| Author lookup excluding the relevant paper | Scope preserved, then empty at cap | Correct scoped gap | 81,286 / 26,315 | 27.5 / 15.5 |
| Genuine GPT-2 identifier | Supported MarIA and Spanish-data answer | Supported MarIA and Spanish-data answer | 28,099 / 9,451 | 15.6 / 26.3 |
| Unsupported GPT-20 identifier | Correct gap; explicitly distinguishes GPT-2 | Correct gap; explicitly distinguishes GPT-2 | 17,833 / 28,522 | 12.1 / 18.2 |
| ResNet Table 2 standard deviation | Correct gap; unsupported added aside | Correct gap | 17,024 / 17,539 | 13.0 / 10.7 |

| Additional author pair | Baseline | Final instruction | Baseline / candidate LLM tokens | Baseline / candidate seconds |
| --- | --- | --- | ---: | ---: |
| Repeat 1 | False workspace-wide absence claim; one format repair | Supported answer after page-1 capture | 23,638 / 77,046 | 18.2 / 27.7 |
| Repeat 2 | Correct page-1 capture, then empty at cap | Supported answer after page-1 capture | 71,023 / 72,126 | 30.9 / 38.6 |

The primary requested outcomes are supported in 3/5 baseline and 5/5 candidate
turns. Including author repeats, they are supported in 3/7 and 7/7. These are
previously inspected diagnostic questions, not a held-out success-rate estimate.

### Actual exposure to the instruction

Only the three candidate author turns received the instruction. All three
returned valid OpenUI answers and no tool calls. The baseline tools-off calls
returned `read_document` for the primary author request and scoped exclusion,
and `search_workspace` for the second author repeat. All three ended empty.

The other four candidate turns received byte-for-byte the usual request
construction, without the new instruction. Their different search paths and
costs cannot be credited to the candidate. In particular, the successful scoped
refusal does not establish that the new instruction preserves a refusal at the
tools-off boundary. One baseline author turn falsely refused before that boundary;
a final-only instruction would not act on that path.

### Source and citation checks

All three candidate author answers identify coauthorship and the page-1
affiliations correctly: Mayor-Rocher at Universidad Autónoma de Madrid and
Reviriego at Universidad Politécnica de Madrid. The indexed heading preserves
the names with attached affiliation numerals, and the read text preserves the
numbered institutions. Original page pixels confirm the mapping. Added study
descriptions and conclusions are supported by the cited abstract and conclusion
passages. The baseline's false refusal cites another paper's authors; those
citations cannot support a workspace-wide absence claim.

The complete permitted text for the scoped exclusion contains neither author.
Neither arm accesses or cites the excluded paper. The baseline makes one refused
`read_document` call with `count=14`, above the existing maximum of 12, then
continues within scope. This is a model argument refusal, not a provider or
database failure.

Both GPT-2 answers correctly identify MarIA and Biblioteca Nacional Española.
Both GPT-20 answers distinguish the missing identifier from GPT-2 and mark their
typo suggestion as speculation. Their extra 50% figure is supported by the
cited page-2 text. The baseline GPT-2 turn captures that page; the candidate
GPT-2 turn makes no capture, and both GPT-20 turns capture only page 1. Those
three answers miss the prompt's numerical page-verification rule. None of these
candidate turns receives the final instruction.

Both ResNet turns capture page 5 and correctly say Table 2 gives no across-run
standard deviation. The baseline additionally says the 34-layer plain/ResNet
gap is the only possible cross-model comparison. The four table values permit
other comparisons, so that aside is false. Its description of the value as one
run is also more specific than the table establishes. The candidate's requested
gap and added table values are supported. These turns also finish before the
instruction could apply.

## Full-turn cost

| Measurement | Primary baseline | Primary candidate | All baseline | All candidate |
| --- | ---: | ---: | ---: | ---: |
| Turns | 5 | 5 | 7 | 7 |
| LLM input + output tokens | 213,973 | 154,323 | 308,634 | 303,495 |
| Median LLM tokens | 28,099 | 26,315 | 28,099 | 28,522 |
| Total turn seconds | 93.0 | 98.9 | 142.1 | 165.2 |
| Median turn seconds | 15.6 | 18.2 | 18.2 | 26.3 |
| Model completion calls | 26 | 21 | 38 | 37 |
| Searches | 13 | 12 | 20 | 21 |
| Document reads | 3 | 1 | 4 | 3 |
| Source listings | 1 | 1 | 1 | 2 |
| Captures | 4 | 2 | 5 | 4 |
| Query embedding tokens | 466 | 439 | 708 | 755 |
| Empty final answers | 2 | 0 | 3 | 0 |

Totals include every completion, repair, search, read and capture in each turn.
Cached input is already part of input usage. A separate 23-token transport
readiness request is excluded. The candidate's aggregate token total is 1.7%
lower and its elapsed total is 16.3% higher. Different unexposed tool paths,
early wrong answers and cloud timing make these descriptive totals, not an
efficiency result. There were no provider failures or truncated tool outputs.

## Protocol and receipts

The [runner](../scripts/workspace_terminal_agentic.py) reuses the frozen
source-opening runtime and its read-only database adapter. The source
[fixture](../fixtures/workspace-opening-cases.json) supplies the five selected
cases. Pair order alternates, with two prespecified author repeats. All fourteen
turns use Ollama `glm-5.3-flash:cloud`, low reasoning and temperature zero, the
same chat prompt, five search results from forty candidates, and the existing
8/2/16 planning, per-response and per-turn limits. No reranker is involved.

The candidate appends one system instruction to the eighth request after its
tool schemas have been removed. It requires a final OpenUI answer from the
available evidence, nearby supporting citations, or a precise remaining gap;
it forbids further tool calls and warns that failed searches do not establish
workspace-wide absence. Its exact text is frozen in the runner and run protocol.
This benchmark inserts it at the transport boundary. Provider-reported token
totals include it; the earlier application context estimate does not. No request
approaches the model context limit.

The previous runs retained tool outputs, capture files and provider usage, but
not complete submitted messages, so no exact replay of those old terminal
contexts was possible. This run records complete provider request bodies and SSE
responses under ignored local output. Authentication headers and credentials are
excluded. Each arm runs a fresh complete loop. Historical results are context,
never comparison controls.

Artifacts are under ignored
`bench/rag/reports/local/2026-09-22-workspace-terminal/`:

- `freeze.json`, `cases.json` and `protocol.json` freeze the candidate, schedule
  and input hashes.
- `runs/repeat-*/<case>/<arm>/` contains full turns, source results, citations,
  captures and exact provider bodies in `provider/`.
- `assessment.json` records manual judgments and hashes of every scored run;
  `summary.json` records the totals above.
- `trace-verification.json` checks all 75 recorded provider requests, the three
  actual instruction exposures, original catalogs and scored-run hashes.
- `postrun-verification.json` confirms the frozen runtime, lab content and
  inputs remained unchanged. All 86 runtime files and 29 sources passed hash
  checks before the run.
- `lab-lifecycle.json` confirms the existing isolated `capy-odl-agentic-db`
  container returned to its initial stopped state with exit code zero.

The shared library and B2 were not accessed. Searches used explicit read-only
transactions against the isolated frozen lab index; source reads used the
verified snapshot and local PDFs. Notes remain outside this source-only corpus.
The inherited runner's catalog preflight also saves the unused historical
opening-heading catalog, but neither scored arm enables that catalog change.

```sh
.venv/bin/python bench/rag/scripts/workspace_terminal_agentic.py check
.venv/bin/python bench/rag/scripts/workspace_terminal_agentic.py run
```

`run` needs the existing isolated lab database, ingest-host SSH access, its
embedding credential held in memory and configured local Ollama. It refuses
changed inputs rather than mixing them into this result. Targeted Ruff lint and
format checks, Python compilation, schedule/source checks and all fourteen
provider-token sums passed. No branch, commit, deployment or application edit
was made.
