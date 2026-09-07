# Qwen3.8 Flash chat comparison

Run: 6 September 2026 UTC / 7 September JST. Qwen3.8 Flash answered more
questions correctly than DeepSeek Flash Vision with both tested embedders.
The strongest combination here was Qwen3.8 Flash with Qwen3-Embedding-4B:
92/96 correct, including all 80 answerable attempts. Its stricter supported-answer
score was 70/96, only two better than DeepSeek with the same embeddings.

This supports trying Qwen for reference-following, but the current integration
needs work before adoption: ten Qwen attempts ended with an empty answer,
and citation errors and unsupported extra claims remained common.

## Primary results

Each row contains the same 48 questions repeated twice. Correctness checks the
requested answer. Strict support additionally requires every material claim to
be grounded in observed evidence and the citations to support their attached
claims and required evidence chain. Blank answers fail both measures.

| Chat model | Embeddings | Correct | Strict support | Blank | Median / p95 seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| DeepSeek Flash Vision | Qwen3 4B | 87/96 (90.6%) | 68/96 (70.8%) | 0 | 8.51 / 18.42 |
| Qwen3.8 Flash | Qwen3 4B | **92/96 (95.8%)** | **70/96 (72.9%)** | 2 | 10.63 / 31.30 |
| DeepSeek Flash Vision | Voyage 4 Large | 79/96 (82.3%) | 55/96 (57.3%) | 0 | 8.39 / 16.21 |
| Qwen3.8 Flash | Voyage 4 Large | **85/96 (88.5%)** | **64/96 (66.7%)** | 8 | 10.36 / 24.59 |

All 192 Qwen attempts received a completed agent status, including the ten
empty replies. Two provider requests timed out before streaming; the frozen
pre-byte retry policy recovered them. One tool call was refused because Qwen
supplied `file_ids` as a JSON string instead of an array. It belonged to a blank
attempt. There were 1,038 primary provider requests across the 192 attempts.

| Subset | DeepSeek + Qwen4B | Qwen3.8 + Qwen4B | DeepSeek + Voyage | Qwen3.8 + Voyage |
| --- | ---: | ---: | ---: | ---: |
| Answerable: correct / 80 | 75 | **80** | 65 | **76** |
| Answerable: strict / 80 | 67 | **69** | 52 | **63** |
| Missing evidence: correct / 16 | 12 | 12 | **14** | 9 |
| Missing evidence: strict / 16 | 1 | 1 | **3** | 1 |
| Three-step bridges: correct / 32 | 28 | **32** | 18 | **30** |
| Three-step bridges: strict / 32 | 27 | **29** | 17 | **26** |

Missing-evidence questions remain a weakness. Qwen sometimes correctly withheld
the requested value but added unsupported claims that an identifier or revision
could not exist anywhere in the workspace. Ranked search results do not establish
that coverage. All four DNA-sequence attempts falsely concluded that no DNA had
been measured, instead of saying the supplied documents did not contain a sequence.

## What changed in the agent's behavior

Qwen more often followed a specimen description to its accession, then to the
assigned assay, then to the manual. For 46 paired bridge attempts, both models'
first search had the exact same query, ordered chunk IDs and passage text.
Of these, 32 were correct under both models, 13 changed from DeepSeek incorrect
to Qwen correct, and one remained incorrect. Two additional pairs used the same
query but returned different passages; they are excluded from these counts.

For example, `bridge-15 / qwen4 / repeat 0` started with identical evidence.
DeepSeek read the field note and stopped without the answer. Qwen followed
CT-322 to AX-236 and obtained the settings. `bridge-09 / voyage4 / repeat 1`
shows the same contrast through CT-910 and AX-750. These are observed matched
first searches, not a forced replay of identical complete tool histories.

That persistence also caused unnecessary searching. Qwen averaged 4.19 tool
calls with Qwen4B and 4.76 with Voyage, versus DeepSeek's 3.31 and 3.51.
All ten empty answers exhausted twelve planning steps. Seven concerned missing
evidence; three were answerable and had already reached the full required chain.

Strict failures also included a nonexistent citation `[30]` when only 29
references existed; citation numbering restarted against the wrong sources;
omitted glossary citations in translated questions; incorrect citations for
seminar ranges; invented specimen counts; and a false claim that using an old
incubation time would reverse a comparison when it would not. Complete per-answer
notes are retained in `answer-reviews.json`.

## Empty-answer diagnosis

