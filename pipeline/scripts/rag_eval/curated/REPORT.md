# Curated RAG results — 5 September 2026

The local patch adds an instruction to follow source references and exposes file
IDs and chunk positions in tool results. On the frozen held-out comparison,
supported answers rose from **14/20 to 19/20**; median turn time rose from
**6.52 s to 8.23 s**. This improves the existing agent loop without an index or
ranking change. It does not eliminate incorrect refusals or citation gaps.

## Scope

The experiment uses a fresh, isolated lab on the ingest VM, built from
`a903b8e917144701186b9c6cd2a6bbeea1bd15f9`. All documents went through the normal
upload, parsing, ingest, and indexing path. The lab has separate databases and
volumes; no production data was used.

The corpus is a fictional Autumn 2026 course with 32 independently assigned
specimen → accession → assay chains. The final answer values are invented, so
general model knowledge cannot supply the answer. Its 23 files include field
notes, accession registers, procedure manuals, a retired 2024 manual with different
values, topic-rich distractors, bilingual vocabulary cards, and two one-page PDF
instrument tables. The complete workspace has 283 indexed chunks. A control
workspace omits the two accession registers and has 21 files / 249 chunks.

There are 48 questions: 16 reference chains, eight direct lookups, four comparisons,
four translated questions, four PDF table questions, four version comparisons,
four missing-register questions, and four questions whose answers are absent.
The 35 development / 13 held-out split was recorded before answering. Every
required source span was verified in the index before the agent runs, including
the PDF rows. Both table PDFs were also visually checked before upload.

The pinned chat model is `deepseek/deepseek-v4-flash-vision-exp`, registry version 1.
Embeddings use `deepinfra/Qwen/Qwen3-Embedding-4B`, version 1. The chunker is v5.
The baseline uses top five results, per-file cap four, lexical weight 0.5 with the
existing short-query exception, and the repeated-result stop hint. Model identities
and source hashes are preserved in the result artifacts.

## Development findings

The initial baseline answered 24 of 30 answerable development questions with the
expected values and every required source link retrieved. Eighteen cited every
required evidence group. Its six failures were `bridge-01`, `bridge-02`,
`bridge-04`, `bridge-07`, `bridge-08`, and `bridge-09`. The other five questions
were negative controls and were inspected separately.

Each failed bridge had already retrieved the correct field observation and its
accession identifier. The agent then stopped early or issued a broad query that
did not find the assignment. For example, `bridge-08` received the correct
`CT-217` observation but answered that no incubation settings applied. The sources
actually link `CT-217` → `AX-948` → 39 °C for 140 minutes. This was a wrong claim
of absence, not just an omitted citation.

Diagnostic searches for the intermediate identifiers found both subsequent source
links at rank one for all six failures: 12 of 12 oracle probes. These probes used
known identifiers to test retrieval availability; they are not counted as agent
successes. They show that the passages were retrievable with focused queries.

The baseline also attempted eight document reads, seven of which were rejected
because the agent supplied a filename instead of an opaque file ID. Search hits
show filenames and text but omit the IDs required by `read_document`; the agent
can obtain those IDs from `list_sources`, but these calls skipped that step.

A selected development screen then compared six answerable questions and two
negative controls per condition. Four positives were previously failed bridges;
the other two were a comparison and a direct lookup. These are exploratory,
selected cases, so their percentages are not estimates of general accuracy.

| Condition | Expected values + all source links, out of 6 | Median turn time, all 8 cases |
| --- | ---: | ---: |
| Baseline rerun | 5 | 8.29 s |
| Lexical weight 1.0 | 3 | 4.92 s |
| Remove repeated-result stop hint | 5 | 8.72 s |
| Return eight search hits | 5 | 10.59 s |
| Follow references explicitly | 6 | 10.77 s |
| Add file IDs and chunk positions | 2 | 5.14 s |
| Follow references + file IDs | 6 | 10.22 s |

The new reference instruction is:

> If a retrieved passage supplies an identifier or refers to another source that can answer the question, follow that reference with a search or document read before deciding the answer is unavailable. A passage lacking the answer does not establish that the workspace lacks it.

The metadata condition appends a mapping from each citation number to its
`file_id` and starting chunk index, using the existing document-read API. The five
reads across the two metadata screens all used valid IDs, but adding IDs alone
did not fix early stopping. No graph, entity extraction, reindexing, larger
result budget, or ranking change is involved in the two selected candidates.

## Held-out comparison

Before running the held-out questions, the two candidates and baseline were frozen
in `holdout-freeze.json`, including script, question, manifest, and index hashes.
Each of the 13 questions runs twice per condition, interleaved in a fixed shuffled
order: 78 turns, with 20 answerable turns and six negative controls per condition.
Every turn uses a new conversation. No condition is tuned using these results.

