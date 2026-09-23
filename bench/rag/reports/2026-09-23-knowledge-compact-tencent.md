# Compact knowledge search through Tencent curate

Keep the twenty-preview candidate experimental. Four paired full agent turns
produced the same local deliverables with almost identical total input tokens
and wall time. Compact search reduced search calls from 16 to 9 and helped the
binomial example finish sooner, but it did not remove quiz-quality failures.
This sample does not establish a general ranking or efficiency improvement.

A more immediate issue is that the playground accepts quiz payloads the
application rejects. All four newly generated quizzes fail the actual Go
material converter. Local saved-material counts therefore overstate application
completion. No application prompt, tool contract or retrieval default was
changed during this test.

## Protocol

The [runner](../scripts/knowledge_compact_tencent.py) runs four new requests
through the actual curate agent, using Tencent TokenHub `glm-5.3-flash`, high
reasoning and temperature zero. Each pair alternates order. Both arms use a
frozen executable copy of the current runtime and exactly the saved curate
system prompt, which matched the application's English prompt at test start.
Tool descriptions, argument schemas, ledger, material-backed evidence retention,
160 tool-call cap and conditional capture policy remain identical.

| Arm | Excerpts shown | Chunk candidates | Search response |
| --- | ---: | ---: | --- |
| Current | 5 | 40 | Matching hit text and reviewed scope |
| Compact | Up to 20 | 160 | Scope/synopsis previews, followed by selective full reads |

This compares one combined candidate, broader retrieval plus compact display.
It does not isolate the contribution of either change. Each preview remains
whole within a 7,000 estimated-token packing budget. All eight successful
compact searches returned all twenty previews, using 3,488–4,185 estimated
tokens. Missing reviewed scope is explicitly unknown rather than invented.

The source builder was publishing concurrently. An initial unpaired enzyme turn
was discarded from the comparison when its whole-library before/after receipts
changed. The final eight turns use one exported PostgreSQL repeatable-read
snapshot, imported into every read-only transaction. All sixteen before/after
catalog and excerpt-metadata receipts match: 95 books, 47,941 current excerpts,
19,459 with reviewed scope metadata. The reader role is `capy_library_reader`.
Source access is read-only; material writes are local files. Neither arm invoked
page capture. No external dedup or reranker call was made.

## Completed outputs and source fidelity

| Request | Current | Compact |
| --- | --- | --- |
| Enzyme inhibition, broad note and six challenging single-answer questions | Note and quiz saved locally. Core source evidence found. Five explanations misnumber options, including explicitly rejecting the correct choice. | Note and quiz saved locally. Q1 describes both inhibitor types in the same experiment, but its answers compare separate experiments. |
| Exponential/logistic population growth, note and four application questions | Note and quiz saved locally. Source examples and intended answers agree in the manual check. | Note and quiz saved locally. Intended answers agree with their explanations and source concepts in the manual check. |
| Binomial model, original numerical example worked by hand | Note preserves Example 4.30's n=8, p=0.7, k=5, coefficient 56 and probability about 0.254. Four searches and four reads. | Same original givens and calculation preserved. Two searches and two reads. |
| `scipy.odr`, including `fjacb` and `fjacd` APIs | No invented guide or generic substitute. Searches found adjacent regression material, but final wording overstates exhaustive library absence. | Same appropriate decision not to fabricate a guide, with the same overconfident global absence wording. |

These are manual comparisons against the text actually delivered to the model,
not blinded independent ratings or proof that every sentence is flawless. The
binomial sources themselves simplify independence to random sampling in the
worked example. Both outputs inherit that wording; it is not a newly invented
source claim. The current note also includes an extra finite-population rule
outside its four full-read excerpts, so preserving the requested calculation
does not imply complete claim-by-claim provenance.

The enzyme source presents a simplified allosteric/noncompetitive account.
The current quiz's wrong option references are not in that source. For example,
Q3's correct fourth option describes a noncompetitive inhibitor, while its
explanation calls choice 4 an allosteric activator. Q2, Q4, Q5 and Q6 have
similar key/explanation inconsistencies. The compact Q1 problem is a generated
experimental setup mismatch, not evidence that the source lacked the mechanism.

Both API-gap replies say no library source covers the APIs. A handful of ranked
searches supports “I did not find coverage,” not an exhaustive catalog claim.
They correctly avoid writing unsupported API instructions; retain that behavior
while making the absence statement more precise.

