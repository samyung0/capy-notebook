# Compact knowledge discovery and prompt-steered finishing

This tests the developer's combined curate proposal through actual Ollama
GLM-5.3-Flash low-reasoning turns: compact search previews, no page-capture tool,
and prompt guidance to finish from sufficient evidence within the existing
ledger budget. All 20 turns completed. The package saved eight notes versus
seven, used 11.1% fewer reported input tokens, and reduced refused writes from
seven to one. It is a promising experimental configuration, but neither arm
reliably respects evidence gaps and the harder request still stalls sometimes.

The interactive playground was also started separately at
`http://127.0.0.1:18765`, with the current `curate` preset and Tencent TokenHub
GLM. Its successful setup turn is `20260921-212634-4a04d6`. It is excluded from
this Ollama comparison; the compact package remains benchmark-only.

## Comparison

| Setting | Current | Candidate |
| --- | --- | --- |
| Search results | Up to 5 excerpts, metadata plus hit text | Up to 20 excerpt previews, no hit text |
| Raw chunk candidate budget | 40 | 160, before folding hits into distinct excerpts |
| Compact metadata | Existing summary/scope alongside source text | Existing summary/scope; full synopsis stays in the read tool |
| Missing compact metadata | Explicit unreviewed scope plus hit text | Explicit unreviewed scope plus a 120-estimated-token preview of the stored synopsis |
| Search output budget | Existing 8,192-token ceiling | Whole previews packed within 7,000 estimated tokens, under the same ceiling |
| Source-page capture | Current tool and instruction | Tool removed; reviewed text supplies evidence, missing visual facts stay explicit gaps |
| Finish behavior | Current prompt | Search, batch selected reads, write; further search only for a concrete unmet requirement |
| Ledger/stall mechanics | Current | Identical |
| Material writes | Local playground writer with normal provenance/read guards | Identical |

Both arms retain full `read_knowledge`, subject/topic browsing, source scope and
the requirement to read an excerpt before writing from it. The candidate tells
the model to create deliverable todos rather than research todos, complete reads
before writing, and avoid unsupported details when the budget is nearly spent.
There is no extra finish call, increased stall allowance, reranker, generated
summary, new chunking, continuation cache or deduplication stage. No application
runtime or default is changed.

This is a combined-package test. Differences cannot be attributed separately to
result count, candidate pool, formatting, capture removal or prompt guidance.
The previous five-versus-ten experiment is historical context, not this run's
control: shared runtime code has changed since then.

## Results

| Across ten request instances per arm | Current | Compact package |
| --- | ---: | ---: |
| Notes saved | 7 | 8 |
| Expected quantum-coverage gap, no note | 1 | 1 |
| Empty stalls | 2 | 1 |
| Reported input tokens, all model calls | 517,755 | 460,539 |
| Median input tokens per turn | 47,291 | 42,514 |
| Model calls | 58 | 49 |
| Total turn time | 549.27 s | 469.06 s |
| Median turn time | 50.93 s | 38.45 s |
| Searches / full excerpt reads | 15 / 29 | 14 / 27 |
| Page captures | 5 | 0 |
| Refused material writes | 7 | 1 |
| Truncated tool results | 0 | 0 |

These are completion and cost measurements, not accuracy rates. Athens produced
unsupported material in both arms. Times include variable provider/network
latency and this small diagnostic set is not a population estimate.

All 14 compact searches showed 20 whole previews, using 3,636–4,483 estimated
tokens. The existing 8,192-token tool limit did not need to increase. Median
search output was actually larger than current search, 3,942 versus 2,606
estimated tokens, because it exposed four times as many excerpts. The full-turn
saving came with fewer model calls and less total read output: 23,098 versus
33,761 estimated tokens. Search counts barely changed. This does not establish
that exposing more previews alone makes the agent stop exploring.

The frozen library had 92 books, 47,717 excerpts and 3,728 excerpts with compact
reviewed scope metadata. Of the 280 shown candidate cards, 138 lacked that
metadata and used the explicitly marked synopsis preview. Missing scope metadata
does not by itself establish that the book's source review was incomplete.

| Request | Current | Compact package | Source/output review |
| --- | --- | --- | --- |
| Two regression datasets, two attempts | 0/2 notes | 1/2 notes | Successful repeat uses Elmhurst financial aid and the separate parenthood sleep/grumpiness dataset, with the right variable names and fitted coefficients. |
| Regression by hand | Note | Note | Current gives a clearly labelled newly composed five-point calculation; compact follows the source's Elmhurst summary-statistics derivation. Both core calculations work. Compact additionally asserts an n=50 fact not present in its reads. |
| Paired t-test, two attempts | 2/2 notes | 2/2 notes | Current correctly preserves the Chico table's means and SD associations. Compact uses the SAT improvement test once and Chico once; the reported statistics match the reads. No swapped SDs in these four turns. |
| Regression in R | Note | Note | Both use the actual R `lm()` example and its 125.956 / -8.937 coefficients. Compact follows all three linked fitting/interpretation excerpts. Wording still needs care: current says R-squared is always positive; compact repeats causal-sounding sleep wording. |
| Mean versus median | Note | Note | Both preserve the income example and its arithmetic. |
| General leadership | Note | Note | Both disclose their educational/organizational sources. Current still generalizes some school-leadership findings. Compact invents a substantive leadership/management distinction from an excerpt that only introduces regional terminology and competing definitions. |
| Ancient Athens | Note with unsupported details | Note with unsupported details | Both add Athenian assemblies and citizenship exclusions unsupported by the passages read. Current also adds selection by lot and jury/council participation. A coverage disclaimer does not correct those assertions. |
| Quantum surface codes | Explains coverage gap | Explains coverage gap | Neither substitutes classical coding material for the requested quantum subject. Their searches support reporting a retrieval gap, not claiming an exhaustive audit of the entire library. |

