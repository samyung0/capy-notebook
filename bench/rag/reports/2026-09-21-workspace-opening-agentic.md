# Workspace source-opening recovery through the chat loop

This tests one small catalog change: append the existing first-chunk heading
breadcrumb to each in-scope file in `list_sources`. Search still returns five
passages from 40 candidates. Names, model identifiers, ranking, source states,
ordering and scope rules are unchanged. The question is whether the extra
source clue helps the agent open the right document and avoid a false refusal.

The catalog-only candidate did not recover the failing author answer. Across
three fresh paired runs, both arms answered Mayor-Rocher/Reviriego correctly
zero times. Each arm made two false absence claims and ended once with an empty
answer at the planning limit. Keep the existing catalog and k=5 for now. The
next useful experiment is final-answer behavior on the already-reserved last
call, followed by earlier document inspection if needed.

## Results

The eight primary pairs gave 4/5 supported answers in both arms. Baseline
correctly handled all three evidence-gap requests; the candidate handled two
and returned an empty answer for the scoped author exclusion. That exclusion's
catalog was byte-identical in both arms, so this failure is not evidence that
the added heading harmed retrieval.

| Primary request | Baseline | Opening heading | Baseline / candidate LLM tokens | Baseline / candidate seconds |
| --- | --- | --- | ---: | ---: |
| Mayor-Rocher/Reviriego | False absence claim | Correct page captured, then empty at cap | 32,227 / 72,605 | 17.4 / 27.6 |
| WikiNER authors and institutions | Supported | Supported | 17,459 / 17,472 | 16.1 / 10.5 |
| DFKI in German report | Supported | Supported | 27,995 / 28,059 | 15.5 / 15.3 |
| Chinese fire question over English table | Supported | Supported | 16,602 / 16,648 | 10.4 / 9.0 |
| Author lookup excluding the relevant paper | Correct gap | Empty at cap; scope preserved | 65,633 / 65,882 | 29.3 / 29.0 |
| Genuine GPT-2 identifier | Supported | Supported | 9,384 / 9,383 | 6.4 / 5.4 |
| Unsupported GPT-20 identifier | Correct gap, explicit GPT-2 distinction | Correct gap, explicit GPT-2 distinction | 17,789 / 17,858 | 12.5 / 13.3 |
| ResNet Table 2 standard-deviation near-miss | Correct gap | Correct gap, unsupported aside | 17,535 / 17,935 | 10.7 / 9.6 |

The two prespecified author repeats did not improve this result.

| Additional Mayor pair | Baseline | Opening heading | Baseline / candidate LLM tokens | Baseline / candidate seconds |
| --- | --- | --- | ---: | ---: |
| Repeat 1 | False absence claim | False absence claim; one format repair | 32,234 / 30,241 | 25.2 / 48.4 |
| Repeat 2 | Correct opening read, then empty at cap | False absence claim after reading the wrong paper | 71,162 / 59,609 | 28.3 / 25.7 |

The primary Mayor candidate made four name searches before listing sources.
The new catalog exposed the exact heading with `Mayor-Rocher1` and
`Reviriego2`, without truncation. The agent then searched the correct paper
and captured page 1. The baseline's final repeat also found the correct paper
through the existing catalog and read its first three chunks. That read
included both names and the numbered UAM/UPM affiliations. Neither turn
finished an answer.

The candidate heading was shown in only one of ten candidate turns. The
other candidate listing was the scoped exclusion, where the permitted file
has no opening heading and the catalog stayed identical. Six primary control
pairs never listed sources. Differences in those unexposed turns cannot be
effects of the added field. This is a negative result for this whole-loop
candidate, with too few actual exposures to estimate the heading's effect
conditional on seeing it.

### Source and citation review

The four supported factual answers use the right source and page in both
arms. WikiNER page 1 assigns all three authors to Univ. Bretagne Sud/CNRS/IRISA
and Danrun Cao also to OctopusMind. DFKI page 17 supports OpenGPT-X and the
added JUWELS/German research context. Biology page 13 supports Homo erectus
and the added table details. The GPT-2 answer's cited chunk spans pages 1 and
2; its MarIA/Biblioteca Nacional Española claim is on page 2.

Both GPT-20 answers explicitly distinguish the missing identifier from GPT-2.
Their suggestion that the question contains a typo is marked as speculation.
Both ResNet answers correctly distinguish a single 25.03% error from a
standard deviation and cite captured page 5. The candidate then suggests
CIFAR-10 experiments as another place for the statistic. Its page-5 citation
does not support that suggestion, and a different dataset's statistic cannot
establish the requested 34-layer ImageNet variation. It passes the requested
evidence-gap test but fails the stricter check that every factual aside has
support. That gives 7/8 baseline and 5/8 candidate primary responses with all
factual claims supported, versus 7/8 and 6/8 for the requested answer alone.
The ResNet candidate never saw the added catalog field.