| Measure | Baseline | Follow references | Follow references + file IDs |
| --- | ---: | ---: | ---: |
| Correct answer + every required source link | 14/20 | 19/20 | 19/20 |
| Specimen → accession → assay questions | 2/8 | 7/8 | 7/8 |
| Other answerable question types | 12/12 | 12/12 | 12/12 |
| Questions correct in both repeats | 6/10 | 9/10 | 9/10 |
| Every required evidence group cited | 11/20 | 17/20 | 16/20 |
| Supported negative-control answers | 3/6 | 4/6 | 4/6 |
| Rejected document reads / attempted reads | 4/4 | 2/5 | 0/2 |
| Mean searches per turn | 2.31 | 3.00 | 2.85 |
| Median elapsed time | 6.52 s | 8.79 s | 8.23 s |
| Mean elapsed time | 8.06 s | 9.24 s | 10.07 s |
| Mean reported tokens per turn | 11,883 | 16,365 | 14,755 |

The combined version repaired five previously failed positive turns without
losing any baseline positive successes. Both candidates still failed once: the
instruction-only version on `bridge-15`, repeat 1, and the combined version on
`bridge-13`, repeat 1. Both were premature claims that no procedure settings were
available. They were not indexing failures.

Negative controls exposed a separate weakness. Every version avoided inventing
the requested numeric settings or correction, but some answers said that no
settings **apply**, instead of saying the supplied documents cannot establish
them. Others invented a restriction on the source inventory, such as claiming
only one procedure was present. These answers do not pass the stricter supported
abstention review. The instruction-only run for `missing-15`, repeat 1, also
ended in literal DSML tool-call markup after 11 tool calls, rather than a finished
answer. Its SSE status was `complete`; it remains an answer failure in the
results, not a discarded infrastructure error.

The combined version is the local implementation because its IDs make document
reads actionable and its answer score matched the instruction-only candidate.
This sample does not establish an accuracy advantage over instruction-only:
the combined version had one fewer fully cited chain and higher mean latency,
despite lower median latency and reported tokens. Compared with baseline, it
used about 24% more reported tokens and took about 26% longer at the median.
Some of that time reflects answering questions that baseline stopped on early.

## Local changes and verification

`pipeline/pipeline/retrieval/agent.py` adds the exact instruction tested above.
`pipeline/pipeline/retrieval/tools.py` adds the tested citation-to-file/position
mapping while preserving paged reads and their next-start markers. The local
prompt and rendered results matched the lab candidate exactly for four locale
inputs and five tool-result shapes. No production deployment was performed.

The new focused test first failed against the old renderer because the location
was absent, then passed after the change. The root offline test command passed
all **69 agent and retrieval helper tests**. Cached Ruff formatting and lint
checks passed; the root formatting wrapper had encountered a package-index TLS
certificate error, so the existing Ruff installation was used directly.

The grading self-check covers incomplete evidence chains, numeric boundaries,
signed values, identifier suffixes, and decimal fidelity. A final grading
refinement preserves decimal points and hyphens; rescoring all **169 formal
turns** changed no recorded score. The original runner is retained as
`run_agent-as-run.py` on the VM, matching the frozen hash. Literal PDF decimal
values were checked directly in the index as well.

[results.json](results.json) contains per-phase and per-category metrics, the
source manifest, model identities, raw-run hashes, and the pre-run freeze record.
[heldout-review.json](heldout-review.json) records the review of every held-out
answer. The two pilot turns and 12 oracle retrieval probes are excluded from
agent scores. All formal streams completed without an API error; that does not
mean all answers were correct.

## What the scores mean

Positive evidence is labelled as required groups of source spans. Every group
must be retrieved, including intermediate assignments, for a complete-evidence
score. Search results and document reads are both captured by assistant message
ID. Merely returning a correct-looking number cannot satisfy the evidence score.

Number/name matching is a diagnostic, not a semantic judge. The held-out review
checks the full answer for correct value associations, comparison direction,
version selection, and unsupported assertions. Negative controls need appropriate
uncertainty, not simply the absence of a numeric answer. This review is performed
by Codex, not by an independent human or a blinded evaluator.

Citation coverage is reported separately: the all-groups metric requires the
final answer to cite every link in the labelled chain. An answer can retrieve all
six comparison passages and still cite only its register and procedure entries.
That is a citation gap even when the two times and the comparison are correct.

## Limits and reproduction

This is a controlled synthetic benchmark. Most documents share prose templates,
and the distractors deliberately challenge the distinction between field
observations and procedures. The held-out questions share that corpus and writing
style; some reuse records through different question types. The two repeats are
not independent samples of a broad student population.

All indexed chunks were detected as English. The translated questions exercise
bilingual aliases leading into an English index, not broad multilingual document
retrieval. The PDF test covers two simple tables, not complex OCR. The lab uses
loopback object storage, disabled development auth/admission limits, and live
providers. Its latency and reported token counts are comparative measurements,
not production latency guarantees or dollar billing measurements.

The experiment does not compare a graph implementation, so it cannot establish
whether a graph would help on other workloads. It tests whether the observed
missing-link failures can be addressed by changes to the existing agent loop.
The next useful validation is a corpus with different writing styles and real
student tasks, followed by focused work on unsupported absence claims and the
agent's final response when its tool budget ends. These results do not justify
adding a graph yet.

[README.md](README.md) documents the corpus, scripts, retained VM artifacts, and
commands for repeating the experiment. Generated source files, full stream events,
and tool evidence remain under `/opt/capy-rag-curated-20260905` on the ingest VM.
