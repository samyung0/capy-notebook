# Benchmarks

Every performance, capacity, and model-quality measurement in the repository.
Only the editor and collaboration suites run in CI (the `Performance` workflow,
dispatched by hand); the rest are manual, and most need a VM or a downloaded
model runtime.

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
| [`collaboration/`](collaboration/) | Collaboration stress: many peers typing with reconnects in one Office and one Plate room; convergence, lost updates, latency | `pnpm bench:stress` (Docker)     |
| [`editor/`](editor/)       | Plate editor open cost, typing latency, save cycle, scroll FPS under CPU throttle; DOCX, XLSX and PPTX open, View to Edit, typing and heap in the Office runtime; formula View/Edit parity | `pnpm bench:editor`, `pnpm bench:office`, `pnpm bench:formula` |
| [`parsers/`](parsers/)     | Ingest-host parser accuracy and capacity: OCR modes, concurrency, worker memory, OOM behavior    | `python bench/parsers/scripts/…` (needs VM) |
| [`grading/`](grading/)     | Small local models against the production quiz-grading rubric, native and in-browser             | `python bench/grading/scripts/benchmark.py` |
| [`rag/`](rag/scripts/)     | Retrieval and chat-agent quality: live diagnostic plus six frozen experiments                    | see below                                   |

### editor

The only CI-wired suite, run manually via the `Performance` workflow
(`.github/workflows/perf.yml`, formerly `Editor perf`) and on
production promotion. Budgets are regression tripwires, not UX targets; snapshot
deltas stay warn-only. Details: [editor-perf.md](../openwiki/editor-perf.md).
Results land in the gitignored `editor/.results/`, so this family has no
committed reports.

`pnpm bench:office` is the Office runtime's spec (`editor/scripts/runtime.office.ts`):
a production build with MSW, the runtime on a second port of `localhost` (another
origin on the same site, as in production), and a small and a large file per
format: DOCX `exchange-plan.docx` and the generated 62-page
`editor/fixtures/office/long-handbook.docx` (`editor/scripts/gen_long_docx.py`),
XLSX `course-guide.xlsx` and the generated 8-sheet, 16,000-row
`editor/fixtures/office/large-gradebook.xlsx` (`editor/scripts/gen_large_xlsx.py`),
PPTX `lecture.pptx` and the 84-slide `parsers/fixtures/docs/jp_llm2.pptx`. The
large files' checkpoints come from `scripts/dev/seed-scenario-office.ts`. It
reports open to first paint, View to Edit ready, keystroke to painted frame and
the JS and WASM heap at each step, plus the heap over two full view-mode passes
and over five view-mode opens and closes. It
fails on unpainted keys, typing that reaches no edit, a fallback to the
main-thread engine, or a missed budget (from three CI runs per format); the
heap figures are report-only until a ceiling is defined. It runs as
the `office` job of the same `Performance` workflow, on dispatch only.

`pnpm bench:formula` is an audit for MathLive upgrades, not a budget
(`editor/scripts/formula-parity.audit.ts`, no workflow runs it): every formula
Insert and matrix template, empty and filled, inline and block, must match in
View and Edit within 0.1px per glyph, with the same fonts and LaTeX. It uses the
editor e2e seed and writes captures and geometry JSON to
`editor/.results/formula-parity/`.

### collaboration

