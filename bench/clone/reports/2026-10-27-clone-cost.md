# Single file clone cost

Run 2026-10-27 on a MacBook (Apple M1, Docker Desktop with 6 CPUs and 2 GiB),
pgvector Postgres from `server/cmd/testdb`, through
[`scripts/run.sh`](../scripts/run.sh). Each figure is the median of three
runs, each in its own rolled-back transaction. Production's box is slower per
core, so read these as ratios and orders of magnitude, not budgets.

Question (Epo 2026-10-27): what would it buy to (1) run a clone's index copy
as a tracked background step, and (2) copy one folded saved-edit state
instead of the saved-edit log? Sharing index content across workspaces was
left out.

## What a clone does today

One repeatable-read transaction in the request (`cloneFileOnce` in
`server/internal/store/share.go`):

- the file row, pointing at the same stored object (no bytes copied);
- the saved edits: the `source_documents` row and every
  `source_document_updates` row of its current epoch (`insertCloneFileTx`);
  edits not yet saved in a live room stay behind;
- the index: every chunk, its 2560-d vector and the summary, copied into the
  target's scope (`copyRetrievalContents`), or an ingest job when the target
  embeds in another space;
- after the commit, one storage-side thumbnail copy.

No Office conversion runs at clone time.

## Index copy (option 1)

| Chunks | Copy  | Per chunk |
| -----: | ----: | --------: |
|    500 | 0.40 s |  0.80 ms |
|  2,000 | 2.91 s |  1.46 ms |
|  5,000 | 10.69 s | 2.14 ms |

- This is most of a clone's time for any indexed file, and it grows faster
  than the chunk count: each vector goes into the target's HNSW index, which
  costs more as that index grows.
- A long textbook already makes the request wait several seconds, and the
  transaction stays open for all of it.
- Moving it to a background step leaves the request with the row and the
  saved edits, which the next section puts at milliseconds to under a
  second.

## Saved edits (option 2)

The same bytes as many update rows, and folded into one row.

| Case | Rows | Log | As rows | Folded |
| --- | ---: | ---: | ---: | ---: |
| Light text | 200 × 2 KiB + 256 KiB state | 0.6 MiB | 9 ms | 10 ms |
| Busy text | 2,000 × 2 KiB + 1 MiB state | 4.9 MiB | 75 ms | 37 ms |
| Office | 300 × 48 KiB + 4 MiB state | 18.1 MiB | 208 ms | 219 ms |
| Heavy Office | 1,200 × 48 KiB + 12 MiB state | 68.2 MiB | 636 ms | 670 ms |

- The copy costs about 10 ms per MiB, whatever the row count. Folding helps
  only for thousands of tiny rows (busy text, twice as fast), and there the
  whole copy is under 0.1 s.
- A real fold could also shrink the bytes, but only where the log holds
  history the folded state no longer needs. These runs use random bytes, so
  they show the row count's share alone.

## Findings

1. **Option 1 is worth building.** The index copy is the cost. As a tracked
   background step, the request returns in well under a second even for a
   heavily edited Office file, and the index arrives later in the transfer
   panel.
2. **Option 2 is not, unless folding shrinks the bytes.** Row count barely
   matters. A fold would pay off only if it cut a heavy file's log well
   below its saved size, which would need measuring with real Office logs
   (collaboration-rs folds a room's log on reopen).
3. Batching commits, as in the 2026-10-25 gateway session's group-commit
   discussion, would not help here: the time is the copy and the index
   inserts, not the commit.

Not measured: the thumbnail copy (one storage call), cross-space clones (an
ingest job: parse and embedding, paid in credits), and real Yjs logs.
