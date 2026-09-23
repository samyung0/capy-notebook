# Workspace retrieval through the agent loop

This experiment compares the existing five-passage workspace search with the
previously proposed lexical-protected abstention rule. Final source support,
citations and the agent's recovery steps are the primary outcomes. Retrieval
ranks are diagnostics. No reranker or production change is included.

Keep the current five-passage search. Do not promote the proposed abstention
rule on this evidence. Across the 15 paired requests, the current loop answered
all eight available-source questions; the candidate answered seven and exhausted
the planning budget on the author-name question. Both handled all five normal
unsupported requests. The author repeat exposed a current-loop false refusal
too, so this is a real weakness, not a claim that the baseline is reliable.

The next workspace experiment should target the author/affiliation lookup and
its recovery path. The source contains the answer, but name tokens have attached
affiliation numerals. Repairing or bypassing that specific failure is a better
lead than suppressing weak search results or raising the default passage count.
These are lab findings; no application code, configuration or default changed.

## Agent-loop results

The primary comparison contains 30 complete turns. Four prespecified repeat
turns are reported separately. All costs include the full loop and format repair.

| Primary outcome | Current k=5 | Abstention candidate |
| --- | ---: | ---: |
| Required answer claims supported, available sources | 8/8 | 7/8 |
| Supported answer with all cited claim groups supported | 8/8 | 6/8 |
| Appropriate nonanswer, normal unsupported requests | 5/5 | 5/5 |
| Explicit unnecessary refusals, answerable requests | 0/8 | 0/8 |
| Empty final answer at planning cap | 0/8 | 1/8 |
| Missing-source controls: no target facts invented | 2/2 | 2/2 |
| Missing-source controls: availability problem explained | 1/2 | 1/2 |
| Supported citation objects, all primary requests | 26/27 | 17/19 |

The candidate's empty answer is counted as failure, not as a successful refusal.
Source availability is a separate category: neither arm can answer the two
requests whose files have no searchable passages. Both avoid invented target
facts, but both incorrectly imply the Mandarin policy is absent rather than
explaining its failed index.

Citation review checks the claim against the cited excerpt or original page,
including a full page seen through capture. It does not award credit merely
because the filename matches. It also does not score highlight-box geometry.
For example, both ResNet answers use the correct captured table page even though
the chosen text anchors highlight nearby prose. A true incidental citation does
not rescue a wrong answer. Judgments are manual and were not independently
blinded or double-rated.

| Request | Current result | Candidate result | Evidence/recovery |
| --- | --- | --- | --- |
| 001: normal distribution | Supported | Supported | 68% within one standard deviation; candidate also captures p.2. |
| 006: harbour vote | Source unavailable | Source unavailable | Neither invents a decision. Candidate tries a read and capture; capture is denied without a seen passage. |
| 014: MarIA, Spanish cross-source | Supported | Supported | BSC/CNS, 2021; candidate's extra model names are visible on captured p.9. |
| 018: CamemBERT/WikiNER | Supported | Supported answer, two wrong citations | April 2019 and 3.5 million tokens are correct. Candidate also attaches unrelated CamemBERT method passages. |
| 025: Mandarin policy targets | Source unavailable | Source unavailable | Neither invents dates; neither explains `zh_HK.pdf` failed indexing. |
| 028: Chinese question, English fire table | Supported | Supported | Both capture p.13 and identify Homo erectus. |
| 034: CLFCG | Supported | Supported | Native-language feedback; English learner output paired with Chinese comments. |
| 055: RLHF diagram | Supported | Supported | Both use reads/captures to distinguish written demonstrations from ranking generated responses. |
| 061: Hong Kong 2025 rate | Correct nonanswer | Correct nonanswer | Does not relabel the 2023 rate as 2025. |
| 063: Qwen3.8 Flash in Calor Table 1 | Correct nonanswer | Correct nonanswer | Both recover the actual table with a second search; the named model is not listed. |
| 064: ResNet run-to-run SD | Correct nonanswer | Correct nonanswer | Both capture Table 2 and distinguish a 25.03% error rate from an unreported SD. |
| Mayor-Rocher/Reviriego | Supported | Empty, planning cap | Current: four searches, one read, one capture. Candidate: four suppressed searches and two reads in the wrong paper. |
| DFKI, English over German | Supported | Supported | Lexical exception preserves the acronym lookup despite vector distance 0.619. |
| Sourdough | Correct nonanswer | Correct nonanswer | Both list sources without searching; candidate is never exercised. |
| French Revolution | Correct nonanswer | Correct nonanswer | Both list sources without searching; French NLP papers are not mis-cited as history. |