### What remains broken

All three empty two-dataset turns reach the unchanged stall guard. On each last
provider call, the tool schema estimate is 1, representing the removed tool
list, yet Ollama returns a `create_material` tool call. The agent does not execute
that out-of-phase call and produces an empty final response. The
[workspace experiment](2026-09-21-workspace-opening-agentic.md) independently
found the same finalization pattern. A final model call already exists; merely
adding another one is not an evidence-backed fix.

The successful compact repeat writes after selecting and reading the jamovi
parenthood example. Its first attempt instead follows the business-statistics
exam example and searches again for a missing equation. The reviewed scope on
`exc_64ed84430ae3b2_261_v2` points to `262`, but that read contains prediction-range
cautions, not the equation. A context link is only useful if the linked passage
actually supplies the claimed context. The alternative parenthood example was
already in the search results. Global duplicate grouping is not needed to
explain this failure.

For Athens, the actual reads are general democratic theory with U.S. examples,
the Roman republic, and, in compact, Plato's critique. The metadata identifies
those scopes. Neither arm has evidence for the Athenian institutional assertions
it adds. This is a generation/scope failure even after wider discovery, rather
than evidence that every source needs another page capture.

## Next moves

1. Keep compact discovery/full reads as the next experimental configuration.
   The twenty-preview response fits the existing limit, and this combined
   package reduces total context and invalid early writes. Validate it on new
   requests before making it a default; this run cannot isolate the effects of
   the prompt, capture removal, result count and candidate count.
2. Test explicit final-answer steering and the provider's no-tool contract at
   the existing terminal call. Retain deliverable-only todos and early writes.
   Check both the configured Ollama route and the interactive Tencent route;
   this experiment alone does not prove both behave identically at termination.
3. Target the Athens/leadership gap behavior and factual details in generated
   notes. A bounded comparison against the passages already read is a smaller
   next test than making the agent re-open every PDF. Keep a missing visual fact
   explicit when text cannot support it.
4. Feed the demonstrated broken context link/incomplete excerpt back to source
   review. Preserve dataset identity and question/givens/solution continuity.
   Defer global deduplication, new chunking, per-book result caps and rerankers
   until they address a measured final-material failure.

## Cases and review

Eight existing natural requests are paired: two regression datasets, regression
by hand, paired t-test, regression in R, mean/median, quantum surface codes,
general leadership and Athenian democracy. Two prespecified repeated pairs cover
the two-dataset and paired-test requests. Arm order alternates. This gives 20
turns and ten request instances per arm. These are inspected diagnostic cases,
not a held-out estimate across the whole library.

Judge the saved materials and final responses against the actual source text
read: requested method, software, scope, dataset diversity, numerical/table
fidelity, unsupported additions and useful completion. An honest request-level
coverage gap is valid where the library lacks the needed evidence. An empty
stall is not. Lack of page capture is not itself a quality failure in this test.

Record full-turn reported tokens and time, search/read calls, rejected writes,
stalls, source provenance, actual preview counts and truncation. A compact search
that still triggers many unnecessary reads has not demonstrated a full-turn
context saving.

## Isolation and receipts

The [runner](../scripts/knowledge_compact_agent.py) copies the current Python
runtime, generated prompt/tool assets, playground and benchmark inputs into the
new ignored output directory. It checks hashes before and after copying and
every child turn imports that copy. This keeps concurrent application edits
from changing one arm midway through the comparison. No environment file or
credential is copied. Credentials stay in process memory.

Library queries use `capy_library_reader` with read-only transactions; every
before/after receipt verifies that identity. Book versions, content IDs and
excerpt hashes are recorded around every turn. Source-B2 access for the current
arm uses the previously authorized local CLI account and is read-only. The
candidate offers neither capture tool. Materials and traces stay local.

```sh
.venv/bin/python bench/rag/scripts/knowledge_compact_agent.py --check
.venv/bin/python bench/rag/scripts/knowledge_compact_agent.py --suite \
  --output bench/rag/reports/local/2026-09-21-knowledge-compact-finish
```

Use a fresh output directory. `protocol.json` freezes all 20 turns and runtime
hashes. The `current|compact/repeat-N/<case>/baseline/` directories contain full
agent traces, exact prompts, source reads, materials, candidate rows and source
receipts. `baseline` is the inherited experiment's production-tool execution
path; the outer directory identifies the actual arm. Candidate `previews.json`
records the ranked count and IDs actually shown. The retained legacy
`retrieval.json` pool fields are unused; `candidates.json`, configuration and the
protocol record the real 40/160 budgets. No reranking branch executes.

The schedule, preview omission, missing-scope preview and prompt self-checks
passed, as did direct Ruff lint/format checks before freezing. After the suite,
all 132 copied input hashes still matched. All 40 source receipts were identical,
including across paired arms. Every saved excerpt ID had a successful full read
and appeared in the saved provenance. These structural checks do not establish
that every generated claim is supported. The local `summary.json` contains the
per-turn measures and checks behind the tables above.