Both enzyme arms initially use the subject ID `general-biology` as a topic
filter and recover from the refusal. Current SciPy also tries the subject ID
`programming` as a topic. Both ecology arms attempt a write with unread excerpt
IDs, then recover by reading the missing excerpts. These are tool-use errors
with successful local recovery, not unrecoverable retrieval failures.

## Material contract failure

The four enzyme/ecology quizzes contain arbitrary objects using `question`,
string options and `answer`, sometimes with `type: multiple_choice`. The
playground stores them as successful quizzes. The application calls
`server/internal/materialdoc.QuizDocument`, which expects the defined quiz
shape including `id`, `type`, `level`, `prompt`, option objects and `correct`.

Running that actual converter against all four original payloads returns
`invalid material document: questions[0]: id is required`. No conversion,
repair or field inference was performed before validation. The exposed
`create_material.questions` schema allows arbitrary objects and only refers to
the quiz generator shape, leaving the model without the complete contract.

The smallest proposed follow-up is to expose the actual question contract and
make the local writer enforce the same acceptance rules. This is an application
and benchmark correctness issue. No fix was folded into these experiments.

## Full-turn costs

Input counts include cached input. Cache-read counts are a subset, not additional
tokens. Seconds include the loop, tools and source reads.

| Request | Arm | Input | Output | Cache read | Seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Enzyme | Current | 82,093 | 4,726 | 22,528 | 213.37 |
| Enzyme | Compact | 76,926 | 5,559 | 16,768 | 328.37 |
| Ecology | Current | 110,526 | 5,427 | 44,992 | 179.72 |
| Ecology | Compact | 150,034 | 5,136 | 44,480 | 169.09 |
| Binomial | Current | 87,190 | 4,249 | 33,280 | 158.32 |
| Binomial | Compact | 71,906 | 1,917 | 33,984 | 92.42 |
| API gap | Current | 72,818 | 1,627 | 33,856 | 105.12 |
| API gap | Compact | 53,643 | 1,274 | 22,016 | 75.56 |
| **Total** | **Current** | **352,627** | **16,029** | **134,656** | **656.53** |
| **Total** | **Compact** | **352,509** | **13,886** | **117,248** | **665.44** |

Each arm saved three notes and two quizzes locally. Neither arm's two quizzes
passed application validation. Current used 16 searches and 14 full reads;
compact used 9 searches and 11 full reads. Refused calls fell from four to two.
No provider error or empty final answer occurred. Cache conditions differ and
each case ran once per arm, so the timing differences are descriptive only.

## Next actions

1. Align the quiz contract and local acceptance checks before counting saved
   quizzes as successful application output.
2. Tune answer/key/explanation consistency, experimental setup and scoped
   absence wording using the imported [playground cases](2026-09-23-playground-retrieval-cases.md).
   Keep prompts under the developer's control.
3. Recheck any chosen prompt on unseen requests. Compact discovery remains a
   separate candidate; it saved recovery steps here without an aggregate token
   reduction or a clean material-quality win.
4. Leave rerankers and global deduplication deferred. No failure here establishes
   that either would fix the generated quiz mistakes.

## Reproduction and artifacts

```sh
.venv/bin/python bench/rag/scripts/knowledge_compact_tencent.py --check
.venv/bin/python bench/rag/scripts/knowledge_compact_tencent.py --output bench/rag/reports/local/<fresh-directory>
```

The completed run is under the ignored
`bench/rag/reports/local/2026-09-23-knowledge-compact-tencent-snapshot/`:
`protocol.json`, frozen runtime, config, source receipts, full provider request
bodies/responses without credential headers, search results, previews, complete
`run.json` histories and local material files. `summary.json` has all eight
turns. `application-quiz-validation.txt` records converter results, and
`application-quiz-validation.go.txt` preserves the small offline validator.
The earlier unpaired trial remains separately under
`2026-09-23-knowledge-compact-tencent/` and is excluded above.

Offline schedule and whole-preview packing checks, Python compilation and
targeted Ruff checks passed. All final source receipts, prompt hashes and tool
schema hashes match across the eight turns. The snapshot keeper closed after
the final turn. Descriptive history copies preserve original answers, prompts,
events and materials without edits.