Request numbers refer to `odl-agentic-*` fixture IDs. The baseline's sourdough
answer additionally gives a brief recipe explicitly labeled as outside-source
knowledge; the frozen rubric permits that. The baseline harbour answer has one
irrelevant citation to a thesis title page. The candidate CamemBERT/WikiNER
answer has correct supporting citations too, but its two extra method citations
are wrong. These citation defects occurred without an abstention in the
CamemBERT case and should not be interpreted as a causal threshold effect.

| Full-turn cost, 15 requests per arm | Current k=5 | Candidate |
| --- | ---: | ---: |
| Input tokens, total / median | 222,802 / 10,673 | 219,064 / 11,873 |
| Output tokens, total | 5,092 | 4,583 |
| Input + output tokens, total / median | 227,894 / 10,845 | 223,647 / 12,050 |
| Query embedding tokens | 750 | 681 |
| Wall time, total / median | 237.6 s / 13.4 s | 255.1 s / 13.7 s |
| Model calls | 53 | 57 |
| Search calls / searches after the first per request | 20 / 7 | 18 / 5 |
| Document reads / source listings | 3 / 4 | 4 / 5 |
| Page-capture calls | 6 | 11 |
| Suppressed searches | 0 | 6 |

One candidate capture is denied on the unindexed scan; the remaining ten
succeed. The candidate saves 1.9% total model tokens while taking 7.4% more wall
time and failing one available answer. These totals are descriptive, not a cost
claim: the model chooses different queries and tools even at temperature zero,
the cloud transport varies, and the small set has no statistical power. Both
arms execute the diagnostic all-term SQL check, so its production overhead is
not measured here. Reported reasoning-token usage is zero; low reasoning was
requested explicitly.

### Prespecified repeats

| Repeated request and arm | Result | Searches / reads / captures | Input + output tokens | Wall time |
| --- | --- | --- | ---: | ---: |
| Mayor, current | False absence refusal | 3 / 0 / 0 | 22,084 | 53.0 s |
| Mayor, candidate | Empty, planning cap | 4 / 2 / 0 | 34,045 | 33.8 s |
| Sourdough, current | Correct nonanswer after listing | 0 / 0 / 0 | 6,188 | 6.0 s |
| Sourdough, candidate | Correct nonanswer after listing | 0 / 0 / 0 | 9,924 | 7.0 s |

Across the two scored author trials, current search recovers once and falsely
refuses once; the candidate finishes neither. Both sourdough repeats again
bypass search. An earlier preflight happened to favor the candidate on the
author request; it is excluded completely, along with every other preflight.
The fresh frozen results replace that anecdote.

## What the loop changes

The initial author query finds no supporting first-page passage in the 40-row
pool. Searching `Reviriego` later puts the two first-page chunks at ranks 22
and 34 in the baseline repeat. Current search's successful primary turn instead
changes to a title/affiliation query, reads the opening chunks and captures the
page. This is useful compensation, but the repeat shows it is unreliable.
The candidate suppresses all four searches in each author trial and spends its
reads on another Spanish paper before reaching the planning limit.

The two names occur in the first two chunks' heading breadcrumbs and
`indexed_text`, with `Mayor-Rocher1` and `Reviriego2`; they are absent from the
body text. The all-term name lookups have zero hits. That is a concrete
tokenization/extraction lead. A next bounded experiment should isolate that
identifier failure and compare a small normalization or document-opening
recovery candidate against current behavior, with these same lexical and
cross-language controls. It must measure false absence claims and total reads,
not just whether the source appears in a candidate pool.

Other cases show why isolated retrieval scores are insufficient. The fire
question becomes an effective Chinese search and the agent verifies the English
table. Both Calor runs initially retrieve related discussion, then obtain the
right table through another search and correctly decline the nonexistent row.
The off-topic requests never search at all. An empty-search policy cannot take
credit for those successful nonanswers.

No remaining final-answer failure was shown to depend on answer-bearing
passages at ranks 6–10. A dynamic-k arm was therefore not justified in this
bounded experiment. Keep it as a later hypothesis, not a default change.
Rerankers and global deduplication were not tested.

## Corpus correction

The read-only inspection of `odl_eval_odl_nocaption` found 29 file rows,
2,217 searchable chunks across 27 files, and no study materials. Its embedding
pin is DeepInfra `Qwen/Qwen3-Embedding-4B`, version 1, 2,560 dimensions.
Every original-source hash in the local 29-source manifest matches the database
file hash. Every local coordinate PDF matches its recorded hash.

| Source | File state | Current content state | Chunks | Implication |
| --- | --- | --- | ---: | --- |
| `zh_HK.pdf` | failed, unindexed | no content pointer | 0 | Earlier summary generation failed and the incomplete index was cleaned up. |
| `newspaper_scan.pdf` | ready, indexed | processing | 0 | No indexed text passages; the source is unreachable through passage-gated capture. |

