# Benchmarks

Every performance, capacity, and model-quality measurement in the repository.
Only the editor suite runs in CI; the rest are manual, and most need a VM or a
downloaded model runtime.

Each family uses the same three buckets:

| Bucket      | Holds                                                              |
| ----------- | ------------------------------------------------------------------ |
| `scripts/`  | Runnable code — runners, builders, analysers, Dockerfiles           |
| `fixtures/` | Seed and input data the scripts read                                |
| `reports/`  | Findings, plans, raw run records. Never executed                    |

Reports are named `YYYY-MM-DD-<topic>.md` by the date of the run they describe.
Raw run artifacts sit in a sibling `YYYY-MM-DD-<machine>/` directory.

## Families

| Family                     | Measures                                                                                        | Run with                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [`editor/`](editor/)       | Plate editor open cost, typing latency, save cycle, scroll FPS under CPU throttle                | `pnpm bench:editor`                         |
| [`parsers/`](parsers/)     | Ingest-host parser accuracy and capacity: OCR modes, concurrency, worker memory, OOM behavior    | `python bench/parsers/scripts/…` (needs VM) |
| [`grading/`](grading/)     | Small local models against the production quiz-grading rubric, native and in-browser             | `python bench/grading/scripts/benchmark.py` |
| [`rag/`](rag/scripts/)     | Retrieval and chat-agent quality: live diagnostic plus four frozen experiments                   | see below                                   |

### editor

The only CI-wired suite, run manually via the `Editor perf` workflow and on
production promotion. Budgets are regression tripwires, not UX targets; snapshot
deltas stay warn-only. Details: [editor-perf.md](../openwiki/editor-perf.md).
Results land in the gitignored `editor/.results/`, so this family has no
committed reports.

### parsers

Needs the dedicated ingest host. `scripts/accuracy_report.py` decides OCR mode
by rendering pages with bounding boxes for side-by-side review; the `bench_*`
and `run_*` scripts measure throughput, mixed lanes, and worker memory ceilings.
`fixtures/docs/` is tracked, so the load benchmarks run from a clean clone;
its files are generated stand-ins or public documents, and anything added there
must be safe to commit. Local output goes to `reports/local/`, gitignored.

Decision records: [parser accuracy](parsers/reports/2026-08-28-parser-accuracy.md),
[worker stress](parsers/reports/2026-08-31-worker-stress.md).

### grading

14,000 grading cases across 8 domains and 7 language groups, scored against the
production prompt in `pipeline/pipeline/retrieve/quiz_grade.py`. AI-authored and
AI-reviewed labels, not human-certified — read
[the README](grading/README.md) on provenance before citing a number. Model
files and run artifacts live in the gitignored `data/grading-benchmark/`.
`scripts/typesafe_math.py` is a separate hosted-judge probe: typesafe.ai jev on
math step checking, final-answer and unit equivalence, algebraic form, and per-rubric
grading across subjects (essays plus the English seeds) and routing of
computational questions, findings in
[2026-09-19-typesafe-jev-judge.md](grading/reports/2026-09-19-typesafe-jev-judge.md).

### rag

[`rich_chat_validity.py`](rag/scripts/rich_chat_validity.py) samples the current
rich-chat prompt with frozen synthetic evidence through Tencent GLM and official
DeepSeek, with GLM at Low and DeepSeek at High. It uses the production request builders, no retries, and no repair
requests. Run `uv run python bench/rag/scripts/rich_chat_validity.py
bench/rag/reports/local/<fresh-directory> --repeats 2`; credentials are read in
memory from the UAT worker. Re-score saved output without network access by
replacing `--repeats 2` with `--score`. The sibling TypeScript scorer uses the
official parser and local recovery checks. Add `--model deepseek` or `--model glm`
to limit the live sample to one provider. These are format samples, not
production failure-rate measurements or retrieval-quality tests.

`rag/scripts/rag_eval.py` is a live retrieval diagnostic that
runs the production `search()` against a real workspace inside the pipeline
image. Its question sets in `rag/fixtures/` are keyed to `CHUNKER_VERSION` and to
a corpus that is **not tracked in Git**: 16 real documents across six languages at
`/opt/capy-rag-lab/samples` on the ingest host. That corpus was gathered ad hoc
and has no fetch script.
[`rag/fixtures/samples-manifest.json`](rag/fixtures/samples-manifest.json)
records its checksums and which question set uses each file.

