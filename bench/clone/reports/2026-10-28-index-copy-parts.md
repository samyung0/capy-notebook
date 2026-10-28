# Index copy parts, and re-tagging in place

Run 2026-10-28 on the same MacBook as
[2026-10-27-clone-cost.md](2026-10-27-clone-cost.md) (Apple M1, Docker
Desktop, pgvector Postgres from `server/cmd/testdb`), through
[`scripts/run.sh`](../scripts/run.sh) (`TestCloneCostParts`). Each figure is
the median of three runs, each in its own rolled-back transaction. The HNSW
index already holds 20,000 vectors of another workspace, so inserts pay a
realistic graph size. Passages carry a full-text `search` vector (the GIN
index), which the 2026-10-27 run left empty.

Question (Epo 2026-10-28): how cheap can a clone and a move get on the
database side?

| Part | 2,000 chunks | 5,000 chunks | Per chunk |
| --- | ---: | ---: | ---: |
| Passages copied (content row, chunks, GIN) | 0.41 s | 1.00 s | 0.20 ms |
| Passages and vectors copied | 6.74 s | 15.99 s | 3.2-3.4 ms |
| Whole copy (`copyRetrievalContents`) | 5.61 s | 17.40 s | 2.8-3.5 ms |
| Re-tag every row's workspace in place | 4.92 s | 13.71 s | 2.5-2.7 ms |
| Re-tag passages only | 0.20 s | 0.73 s | 0.10-0.15 ms |
| Re-tag the content row only | 1.6 ms | 0.9 ms | constant |

## Findings

1. **The vectors are the cost.** Inserting into the HNSW graph is about
   3 ms a vector at this size, over 90% of a copy; passages and their
   full-text index are 0.2 ms a chunk.
2. **Re-tagging in place saves almost nothing.** Changing `workspace_id`
   on a vector row is not a HOT update (the column is indexed), so
   PostgreSQL writes a new row version and adds it to every index, the HNSW
   graph included, and leaves the old version for vacuum.
3. **Only scoping through the content row is cheap.** If passages and
   vectors carried no workspace and search reached them through their
   content row (as `scoped_files` already does), a move would change one
   content row and its alias: about a millisecond whatever the file's size.
   A clone still copies, unless content were shared across workspaces.

## After migration 0126

Epo chose the third option. The same run on the new schema, where
`moveFileTx` re-tags the content row and its alias:

| Part | 2,000 chunks | 5,000 chunks |
| --- | ---: | ---: |
| Passages copied | 0.39 s | 0.86 s |
| Passages and vectors copied | 5.22 s | 14.96 s |
| Whole copy (`copyRetrievalContents`) | 6.16 s | 13.84 s |
| Move (`moveFileTx`, whole transaction body) | 4.3 ms | 3.5 ms |

A move no longer depends on the file's size. A clone still copies its
vectors, so it moves to the background job.
