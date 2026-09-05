# Broad RAG evaluation

This suite evaluates the existing retrieval settings and the reference-following
change from the [curated experiment](../curated/REPORT.md) on fresh public data.
It does not train a model or choose new settings from the evaluation results.
The [plan](PLAN.md) fixes the comparison and scope.

The retained VM directory is `/opt/capy-rag-curated-20260905/broad`, mounted as
`/lab/broad` in the isolated `capy-rag-curated-retrieval-1` container. The scripts
guard the lab gateway at `127.0.0.1:8082` and PostgreSQL at `127.0.0.1:55434`.
They have no production credentials in their source or result files. Model
credentials remain in the existing lab environment.

## Data and attribution

| Source | Use | Upstream information |
| --- | --- | --- |
| MIRACL | 40 native questions each in English, German, Spanish, French, Japanese, Korean and Chinese; pool every judged positive and negative passage for those questions | [Dataset and relevance labels](https://huggingface.co/datasets/miracl/miracl), [corpus](https://huggingface.co/datasets/miracl/miracl-corpus), cards labeled Apache 2.0; original Wikipedia text retains its source attribution and terms |
| BEIR SciFact | 40 questions over all 5,183 abstracts | [Dataset card](https://huggingface.co/datasets/BeIR/scifact), CC BY-SA 4.0 |
| BEIR ArguAna | 40 argument queries over all 8,674 passages | [Dataset card](https://huggingface.co/datasets/BeIR/arguana), CC BY-SA 4.0 |
| MLQA | Eight questions with source and question languages differing | [Dataset](https://github.com/facebookresearch/MLQA), Wikipedia-derived text under CC BY-SA 3.0 |
| HotpotQA | Eight two-document questions and two derived missing-source controls | [Dataset](https://hotpotqa.github.io/), [download mirror](https://huggingface.co/datasets/hotpotqa/hotpot_qa), CC BY-SA 4.0 |

`fetch_data.py` records Hugging Face commit IDs and archive digests. It reads
Parquet and known archive members without executing dataset loader code.
Question selection uses SHA-256 with seed `capy-broad-20260905-v1`.
For a byte-identical rerun, use the retained raw cache and metadata, or fetch the
exact upstream revisions recorded in `results.json`. A fresh metadata download
can resolve a newer upstream revision.

The 360-query retrieval test retains upstream relevance labels. Unjudged
documents receive zero relevance, so incomplete judgments can understate useful
retrieval. MIRACL's reduced candidate pools are easier than its full-corpus
benchmark. These are application diagnostics, not official benchmark scores.
BEIR's query document is excluded when its ID appears in the corpus, following
the [standard BEIR convention](https://github.com/beir-cellar/beir/blob/main/beir/retrieval/evaluation.py).

The chat cases, answer rubrics, aliases, and required source spans are fixed by
`build_agent.py`. Native questions were selected for source answerability before
either condition was run. Some upstream relevance labels describe passages that
do not establish an answer. No retrieval score was used to choose chat cases.
MLQA's original questions gain their article title to identify the subject in a
notebook. All related positive/negative cases remain in the same evaluation.
The HotpotQA university case keeps the original answer label and a documented
correction to Aligarh Muslim University based on the supplied source.

## Run order

Use the already isolated stack described in the curated suite. Copy these scripts
into its `broad/` directory. Commands below run from that VM directory.
The download step additionally uses PyArrow 25.0.1 installed only into
`/lab/broad/vendor`.

```sh
docker exec -e PYTHONPATH=/lab/broad/vendor capy-rag-curated-retrieval-1 python /lab/broad/fetch_data.py /lab/broad miracl
docker exec -e PYTHONPATH=/lab/broad/vendor capy-rag-curated-retrieval-1 python /lab/broad/fetch_data.py /lab/broad beir
docker exec -e PYTHONPATH=/lab/broad/vendor capy-rag-curated-retrieval-1 python /lab/broad/fetch_data.py /lab/broad qa
docker exec capy-rag-curated-retrieval-1 python /lab/broad/index_corpus.py beir
docker exec capy-rag-curated-retrieval-1 python /lab/broad/index_corpus.py miracl
docker exec capy-rag-curated-retrieval-1 python /lab/broad/run_retrieval.py
python3 build_agent.py .
docker exec capy-rag-curated-retrieval-1 python /lab/broad/upload_agent.py
```

Run index writers sequentially. Keep the index fixed throughout retrieval
evaluation; start QA ingestion only after `retrieval-completion.json` exists.
Analyze the lab retrieval tables before the retrieval freeze. The component
fixture uses the application's chunker, language detector, embedding model and
index writer, but bypasses upload, parsing and generated summaries.

For chat, start only this lab's ingest services, wait for every uploaded source
to become ready, and temporarily set only its retrieval command to
`["python", "/lab/broad/serve.py"]`. Initialize `broad/variant.json` with the
baseline settings from the curated recorder, then run:

```sh
docker exec capy-rag-curated-retrieval-1 python /lab/broad/run_chat.py
```

The runner verifies all required evidence in the index and freezes source,
script, model, and index hashes before the first turn. It reuses the curated
SSE/tool recorder, with separate conversations and logs for the two conditions
and two repeats. It sets the lab account locale through the normal API before
each turn and restores the original locale afterward. Chinese questions use
the Chinese account locale; all others use the English locale. The model may
still violate that instruction, so this is not a response-language compliance
test.
Only the ingest worker is needed for these Markdown uploads. The parser and parse
coordinator remain stopped because Markdown uses the normal raw-text route.

The first run stopped after a provider stream read error. `resume_chat.py`
verifies the frozen inputs and records an amendment before continuing only the
remaining attempts. Its opt-in `skip_attempted` recorder flag preserves errors
in the denominator and prevents retries of failed turns. The initial recorder
is retained as `recorder-initial.py`; `resume-amendments.jsonl` records the old
and resumed hashes. The original case selection, conditions and inputs remain
fixed.

```sh
docker exec capy-rag-curated-retrieval-1 python /lab/broad/resume_chat.py
```

`run_retrieval.self_check()` covers passage positions, duplicate chunks, content
aliases and empty/missed results. Query vectors are cached and shared across
hybrid, dense and exact-dense arms. SQL-path timings exclude embedding calls and
are single-client diagnostics. Saved execution plans establish whether the
database actually used an approximate index.

After chat, review every answer against its source and complete tool trace.
Keep answer correctness, source support, labeled-evidence coverage, citations,
and missing-source behavior separate. Automated span presence is a diagnostic,
not a substitute for this review. Public benchmark memorization is possible.
`analyze.py` requires a review for all 144 distinct first attempts, including
errors. Completed-turn latency and token statistics exclude transport failures;
answer-quality rates include them. Correctness checks the requested answer,
while grounding and citation support also check added factual details. An
unsupported addition can therefore fail grounding despite a correct short
answer. A likely typo in a source is not permission to silently change its units.

Raw sources, embeddings, full index snapshots, streams and tool outputs stay in
the VM lab. Retain their hashes with the report. Restore the retrieval command
and baseline variant, then stop only the ingest services started for this run.
Preserve the earlier experiment and all new data for inspection.
