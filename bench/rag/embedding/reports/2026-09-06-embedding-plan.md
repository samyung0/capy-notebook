# Embedding comparison

Authorized on 6 September 2026 UTC. Use the idle ingest VM and the preserved
`capy-rag-curated` lab at revision a903b8e917144701186b9c6cd2a6bbeea1bd15f9.
Read HANDOFF-rag.md. This is a model comparison, with no selected production
model, schema, ranking, chunking or agent change.

## Frozen conditions

| Condition | Route | Dimensions | Query/document convention |
| --- | --- | ---: | --- |
| qwen4 | DeepInfra Qwen/Qwen3-Embedding-4B | 2560 | Existing Qwen query instruction, raw indexed documents |
| qwen8_2560 | DeepInfra Qwen/Qwen3-Embedding-8B | 2560 | Same instruction |
| qwen8_4000 | DeepInfra Qwen/Qwen3-Embedding-8B | 4000 | Same instruction |
| pplx4 | OpenRouter perplexity/pplx-embed-v1-4b, Perplexity only | 2560 | No instruction; cosine on returned embeddings |
| voyage4 | OpenRouter voyageai/voyage-4-large, VoyageAI by MongoDB only | 2048 | Explicit query/document input type |

Use the exact existing indexed text, workspace/file scope and relevance labels.
Fetch fresh document and query embeddings for every condition. Cache by the full
condition, input role and text hash. Check count, order, finite values, nonzero
norms and actual dimensions before accepting responses. Provider fallback is
disabled. Preflight every route before committing to the full run. Input-format
corrections discovered in preflight must be recorded before evaluation.

Run all 360 broad questions. Compare current hybrid and dense-only top five with
40 candidates and cap four per file, using the retained application SQL and
ranking functions. Break down hit@5, recall@5, nDCG@5 and MRR by cohort. Preserve
paired gains/losses. Force exact vector search for the quality comparison so ANN
approximation does not confound model quality. Separately compare real HNSW to
exact vector neighbors with recorded plans, index sizes/build times and search
parameters. Report filtered-workspace behavior and actual planner choices;
this corpus cannot establish production-scale performance.

Measure uncached query API latency on the same deterministic sample of 36 broad
queries, three repeats per condition at concurrency one and four, with shuffled
condition order. Record failures as failures without retry. Corpus embedding may
resume cached successful batches after explicit recorded infrastructure errors;
it is not the latency sample. Record provider usage and quoted token prices.

Select the challenger with highest aggregate hybrid nDCG@5; dense metrics and
cohort regressions remain visible. Run baseline and challenger on all 48 curated
questions twice, interleaved deterministically, using the previously selected
follow_links_ids agent behavior for both. Keep chat model, prompts and tool limits
fixed. Review all answers against full tool traces; distinguish answer values,
evidence reached, supported claims, citations and absence behavior. These reused
cases are comparison/development data, not fresh held-out evidence. Record any
infrastructure failures in the primary denominator; do not silently retry them.

## Isolation and cleanup

Only disposable lab data is used. Scratch vector tables are in the dedicated
`embedding_eval_20260906` schema. Embedding overrides are test-process hooks;
workspace pins and production source are not changed. Credentials live in a
mode-0600 file outside the repository and are removed after execution.
Preserve original experiment artifacts and source/index hashes. Archive new raw
results, scripts, source manifests and review evidence locally before dropping
the scratch schema, deleting temporary VM files and removing any new containers.
Restore reused containers to their original stopped state. Earlier retained labs
and their volumes are outside this experiment's cleanup scope.