The September 9 ODL agentic evaluation has a verified local inspection copy at
[`rag/fixtures/local/2026-09-09-odl-agentic/README.md`](rag/fixtures/local/2026-09-09-odl-agentic/README.md).
It includes all 29 evaluation PDFs, the two original PowerPoint files, and an
index mapping documents to questions. This covers the 16 legacy originals as
well as the additional parser sources. The binary files are gitignored and are
not included in a clean clone; preserve the VM corpus or this local copy.

The `expect` labels are `(file, chunk_idx)` pairs, so a `CHUNKER_VERSION` bump
moves every index. That is expected and cheap to absorb: the labels were written
by an LLM asked to prepare the dataset, and re-labelling after a re-chunk is the
same job run again. Re-chunk and re-embed first, then have a model redo the
labels against the new chunks — do not try to migrate old indices forward.

Nothing else about the old runs needs preserving. Their numbers, methodology and
source-check verdicts live in each experiment's `reports/`, and any new
comparison has to re-run both arms under current code anyway, or the delta is
confounded by everything that changed in between.

```sh
docker compose exec retrieval python bench/rag/scripts/rag_eval.py <workspace_id>
```

[`provider_latency.py`](rag/scripts/provider_latency.py) interleaves DeepInfra
and Alibaba embedding and rerank calls from the local machine, with no retries,
and splits each request into connect, first-byte wait and body time. Findings,
including why local builder runs time out, are in the
[September 25 report](rag/reports/2026-09-25-provider-latency.md). The same day's
embedding ([`qwen37/`](rag/qwen37/)) and reranker ([`rerank/`](rag/rerank/))
comparisons over the knowledge library have their own directories.

[`knowledge_scope_agent_eval.py`](rag/scripts/knowledge_scope_agent_eval.py)
compares current knowledge-library search, cached continuation pages and
request-scope reranking through the real curate loop. It uses local Ollama,
the read-only live library and locally saved materials. `--thinking low|high`
selects the agent and optional reranker effort (default: low). The
[September 20 report](rag/reports/2026-09-20-knowledge-scope-agent.md) documents
the cases, costs, harness limitations and reproduction commands.
The [September 21 follow-up](rag/reports/2026-09-21-knowledge-scope-implementation.md)
records the Sol source-review trial, targeted metadata backfill and the updated
retrieval workflow's agent results.
The [Sol topic-owner trial](rag/reports/2026-09-21-sol-topic-owner.md) tests keeping
topic proposals and final tagging with the source-review agent, without a GLM
handoff in the delegated builder workflow.
The [Qwen book review sample pack](rag/fixtures/knowledge-review-v2/README.md)
contains seven synthetic cases, a real candidate sample and a repaired control, all text-only, with
separate expected findings and an explicit dry-run/send helper. It reviews
roles, notes, scope, topics and context links; it has no material or page review.
The [Sol workflow trial](rag/scripts/sol_workflow_trial.py) prepares isolated
catalog-holdout and split-book assignments with frozen prompts and examples,
then audits returned artifacts. Its [example-guided rerun report](rag/reports/2026-09-21-sol-workflow-examples.md)
separates structural validation from source and annotation quality. The
[deduplication research note](rag/reports/2026-09-21-knowledge-duplicate-strategy.md)
separates duplicate discovery from result grouping and recommends a bounded test.
The [retrieval improvement directions](rag/reports/2026-09-21-retrieval-improvement-directions.md)
assess both retrievers against the frozen results and live counts, test top-k
and abstention rules with [`topk_abstention_eval.py`](rag/scripts/topk_abstention_eval.py)
(lab workspace and live library, read-only) and through the agent loop with
[`topk_abstention_agent.py`](rag/scripts/topk_abstention_agent.py) (local
Ollama GLM), and propose the dedup refinement workflow.
The [next-moves review](rag/reports/2026-09-21-retrieval-next-moves-review.md)
audits those saved results, separates result crowding from excerpt equivalence,
and records a bounded [Qwen pair-review probe](rag/scripts/knowledge_dedup_probe.py).
Its initial proposals are followed by the separate workspace and library
agent-loop experiments below; no reranker was tested again.

[`workspace_agentic_retrieval.py`](rag/scripts/workspace_agentic_retrieval.py)
compares current five-passage workspace search against lexical-protected
distance abstention through the actual chat loop. Fifteen paired requests and
two paired repeats use Ollama GLM and hash-verified local source PDFs, with
read-only access to the isolated lab index. The
[workspace report](rag/reports/2026-09-21-workspace-agentic-retrieval.md)
separates unavailable sources from search misses and recommends identifier
lookup/recovery work instead of deploying the abstention rule.