`collaboration/scripts/stress.ts` starts the e2e Docker stack through
`e2e/global-setup.ts` (collaboration, server, Postgres, Redis) with
`docker-compose.stress.yml` layered on: the e2e stack's memory blob store gives
the collaboration service `memory://` URLs it cannot fetch, so a fake S3
(`fake-s3.mjs`, run in the collaboration image, TLS under a `*.backblazeb2.com`
name the server accepts) holds the uploaded DOCX. STRESS_PEERS peers (20) type
markers into an Office room (`exchange-plan.docx`) and a Plate note for
STRESS_MINUTES (3), each dropping offline for 1-5 s now and then and typing on.
It fails when the peers and a late joiner do not converge, a typed marker is
missing or duplicated, or the collaboration service logs an error (exit 1),
and reports a missed p95 latency budget (from three CI runs) with exit 2. The
`Performance` workflow's `stress` job runs it on dispatch only. Results land in
the gitignored `collaboration/.results/`. `STRESS_TARGET=uat` runs it against UAT with disposable
journey-style users and store-only, unindexed rooms (see
[editor-perf.md](../openwiki/editor-perf.md#collaboration-stress-pnpm-benchstress)).
Capacity reports live in `collaboration/reports/`: the
[2026-10-05 production-box run](collaboration/reports/2026-10-05-prod-capacity.md)
ladders Plate and Office rooms, concurrent large Office files and idle
connections with the collaboration service on 1 and 2 cores, and the
[replica run](collaboration/reports/2026-10-05-office-engine-replicas.md)
measures the Office engine worker keeping each XLSX room's workbook open.

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
retired generative quiz prompt (`grading/scripts/quiz_prompt.py`). AI-authored and
AI-reviewed labels, not human-certified — read
[the README](grading/README.md) on provenance before citing a number. Model
files and run artifacts live in the gitignored `data/grading-benchmark/`.
`scripts/typesafe_math.py` is a separate hosted-judge probe: typesafe.ai jev on
math step checking, final-answer and unit equivalence, algebraic form, and per-rubric
grading across subjects (essays plus the English seeds) and routing of
computational questions, findings in
[2026-09-19-typesafe-jev-judge.md](grading/reports/2026-09-19-typesafe-jev-judge.md).
The [Laya CPU comparison](grading/reports/2026-09-27-laya-cpu.md) replays those
archived requests on the ingest VM with `grading/scripts/laya_cpu.py`, measuring
marking-point agreement, latency, memory and input truncation.
The [Alibaba decision-model comparison](grading/reports/2026-09-27-alibaba-decision.md)
uses the same requests through the hosted System One API, with separate
format controls and server/client latency records.
The [production contract report](grading/reports/2026-10-02-jev-production-contract.md)
runs [`jev_contract.py`](grading/scripts/jev_contract.py) on new held-out fixtures
to choose the Jev request for open quiz parts (question type, batching, state
fields) and the author-side computation warning, with a small LaTeX check.

### rag

[`rich_chat_validity.py`](rag/scripts/rich_chat_validity.py) samples the current
rich-chat prompt with frozen synthetic evidence through GLM on Relace and official
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

The September 9 ODL agentic evaluation has a verified inspection copy at
[`rag/fixtures/local/2026-09-09-odl-agentic/README.md`](rag/fixtures/local/2026-09-09-odl-agentic/README.md).
It includes all 29 evaluation PDFs, the two original PowerPoint files, and an
index mapping documents to questions. This covers the 16 legacy originals as
well as the additional parser sources. All 29 PDFs and both original PowerPoint
files are committed, despite the directory's historical `local` name.

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

Past agent-loop and retrieval experiments ran once, recorded their decision in
a report and had their scripts deleted on 2026-10-05 (curate mode, Tencent and
the September lab runtimes they drove are gone; the scripts are in git
history). Reports in [`rag/reports/`](rag/reports/):
[GLM on Relace and Tencent](rag/reports/2026-09-26-glm-relace-tencent.md),
[library scope](rag/reports/2026-09-20-knowledge-scope-agent.md) and its
[follow-up](rag/reports/2026-09-21-knowledge-scope-implementation.md),
[Sol topic owner](rag/reports/2026-09-21-sol-topic-owner.md),
[Sol workflow](rag/reports/2026-09-21-sol-workflow-examples.md),
[deduplication strategy](rag/reports/2026-09-21-knowledge-duplicate-strategy.md),
[retrieval directions](rag/reports/2026-09-21-retrieval-improvement-directions.md),
[next moves](rag/reports/2026-09-21-retrieval-next-moves-review.md),
[workspace abstention](rag/reports/2026-09-21-workspace-agentic-retrieval.md),
[workspace opening](rag/reports/2026-09-21-workspace-opening-agentic.md),
[library breadth](rag/reports/2026-09-21-knowledge-agentic-breadth.md),
[compact previews](rag/reports/2026-09-21-knowledge-compact-finish.md) and
[on Tencent](rag/reports/2026-09-23-knowledge-compact-tencent.md),
[tools-off finish](rag/reports/2026-09-23-workspace-terminal-tencent.md),
[curate promotion](rag/reports/2026-09-22-curate-application-promotion.md),
[ODL agentic evaluation](rag/reports/2026-09-09-odl-agentic-evaluation.md) and
[bank search](rag/reports/2026-10-04-bank-search.md).
The [Qwen book review sample pack](rag/fixtures/knowledge-review-v2/README.md)
stays: `lab/knowledge` uses it.

The six subdirectories are frozen experiments, each with its own README,
reproduction steps, and report. They describe completed runs on a preserved lab
image — the scripts will not run against a production deployment.

| Experiment                       | Question                                                    |
| -------------------------------- | ----------------------------------------------------------- |
| [`curated/`](rag/curated/)       | Does the chat agent follow references between documents?     |
| [`broad/`](rag/broad/)           | The same, on public MIRACL and BEIR data                     |
| [`embedding/`](rag/embedding/)   | Five embedding conditions over a frozen 360-query corpus     |
| [`qwen38/`](rag/qwen38/)         | Qwen3.8 Flash against the prior DeepSeek run                 |
| [`qwen37/`](rag/qwen37/)         | Embedding models over the knowledge library                  |
| [`rerank/`](rag/rerank/)         | Rerankers over the knowledge library                         |

## Not benchmarks

`collaboration/` has a peer-churn chaos driver (`pnpm chaos:peers`, an open-ended
dev harness against a live room; the bounded test is `bench/collaboration`) and
`pipeline/scripts/certify_agentic_loop_model.py` records and replays one
provider's agentic loop. Both are correctness harnesses, not measurements, and
stay where they are.

Developer-PC tools that are not measurements live under [`lab/`](../lab/):
the agentic-loop playground (`lab/playground`) and the knowledge-base builder
(`lab/knowledge`). Both reuse bench fixtures and the pilot scripts here.
