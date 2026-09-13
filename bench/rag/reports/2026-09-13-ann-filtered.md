# Filtered vector candidate diagnostic

The tested database plans lose no nearest-neighbour candidates. PostgreSQL
chooses exact scans in every case, so increasing HNSW search effort or enabling
iterative scans changes neither candidate coverage nor the selected plans.
This diagnostic supplies no evidence to change index settings. It does not
establish recall or latency for the complete deployed query, long selected
files, or larger workspace sizes.

## Why test this separately

The earlier frozen retrieval comparisons use exact cosine ordering. They cannot
detect a deployed approximate index omitting candidates before fusion.
The application has a global HNSW index over `halfvec(2560)` and filters by
workspace plus accessible selected files. Its SQL does not set `hnsw.ef_search`
or `hnsw.iterative_scan`.

The official [pgvector documentation](https://github.com/pgvector/pgvector#filtering)
explains that filtering after an approximate scan can leave too few results;
iterative scanning can retrieve additional candidates. The same documentation
recommends ordinary filter-column indexes for selective exact searches. Which
path PostgreSQL chooses matters more than the mere presence of an HNSW index.

## Protocol and scope

- Reuse all 3,277 actual 2,560-dimensional vectors from the frozen multilingual
  experiment. Copy the corpus into eight isolated synthetic workspaces,
  26,216 vector rows total. Identical vectors across tenants model shared
  documents, not representative production traffic.
- Pick four questions per locale by SHA-256 of query ID, 32 total, before
  executing the diagnostic. Reuse their exact query vectors and production
  six-significant-digit serialization into `halfvec`.
- Compare workspace scope, the file set for the query's assigned locale, and
  one labeled-positive file. The latter is an oracle scope used only to test
  a narrow database filter. It is not a proposed retrieval policy.
- Extract the vector stage and source-scope CTE from current application SQL.
  Preserve its joins, workspace filter, row-number ranking and candidate limit.
  Materialize source scope, as PostgreSQL does when the full hybrid query
  references that CTE repeatedly. The projection references `vec` once and may
  inline it; the complete hybrid query references it twice and normally
  materializes it too. Thus only the source-scope materialization matches the
  complete query. This is a derived vector-stage diagnostic, not full hybrid
  execution or end-to-end latency.
- Establish exact neighbours with the same query and `distance + 0` ordering,
  which does not qualify for the HNSW distance-order index path. Compare current
  settings with strict iterative scanning at `ef_search=40` and `200`.
- Record every query plan, output ID and distance. Candidate coverage is the
  fraction of expected neighbours returned within the exact top-40 distance
  boundary, with tolerance `1e-7` for ties. Expected count is bounded by actual
  scope size. This measures engine recall, not relevance, nDCG or answer quality.
- One warmup and three measured executions per query/scope/arm. Rotate arm
  order by query index. Client timings include local Docker network overhead.

The local disposable database used PostgreSQL 16.15, pgvector 0.8.6, two CPU
cores, a 2 GB container limit and `work_mem=4MB`. Its default `ef_search` was
40, iterative scans were off and `max_scan_tuples` was 20,000. The schema
contains only the vector stage's relevant columns and indexes; it is not a
production database snapshot. No provider, UAT or application database calls
were needed.

## Results

All 288 query/scope/arm comparisons returned the full exact candidate set by
distance. No plan used the HNSW index. B-tree filters, joins and exact sorting
handled these scopes.

| Scope | Current candidate coverage | Shortfall queries | Current median client time | Iterative 40 | Iterative 200 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Workspace | 100% | 0/32 | 26.87 ms | 26.94 ms | 26.88 ms |
| Locale file set | 100% | 0/32 | 11.23 ms | 10.80 ms | 11.50 ms |
| One positive file | 100% | 0/32 | 1.14 ms | 1.15 ms | 1.12 ms |

All 32 positive-file scopes contain exactly one vector. Their full coverage and
roughly one-millisecond timing are trivial single-vector checks. They provide no
evidence about selected long PDFs such as the 56-chunk JLPT document.

The small timing differences do not support a performance claim. They are
repeated local measurements without confidence intervals. In this diagnostic,
HNSW tuning cannot improve results because those plans do not use HNSW.
Future capacity testing should repeat exact-versus-approximate candidate checks
when real workspace sizes or planner choices change. Forcing a different plan
now would test an unselected implementation.

## Reproduction and audit

[`ann_filtered_eval.py`](../scripts/ann_filtered_eval.py) requires the retained
`prepared.json` and `vectors.sqlite3` under
`bench/rag/reports/local/2026-09-13-multilingual-language-handling/` and a
disposable empty database at the fixed loopback endpoint below. It freezes
source/input hashes, query IDs and the protocol before creating the index or
executing comparisons. The database name and port are dedicated to this lab.

```sh
docker run -d --name capy-ann-db-20260913 --memory 2g --cpus 2 \
  -p 127.0.0.1:55439:5432 -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=capy_ann_lab pgvector/pgvector:pg16
python bench/rag/scripts/ann_filtered_eval.py \
  --output /tmp/capy-ann-repeat
docker rm -f -v capy-ann-db-20260913
```

The image tag is mutable; this run used image ID
`sha256:2dbfde49c067cafff2a69e7019423181adca6328b94f197ac93fbb01a96a3a9d`.
Compare the recorded PostgreSQL and extension versions before comparing a
replay. Python requires psycopg. The optional
`--reuse-lab` flag reuses the same experiment-owned database and verifies row
count; it is not a complete database-content integrity check.

An initial projection referenced the scope CTE only once, allowing inlining.
The corrected follow-up explicitly materialized source scope to reflect that
part of the full hybrid query, but did not match `vec` materialization. All inputs
and arms stayed fixed; the initial results had already been
seen and remain in `local/2026-09-13-ann-filtered/` with the executed script and
an amendment receipt. Both versions produced complete candidate coverage and
zero HNSW plans. The table above uses only the corrected follow-up in
`local/2026-09-13-ann-filtered-materialized/`.

An independent reconstruction from recorded IDs and distances verified unique
output IDs, expected counts, distance coverage and plan names for all 288
corrected records. This checks the reported arithmetic; it is not an
independently implemented database query.

| Corrected artifact | SHA-256 |
| --- | --- |
| Executed script | `ab530bb715b3e76fe037bcd019172ea191837e94c3915c56cdba1474d1b10ea3` |
| Results with plans | `831ebd6155a3b39623282c7560190f9ef8917ea7db90baafd8b2f218cf4b35fe` |
| Summary | `b5d0b78f5d98dec0f7e44402a8cb5f44853f708241072702f5d51d2932eae8cd` |

The experiment container and its anonymous data volume were removed after
verification; a cleanup receipt is retained with the corrected results.
No application code, index setting, deployment or existing database changed.