The scoped baseline's two citations stay in the selected paper, whose complete
indexed text contains neither requested author. Neither arm leaks the excluded
paper or its affiliations. The false Mayor refusals cite another paper's
authors; those passages cannot support a workspace-wide absence claim.
Accurate facts about unrelated authors do not rescue the answer.

Visual verification is a separate limit. Both GPT-2 answers add a supported
50% figure without a capture. Both GPT-20 answers capture page 1, while the
figure they quote is on page 2. Their text citations support the claims, but
they do not satisfy the prompt's numerical page-verification instruction.

### Cost and completion

| Measurement | Primary baseline, 8 turns | Primary candidate, 8 turns | All baseline, 10 turns | All candidate, 10 turns |
| --- | ---: | ---: | ---: | ---: |
| Total LLM input + output tokens | 204,624 | 245,842 | 308,020 | 335,692 |
| Median LLM tokens per turn | 17,662 | 17,896.5 | 22,892 | 22,997 |
| Total turn seconds | 118.3 | 119.6 | 171.9 | 193.7 |
| Median turn seconds | 14.0 | 11.9 | 15.8 | 14.3 |
| Model completion calls | 31 | 34 | 44 | 47 |
| Searches | 15 | 16 | 24 | 23 |
| Searches after the first in each turn | 7 | 8 | 14 | 13 |
| Document reads | 2 | 2 | 3 | 5 |
| Catalog listings | 1 | 2 | 2 | 2 |
| Page captures | 5 | 6 | 5 | 6 |
| Empty planning-limit answers | 0 | 2 | 1 | 2 |

No turn used `describe_documents`. No tool output was truncated; no provider
or tool execution failed. Embedding tokens were 546/575 for the primary arms
and 855/805 including repeats, separate from LLM tokens. Totals include all
provider-reported input and output, captures and format repairs. Cached input
is already part of input usage and is not added twice. Wall time includes the
whole turn. Each arm ran serially, while the separate knowledge investigation
could have one concurrent model call. Cloud variability and different tool
paths limit latency comparisons. Repeated Mayor runs are shown separately so
their cost does not silently overweight the primary set.

All three empty turns already received the reserved eighth completion with
tool schemas removed. The model returned another tool call anyway:
`search_workspace` after the candidate's correct page capture, `read_document`
after the baseline's correct opening read, and `read_document` for the scoped
negative. The loop stopped without a final OpenUI answer. This is recorded
provider behavior through the frozen Ollama transport, not a missing reserved
call. It also differs from the curate ledger stall guard.

The parallel [knowledge experiment](2026-09-21-knowledge-compact-finish.md)
reports the same Ollama pattern in its three empty distinct-example stalls:
the final call offered no tool schemas, but the provider returned
`create_material`, which the exhausted loop did not execute. The two studies
keep independent scores and stopping rules. Their shared observation concerns
completion at the tool-free boundary, rather than ranking quality.

The next bounded comparison should keep the original catalog and k=5, and
change only the final tools-off request to explicitly require an OpenUI answer
from available evidence or a precise evidence gap. First check the three saved
terminal contexts, then rerun fresh complete paired turns before considering
an application change. It must preserve the correct scoped and identifier
refusals and include the added completion cost. If author lookup still fails,
test an earlier catalog/document-opening step before repeated name-only
searches. The baseline already demonstrated that its existing catalog can
identify the paper. This experiment does not justify a name-normalization
framework, a reranker, a larger k, or the catalog field by itself.

## Protocol

The [fixture](../fixtures/workspace-opening-cases.json) contains eight requests:
the known Mayor-Rocher/Reviriego failure; the WikiNER author/affiliation page;
DFKI in a German report; the Chinese question over an English fire table;
an author lookup scoped to a different paper; GPT-2; the unsupported GPT-20
near-match; and the ResNet across-run standard-deviation near-miss.
There is one pair for every request and two further paired repetitions of the
Mayor request. Pair order alternates. These are diagnostic sources with inspected
labels, not an independent held-out estimate.

