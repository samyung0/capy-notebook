# Files page one list (`GET /api/items`): query cost, 2026-11-09

The Files page now reads one list of files, submissions, blocks and embeds
(`store.ListItems`) instead of a tab per table. This is a single-query
measurement on the Mac, not a capacity run; the full `bench/gateway` rerun on
the bench host is queued for the Windows PC.

## Setup

Disposable Postgres from `go run ./cmd/testdb` (default settings), seeded by a
throwaway store test (cloned rows, not committed):

- 52,506 files, 52,023 materials, 19,801 embeds across 201 users and 220
  workspaces.
- One heavy user: 1,000 standalone and 1,000 workspace files, 1,500 blocks in
  its 10 workspaces, 800 embeds; editor in 10 other workspaces holding 3,000
  files and 3,000 blocks of other members (All files adds those).
- No submissions (they need marked attempts); that branch is an index scan of
  the caller's files that keeps none.

Each figure is the median of 15 calls of the store function (page of 40,
including the by-id reads of each row).

## Results

| Call | First version | Shipped |
| --- | --- | --- |
| Items, My files, newest, page 1 | 15.7 ms | 18.0 ms |
| Items, My files, newest, page 5 | 15.9 ms | 17.1 ms |
| Items, My files, name / workspace | 16.7 / 17.8 ms | 18.3 / 17.1 ms |
| Items, My files, kind=pdf | 6.8 ms | 7.4 ms |
| Items, All files, newest / name | 237.8 / 245.9 ms | 86.3 / 92.0 ms |
| Old Files tab, page 1 | 3.0 ms | |
| Old Files tab, All files | 46.3 ms | |
| Old Blocks tab (created) | 1.6 ms | |
| Old Embeds tab | 2.1 ms | |

What changed between the two columns:

- All files read `owner = me OR workspace IN (…)` per table, a full scan of
  `files` and `materials` (and JIT compilation on the plan's cost). It is now
  two branches per table, the caller's rows on the owner index and other
  members' rows on the workspace index.
- Embeds hashed the whole `materials` table twice to find each asset's note;
  a per-row `LATERAL … OFFSET 0` lookup by key takes 9 ms instead of 42 ms in
  the plan.

## Reading

- A page is never cut short by `LIMIT`: every row of the caller (≈4,300 here,
  ≈10,300 with All files) is computed and sorted on each page, so the cost
  grows with the caller's own volume, not with the page number. My files
  costs about what the four old tabs cost together; All files about twice the
  old files-only All files.
- `EXPLAIN ANALYZE` on the same SQL with the user id inlined plans above
  PostgreSQL's default `jit_above_cost` and spends 100–160 ms compiling; the
  calls through pgx above did not. Production runs default settings, so the
  bench rerun should confirm whether JIT fires there.
- A selection delete refetches the loaded pages after each item (one
  invalidation per delete), which multiplies this cost on Select all.

## Next

- Rerun `bench/gateway` on the bench host with `/api/items` in the replayed
  Files page (`scenario.go` `fileListPaths`, updated in this change) at the
  10-26 seeded volume, and look at per-route p95, Postgres CPU and whether JIT
  fires.
- If All files is too slow there: denormalised sort keys or a per-branch
  top-N with an index per sort.