Fifteen of the 274 legacy positive questions depend exclusively on these two
sources. They are source-availability failures, not ranking failures or successful
rejections of answerable content. The earlier 22 expected-file misses in the
40-candidate pool therefore contain seven remaining cases that need ranking,
extraction or label inspection. The original chunk indices remain stale.

The benchmark keeps two missing-source requests as separate controls. It does
not silently change them into normal unanswerable questions. The remaining
positive labels use source claims and pages, with equivalent evidence elsewhere
in the permitted documents accepted. Page overlap alone earns no answer credit.

## Frozen comparison

The [fixture](../fixtures/workspace-agentic-cases.json) freezes 15 requests before
the scored run: eight answerable, five unsupported, and two with unavailable
sources. It reuses eleven existing ODL questions and adds the author-name
failure, DFKI, and two source-bound off-topic requests. Controls cover a Chinese
question over an English table, an English question over a German paper,
French and Spanish comparisons, an RLHF diagram, and three scoped near-misses
whose terms occur in the source but whose requested answer does not.

These are previously inspected diagnostic sources, not an independent holdout.
The original ODL split labels are retained only as provenance. Threshold 0.6
was fixed from the earlier proposal, not selected on these results.

Both arms run the production chat loop through the existing playground with
Ollama `glm-5.3-flash:cloud`, low reasoning, temperature zero, the same current
chat prompt and tool schemas, and the ordinary 8/2/16 planning, per-response and
per-turn limits. Search returns five passages with the soft four-per-file cap
from 40 fused candidates. The 8,192-token tool-output cap remains active.
The offered tools are search, source listing, document descriptions, document
reads and page capture. The agent sees no labels or expected sources.

The candidate returns no passages when the closest vector distance exceeds
0.6, there is no all-term lexical match in the same allowed file scope, and no
exact-tier candidate exists. Its empty-result message describes the current
search and explicitly permits following a concrete source or identifier. It
does not claim that the whole workspace lacks the answer. This differs from
the earlier experiment's stronger instruction to stop rewording.

Pair order alternates by case. All turns run sequentially within this task.
One extra pair each for the author-name and sourdough requests was prespecified.
Reported costs include the complete turn, including further searches, reads,
captures and answer-format repair.

The lab schema predates the note-index table. The
[runner](../scripts/workspace_agentic_retrieval.py) therefore uses a verified
snapshot of its file listing, summaries and chunks for read tools, while
production hybrid SQL reads candidates through an explicit read-only connection.
Production scope validation, passage rendering and the repeat-overlap footer
remain active. The lexical exception uses the same selected files. Notes are
untested because this corpus has none. Citation refinement and capture read the
hash-verified local PDFs. No schema patch or database write is made.

## Receipts and validation

Raw artifacts are under ignored
`bench/rag/reports/local/2026-09-21-workspace-agentic/`:

- `snapshot.json` and `audit.json` record source identities, content states,
  repaired page anchors and the 15 invalid legacy positives.
- `freeze.json` records hashes of the cases, runner, snapshot and runtime code.
- `runs/repeat-*/<case>/<arm>/` holds provider/tool traces, exact prompts,
  answers, citations, captures, candidate rows and timings.
- `source-pages/` holds visual checks of the author page, fire table, RLHF
  diagram and the three near-miss sources.
- `assessment.json` records per-turn source/citation judgments and hashes of
  the scored traces; `summary.json` aggregates outcomes and full-turn costs.
- `postrun-verification.json` confirms files, chunks, summaries, content states,
  pin, chapters, material count and runtime inputs still match the freeze.
- `lab-cleanup.json` confirms `capy-odl-agentic-db` was returned to its initial
  stopped state, with exit code zero. No shared service was restarted.

The first preflight exposed a capture-helper output-path assumption. All
preflight runs were archived and excluded. The runner now sets both playground
output roots to this benchmark's directory; policy, cases and model settings
are unchanged. `protocol-amendment.json` records the correction.

```sh
.venv/bin/python bench/rag/scripts/workspace_agentic_retrieval.py audit
.venv/bin/python bench/rag/scripts/workspace_agentic_retrieval.py check
.venv/bin/python bench/rag/scripts/workspace_agentic_retrieval.py run
.venv/bin/python bench/rag/scripts/workspace_agentic_retrieval.py run \
  --only workspace-lex-mayor,workspace-offtopic-sourdough --repeat 1
```

The run requires the saved snapshot, verified local source corpus, existing
ingest-host SSH key, the isolated frozen lab database, the UAT embedding key
read into process memory, and configured local Ollama. The runner refuses an
input/runtime hash change instead of silently combining incompatible arms.
Targeted Ruff format/check and the abstention boundary/lexical-exception check
passed. Shared application files were left alone.
