# Why the agent results differ

This follow-up inspects the saved 192 attempts. It makes no new provider calls,
changes no grades and leaves the cleaned VM stopped. Detailed path records are
saved locally in `/Users/sam/Downloads/capy-embedding-eval-20260906/chat-path-analysis.json`.
Ordinals below are zero-based positions in the archived `chat.jsonl`.

The higher Voyage retrieval score was measured on 360 public benchmark queries.
The agent comparison used a separate fictional corpus and 48 questions. The
result does not establish that improving retrieval for the same agent queries
caused worse answers. Even on the public queries, Voyage's nDCG advantage was
uncertain. Its intermediate-query retrieval can be worse on the agent corpus.

## Where the chain breaks

| Stage, 32 reference-chain attempts per model | Qwen3 4B | Voyage |
| --- | ---: | ---: |
| Correct field observation at rank one in first search | 32 | 32 |
| Correct accession-to-assay assignment ever reached | 28 | 18 |
| Correct procedure settings ever reached | 28 | 18 |
| Incomplete chains without any search for the discovered accession | 4 | 5 |
| Incomplete chains after searching the accession | 0 | 9 |

The incomplete chains ended after one or two calls for 4B and two or three for
Voyage. All tools completed without errors or refusals. None of these failures
received the repeated-results stop footer. The observations do not support
raising tool limits as the first response.

Fourteen Voyage chain attempts and four 4B attempts answered that information
was missing even though it existed. Five of those Voyage attempts never searched
for the accession found in the field observation. Nine did, but retained broad
terms about incubation and waiting time rather than isolating the missing
accession-to-assay relationship. The one generic second search without an
accession is included in the five.

## Retrieval and query formulation interact

In ordinals 34 and 142, both models received the exact query
`CT-777 incubation temperature waiting time procedure assignment` in the same
workspace. 4B returned the correct register assignment at rank one. Voyage
returned five seminar passages and no assignment. Voyage then reread the field
observation and claimed the answer was unavailable.

In ordinal 147, Voyage's query
`CT-432 incubation temperature waiting time teaching collection register`
returned five seminar passages. After listing sources, it searched
`CT-432 accession register assay assignment`, found the assignment at rank one,
and retrieved the correct procedure. The first query also appears in 4B ordinal
156, where it returned the correct assignment at rank one.

These are observed query matches and continuations, not controlled replays.
They show that a model's public benchmark ranking does not predict every
intermediate lookup, and that a useful next query can recover from a miss.
The records do not isolate dense retrieval from hybrid fusion as the cause of
these particular misses.

## The agent sometimes stops despite adequate starting evidence

Voyage ordinals 21 and 42, the two `bridge-09` repeats, had identical first
queries and identical returned passages, including CT-910 and a reference to
the collection register. One followed the register, found AX-750, and answered
75°C/68 minutes. The other read nearby field observations and claimed no setting
was available. This difference arose after identical initial retrieval.

The prompt already told the agent to follow identifiers and source references
before concluding an answer was unavailable. An instruction alone did not make
that behavior reliable. The failure is a choice of next action and an incorrect
inference from one document's limits to the whole workspace.

First searches averaged 2.94 seminar passages out of five with 4B and 3.19 with
Voyage. They repeatedly discuss incubation while saying their demonstration
settings are not specimen procedures. The answers often generalize those local
cautions into global absence. That is consistent with distractors contributing
to early stopping, but their causal effect needs an isolated test.

## Some support failures happen after retrieval succeeds

All eight comparison answers per model reached every required evidence group
and gave the correct times. Four 4B answers and all eight Voyage answers omitted
citations for specimen identities or assignment links. Retrieving more passages
would not address that omission. Both also had one Japanese answer fail to
resolve the glossary-defined specimen despite retrieving the glossary.

## Next experiment

Replay the same intermediate queries through both embedders, scoring the missing
relationship with dense and hybrid retrieval separately. Then feed identical
saved tool results to the fixed chat model and compare ordinary continuation
with an explicit unresolved-reference check before an absence answer. Keep the
missing-register controls in that experiment, so improved continuation cannot
hide invented assignments. Citation support should remain a separate score.

These interventions have not been tested here. The current evidence supports
investigating query formulation, intermediate retrieval, stopping and citation
writing separately; it does not establish one universal cause or a proven fix.