All twenty turns use Ollama `glm-5.3-flash:cloud`, low reasoning and temperature
zero. The current OpenUI chat prompt and tools are frozen in a copied runtime
under ignored `bench/rag/fixtures/local/2026-09-21-workspace-opening/runtime/`.
The copy includes 86 runtime, prompt, generated contract and playground files;
hashes before/after copying matched. No imports are taken from the concurrently
edited application runtime. Previous workspace results are historical context,
never controls for this comparison.

The existing chat limits remain 8 planning responses, 2 tools per response,
16 tools per turn and 8 captures. The tool-output ceiling is 8,192 estimated
tokens. Search, source listing, descriptions, document reads and page capture
are offered. No reranker, identifier-normalization rule, wider k or global
deduplication is introduced.

The database is the isolated, frozen lab index. Reads use an explicitly
read-only connection; all 29 source hashes and local PDFs are verified. Its old
schema has no note index, so read/list/description tools use the verified
snapshot while search uses production hybrid SQL. There are no study materials
in this workspace. The source-list adapter supplies a synthetic local actor
and inventory in place of the application gateway, then calls the production
listing function. Its chapter grouping, statuses, file counts and scope
behavior remain active. Production scope checks also guard searches and reads.

The candidate changes only `_file_line` output. Thirteen of 29 files have a
nonempty opening breadcrumb, totaling 833 source characters. With field labels,
the complete catalog grows from 12,259 to 13,534 characters, or 3,065 to 3,466
estimated tokens. The added 401 tokens do not hide any of these 29 files. Larger
catalog truncation behavior was not tested. Direct checks
confirm every file remains present, neither catalog is truncated, an excluded
author paper and its names are absent from the scoped catalog, and an empty
scope stays empty. Removing just the added heading lines reproduces the
baseline catalog exactly.

## Primary review

Score final source-supported claims, citations and false refusals after the
whole loop. Track whether the candidate field was actually shown: a turn that
never lists sources cannot establish the field's effect. The second author page
was checked against original PDF pixels; its superscripts assign all three
authors to Univ. Bretagne Sud/CNRS/IRISA and Danrun Cao additionally to
OctopusMind. The GPT-20 and scoped-author negatives were checked against the
complete permitted indexed text. Remaining source anchors reuse hash-verified
original-page checks from the earlier investigation.

Costs include all model responses, repairs, searches, descriptions, reads and
captures. Catalog output size and truncation are separate diagnostics. OpenUI
answers are retained verbatim; the frozen parser's `text_of` supplies plain text
only for assessment. No separate model judge is used.

## Receipts and reproduction

The [runner](../scripts/workspace_opening_agentic.py) uses the existing
playground and verified local corpus. Raw outputs are in ignored
`bench/rag/reports/local/2026-09-21-workspace-opening/`.

- `protocol.json` freezes the schedule, cases and runner/runtime input hashes.
- `catalog-check.json` saves full baseline/candidate catalogs and check results.
- `runs/repeat-*/<case>/<arm>/` saves exact provider/tool traces, rendered
  answers, citations, captures and 40-candidate search rows.
- `source-pages/` holds the independent WikiNER author-page inspection.
- `assessment.json` saves the manual per-turn claim and citation review.
- `summary.json` saves the measured totals and metric definitions.
- `postrun-verification.json` confirms the copied runtime, runner, fixture,
  snapshot and read-only lab contents remained unchanged.
- `lab-lifecycle.json` records the isolated container's initial and final
  stopped state. It exited cleanly with code 0 after the suite.

An incomplete preflight exposed an adapter issue: current production
`list_sources` requires an actor identity, which ordinary playground chat omits.
All initial turns were stopped and archived under `excluded-identity-preflight/`.
The adapter now supplies the local identity and direct listing/scope checks run
before any model turn. Every scored pair restarts; neither the source corpus,
runtime copy, candidate nor case labels changed. `protocol-amendment.json`
records this correction. Those excluded turns never enter the scores.

```sh
.venv/bin/python bench/rag/scripts/workspace_opening_agentic.py check
.venv/bin/python bench/rag/scripts/workspace_opening_agentic.py prepare
.venv/bin/python bench/rag/scripts/workspace_opening_agentic.py run
```

`prepare` refuses to replace an existing copied runtime. The run needs the
authorized isolated lab, ingest-host SSH key, UAT query-embedding credential
held only in memory, and configured local Ollama. No production service,
application configuration, database content, commit or branch is changed.

Validation passed: the runner's schedule/scope check, targeted Ruff lint and
format checks, Python compilation, JSON parsing, all 20 provider-token sums
and tool counts, and final copied-runtime/input hashes. The repository-wide
Python formatting command remains blocked by the existing unapproved
`@openuidev/lang-core` dependency build; the targeted checks do not invoke it.
