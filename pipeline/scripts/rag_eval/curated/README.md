# Curated RAG experiment

This experiment uses invented course records to test whether the chat agent follows
references between documents, distinguishes current from retired procedures, reads
PDF table rows, and recognizes missing evidence. See [REPORT.md](REPORT.md) for
the measured results and limitations.

The fixture has 23 documents and 48 questions: 35 development questions and 13
held-out questions. A complete workspace contains every document. A second
workspace omits both accession registers, breaking the link between specimens and
assays. The same question can therefore be answerable in one workspace and
unanswerable in the other. All names, assignments, and measurements are fictional.

## Files

| File | Purpose |
| --- | --- |
| `build_corpus.py` | Generate source documents, question labels, and a source hash manifest. Requires `reportlab`. |
| `upload_corpus.py` | Upload through the normal reservation, object PUT, and completion APIs; journal progress for resume. |
| `inspect_index.py` | Check every expected evidence span in the uploaded index, including parsed PDF table values. |
| `lab_server.py` | Instrument actual agent tools and apply one explicitly selected experiment condition. |
| `run_agent.py` | Run fresh conversations sequentially, capture SSE and all search/read evidence, and record diagnostic scores. |
| `summarize.py` | Summarize a raw run without treating numeric matching as a semantic judge. |
| `probe_bridges.py` | Search known intermediate identifiers to diagnose whether failed agent hops are retrievable. These oracle probes are not agent successes. |
| `check_grading.py` | Verify required hops, numeric boundaries, signed values, identifier suffixes, and decimal fidelity. |
| `results.json` | Frozen manifests, model pins, run hashes, and metrics for every experiment phase. |
| `heldout-review.json` | Review of all 78 held-out answers, including unsupported absence claims and malformed output. |

## Frozen lab

The experiment runs on the ingest VM at `159.195.61.195`, under
`/opt/capy-rag-curated-20260905`. Its Compose project is `capy-rag-curated`.
The original `/opt/evo-rag-lab` remains separate.

The source archive is pinned to
`a903b8e917144701186b9c6cd2a6bbeea1bd15f9`. The lab retains `src/`, `revision`,
`compose.json`, `setup_lab.py`, built images, generated source files, model pins,
and raw run traces. The gateway has one lab-only change allowing the loopback
MinIO endpoint; authentication and admission limits are disabled in this lab.
Parser application files come from the pinned revision, layered over the cached
MinerU image and model weights. The new project has its own database, object
storage, Redis, and parse-spool volumes. Services bind to loopback:

| Service | Port |
| --- | --- |
| Gateway | 8082 |
| Retrieval | 8002 |
| Parser | 8092 |
| PostgreSQL | 55434 |
| Redis | 6381 |
| MinIO / console | 9002 / 9003 |

Provider credentials are referenced by the VM Compose configuration; they are not
included in this directory or the result artifacts. The recorded corpus is at
`corpus/sources/`, with `manifest.json`, `questions.json`, `records.json`, and
`workspaces.json` beside it. `index-snapshot.json` preserves the indexed evidence
and model identities. `tool-evidence.jsonl` records full tool results keyed by
assistant message ID, including unsuccessful reads.

## Run on the existing VM lab

Run from `/opt/capy-rag-curated-20260905`, using the retained baseline images.
The instrumentation expects that baseline source revision; attaching it to the
updated application would apply the reference instruction twice. The original
runner is retained as `run_agent-as-run.py` for its frozen hash. The current
runner tightens numeric matching; rescoring all 169 turns changed no score.
After copying an updated `lab_server.py`, restart only the lab retrieval service
and wait for `http://127.0.0.1:8002/healthz` before starting a run:

```sh
docker compose -f compose.json restart retrieval
docker exec capy-rag-curated-retrieval-1 python /lab/inspect_index.py
python3 check_grading.py
python3 run_agent.py . --variants baseline,follow_links,follow_links_ids --split holdout --repeats 2 --output holdout-new-run.jsonl
python3 summarize.py holdout-new-run.jsonl
```

Use a new output filename for a new experiment. Reusing an output file resumes it
by skipping completed `(question, variant, repeat)` keys. Runs are shuffled with a
fixed seed and execute sequentially with a fresh conversation for every case.
Do not run two evaluations together: the instrumented server reads the shared
`variant.json` when constructing prompts and executing tools.

`run_agent.py` defines the exact conditions; `lab_server.py` contains the additional
reference-following instruction and the document-location footer. The baseline
uses top five results, per-file cap four, lexical weight 0.5 with the existing
short-query exception, and the repeated-result stop hint. Nothing in the runner
changes indexed documents or needs a re-embedding pass.

At handoff, the lab parser, ingest worker, and parse coordinator are stopped to
release VM resources. Its gateway, retrieval service, and data services remain
available on loopback; `variant.json` is reset to baseline. Start ingestion again
only when uploading more source files:

```sh
docker compose -f compose.json start parser worker parse-coordinator
```

To generate a separate fixture copy with Python and `reportlab` installed:

```sh
python3 build_corpus.py /tmp/rag-curated-fixture
```

Text, assignments, and question splits use a fixed seed. PDF metadata can change
the file bytes on regeneration; use the retained source archive and recorded
manifest when exact input hashes matter. Uploading a new fixture requires an
explicit loopback API argument:

```sh
python3 upload_corpus.py /tmp/rag-curated-fixture http://127.0.0.1:8082
```

Ingestion is asynchronous. Do not start evaluation until all files are ready and
`inspect_index.py` confirms the required evidence is indexed. It expects the
experiment's selected corpus under `/lab/corpus`.

## Grading

Each positive question has required evidence groups. A group contains acceptable
source spans; every group must be reached. This catches an answer that mentions a
correct number but never finds the accession-to-assay link. Evidence includes
`read_document` results as well as search hits. A separate diagnostic checks
whether the final answer cites every required group.

Numeric/name matching is only a screening diagnostic. It does not establish that
values were assigned to the right specimen, that a comparison has the right
direction, or that prose claims are supported. The report separately records
manual review of held-out answers and negative controls. Refusing a numeric answer
while inventing a missing document or claiming that no procedure exists is not a
fully supported answer.

The held-out questions share the corpus and writing templates with development;
some reuse a record through another question type. They are not an independent
domain benchmark. The translated questions use bilingual vocabulary cards over
an English index. The two simple PDF tables do not measure difficult OCR or broad
multilingual ingestion. Measured latency is lab elapsed time with live providers,
not production or UAT performance.