The frozen agent omits tool definitions on the last planning step
(`runtime/retrieval/agent.py:270`). Qwen nevertheless returned tool calls in all
ten cases. The agent discards tool calls only for its separate credit-exhaustion
terminal path (`:405–410`), so it executed another tool and left the loop without
producing answer text. The service then reported completion.

After the primary run, `probe.py` replayed all ten final requests with only
`tool_choice="none"` added. All ten still returned tool calls and no answer;
there were no replay errors. Thus adding that parameter alone did not fix the
observed endpoint behavior. Alibaba documents the parameter in its
[Chat API reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions).
The archive includes request hashes, original response IDs and all replay chunks.
These diagnostic requests do not replace or improve any primary score.

Two further replays restored the original tool definitions as well as setting
`tool_choice="none"`: one missing-evidence case and one answerable bridge.
Both again returned tool calls and no answer. `schema-probe.json` retains their
full request bodies and responses. This rules out omitted tool schemas as the
sole explanation for those two cases; it does not identify the endpoint's
internal cause.

The app needs to enforce the planning limit itself and handle an empty terminal
response explicitly. Provider controls need verification against this endpoint
before relying on them. No application change or deployment was made in this run.

## Controls and limits

The comparison used the frozen original agent, prompts, reference-following
instruction, tool schemas, result limits, temperature 0.3, timeout and retry
policy. Qwen thinking was explicitly disabled to match DeepSeek's recorded
instant mode. The actual Alibaba request and response model was verified as
`qwen3.8-flash`; the unchanged lab database's DeepSeek model pin served only the
admission and accounting envelope.

Only Qwen3-Embedding-4B at 2,560 dimensions and Voyage 4 Large at 2,048 dimensions
were tested. The exact cached document vectors for all 532 chunks in the two
curated workspaces were restored into temporary tables. Live query embeddings
used the previous provider routes and formatting, without a query cache. Search
used exact distances with no ANN index. Other workspaces could not contribute.

The post-run audit verified all 19,821 source chunks' index fingerprints, all
31 workspace pins, 478 retained older artifact hashes, six frozen chat input
files and four loaded runtime source modules. The adapter hash also matched its
pre-run freeze. The 192 primary and two pilot conversations were disjoint from
all 315 original conversations.

Codex reviewed all 192 complete answers and their cited and observed source
evidence under the previous protocol. This was not blind or independent human
grading. These are 48 known fixtures, not a fresh holdout; the two repetitions
are dependent observations. The corpus is curated and small. Provider, network,
cache and run-time conditions differ, so the latency numbers describe these
end-to-end runs rather than isolated model inference speed. The smaller scratch
tables can also affect database timing even though the scoped candidate sets match.

Question-cluster bootstrap intervals (10,000 resamples, retaining both repeats)
are wide. Qwen minus DeepSeek correctness was +5.2 percentage points with Qwen4B
(95% interval 0.0 to +11.5) and +6.3 with Voyage (-4.2 to +17.7). Strict support
was +2.1 points with Qwen4B (-6.3 to +11.5) and +9.4 with Voyage (-3.1 to +21.9).
These describe variation across the fixtures and do not establish a general
population ranking.

## Usage, artifacts and cleanup scope

Primary Qwen calls reported 5,176,695 input and 67,138 output tokens, including
3,586,560 cached input tokens (69.3%). Applying the published Frankfurt global
rates of $0.113 per million input tokens, $0.014 cached input and $0.382 output
gives **$0.256 for primary Qwen chat calls**. This excludes embeddings, pilots
and diagnostic replays; it is a list-rate estimate, not an invoice. Rates were
checked against Alibaba's [model page](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-8-flash).
The lab's DeepSeek-priced ledger must not be used as the Qwen bill.

The archive contains the raw turns, tool evidence, provider receipts, source
snapshots, per-answer reviews, frozen runtime, exact curated vector cache,
comparison code and JSON, diagnostics, provenance audit and file manifest.
Unchanged baseline answers and reviews are included under `baseline/`, so
`python compare.py baseline .` recomputes the results from the extracted root.

Cleanup is gated on matching remote and downloaded archive hashes, the embedded
manifest, every listed file hash and the exact owned conversation set. It removes
the 194 new conversations and their messages, the temporary vector schema,
new container, remote experiment files and temporary credentials, and restores
the reused containers to their initial stopped state. Older labs, volumes,
images and append-only accounting records are retained. Completion receipts live
beside the archive because they are produced after archive verification.
