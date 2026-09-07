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
`fixtures/docs/` is gitignored — it holds real uploads. Local output goes to
`reports/local/`, also gitignored.

Decision records: [parser accuracy](parsers/reports/2026-08-28-parser-accuracy.md),
[worker stress](parsers/reports/2026-08-31-worker-stress.md).

### grading

14,000 grading cases across 8 domains and 7 language groups, scored against the
production prompt in `pipeline/pipeline/retrieve/quiz_grade.py`. AI-authored and
AI-reviewed labels, not human-certified — read
[the README](grading/README.md) on provenance before citing a number. Model
files and run artifacts live in the gitignored `data/grading-benchmark/`.

### rag

`rag/scripts/rag_eval.py` is the one live tool here: a retrieval diagnostic that
runs the production `search()` against a real workspace inside the pipeline
image. Its question sets in `rag/fixtures/` are keyed to `CHUNKER_VERSION` and to
a corpus that is **not in this repo**: 16 real documents across six languages at
`/opt/capy-rag-lab/samples` on the ingest host. That corpus was gathered ad hoc
and has no fetch script, so those bytes exist in one place only —
[`rag/fixtures/samples-manifest.json`](rag/fixtures/samples-manifest.json)
records its checksums and which question set uses each file. Lose the corpus and
the question sets become unusable.

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