[`workspace_opening_agentic.py`](rag/scripts/workspace_opening_agentic.py)
tests a first-chunk heading in the existing source catalog through 20 fresh
Ollama turns, with an isolated runtime, read-only lab data and scoped controls.
The [opening-recovery report](rag/reports/2026-09-21-workspace-opening-agentic.md)
finds no final-answer improvement and identifies tools-off finalization as a
separate failure. Its `check` command validates the schedule and scoped-exclusion
fixture without services.

[`knowledge_agentic_breadth.py`](rag/scripts/knowledge_agentic_breadth.py)
compares five versus ten knowledge excerpts through the existing curate loop,
with 40 candidates and the unchanged tool-output limit. It runs six paired
requests plus two paired repeats on Ollama GLM, uses the library reader role
in read-only transactions, and saves materials locally. Run `--check` without
services or `--suite --output <fresh-local-directory>` for the live comparison.
Use `--b2-account` to read source PDFs with the locally authorized B2 CLI account.
Live access requires authorization. The runner records source versions and
excerpt-metadata hashes before and after each turn. See the
[agent-loop breadth report](rag/reports/2026-09-21-knowledge-agentic-breadth.md)
for outcomes: ten results improve saved-note counts, but the current capture
rule remains unmet. Its follow-up distinguishes that compliance score from
factual quality and proposes trusting Sol-reviewed text while comparing current
search with compact previews and selective reads. The earlier text-only
preflight is kept separate.

[`knowledge_compact_agent.py`](rag/scripts/knowledge_compact_agent.py) tests the
subsequent requested package: up to 20 compact previews, full evidence through
`read_knowledge`, no capture tool and prompt-steered finishing within the same
stall guard. Eight paired requests plus two paired repeats run from a frozen
local runtime copy with read-only library access. The
[compact-curate report](rag/reports/2026-09-21-knowledge-compact-finish.md)
records the protocol and outcomes. Run `--check` offline or `--suite --output
<fresh-directory>` with authorized library and B2 access.

[`knowledge_compact_tencent.py`](rag/scripts/knowledge_compact_tencent.py)
compares five current hits with twenty compact previews on four new paired
requests, holding the promoted prompts and mechanisms fixed. Tencent high and
one exported read-only database snapshot keep the comparison independent of
concurrent book publishing. The [results](rag/reports/2026-09-23-knowledge-compact-tencent.md)
separate supported content, local writes and actual application quiz acceptance.
Run `--check` offline, or `--output <fresh-directory>` for the live suite.

[`workspace_terminal_tencent.py`](rag/scripts/workspace_terminal_tencent.py)
replays three saved tools-off contexts with and without the existing terminal
instruction, then runs two fresh full loops through the current runtime and
saved playground chat prompt. The [Tencent report](rag/reports/2026-09-23-workspace-terminal-tencent.md)
keeps the instruction unpromoted. Commands are `check`, `run` and `fresh`.
Failing outputs and a supported control are available in
[playground history](rag/reports/2026-09-23-playground-retrieval-cases.md) for
developer-led prompt tuning.

The four subdirectories are frozen experiments, each with its own README,
reproduction steps, and report. They describe completed runs on a preserved lab
image — the scripts will not run against a production deployment.

| Experiment                       | Question                                                    |
| -------------------------------- | ----------------------------------------------------------- |
| [`curated/`](rag/curated/)       | Does the chat agent follow references between documents?     |
| [`broad/`](rag/broad/)           | The same, on public MIRACL and BEIR data                     |
| [`embedding/`](rag/embedding/)   | Five embedding conditions over a frozen 360-query corpus     |
| [`qwen38/`](rag/qwen38/)         | Qwen3.8 Flash against the prior DeepSeek run                 |

Narrative and current position: [HANDOFF-rag.md](../HANDOFF-rag.md).

## Not benchmarks

`collaboration/` has a peer-churn chaos driver (`pnpm chaos:peers`) and
`pipeline/scripts/certify_agentic_loop_model.py` records and replays one
provider's agentic loop. Both are correctness harnesses, not measurements, and
stay where they are.

Developer-PC tools that are not measurements live under [`lab/`](../lab/):
the agentic-loop playground (`lab/playground`) and the knowledge-base builder
(`lab/knowledge`). Both reuse bench fixtures and the pilot scripts here.

The 2026-09-22 curate promotion uses the shared application ledger updates and
material-backed excerpt retention in the playground.
[`knowledge_retention_agent.py`](rag/scripts/knowledge_retention_agent.py)
runs a two-turn reuse check against the selected preset with local materials;
see [promotion results](rag/reports/2026-09-22-curate-application-promotion.md).
