# Gateway files and paged lists, 2026-10-25

Follow-up to the [2026-10-24 capacity run](2026-10-24-gateway-capacity.md),
whose users had no uploads and no list past its first page. This run gives
them files through the real upload flow, makes one user in a hundred heavy
enough to page through every list, and signs thumbnail links the way B2 does.

## Short version

- **Files and long lists cost little per request, and capacity holds.**
  With 74,040 files (every row's thumbnail link signed as B2 does) and heavy
  users reading every page, the same steps as 2026-10-24 still pass: 4,500
  users arriving over 5 minutes at 622 requests a second, with the gateway
  and Postgres at 0.67 cores each. The tail doubles, from p95 67 to 123 ms
  and p99 186 to 329 ms, because the list pages are heavier requests than
  the ones they replace.
- **No list slows down as the user scrolls.** Every page of every list costs
  about the same as the one before, page 7 of the files list included, and
  the offset-paged attempts list costs 4 ms at page 8 as at page 1.
- **One page costs 4-26 ms on an idle stack**, nearly all of it in Postgres.
  The dearest are the sorts on computed columns: files by workspace (17-26
  ms a page; the shown workspace name is computed for every one of the
  user's files on every page) and Blocks by updated (10-18 ms, the lost-access
  check per row). They grow with the user's own rows, not with everyone's.
- **A full workspace's file list** (100 files, 100 signed thumbnail links)
  costs 5 ms; signing is not where the time goes.
- **Uploads are Postgres-bound**: about 8 ms of statement time per file at
  low load, 3.7 ms of it the `files` insert and its triggers, and about 14 ms
  of Postgres CPU each under load, so one Postgres core takes about 65 files
  a second. Seeding 76,934 files took 20 minutes at that rate.

## Setup

Same box, cores and stack as the 2026-10-24 run, on the code after its fixes
(a0553a62e, 373e86ba4), with these changes to the bench:

- **Blob store:** the gateway's B2 client against the collaboration stress
  test's fake S3 (`bench/collaboration/scripts/fake-s3.mjs`, in memory, behind
  `s3.bench.backblazeb2.com` with a throwaway certificate, `tls.sh`), so
  uploads stream to "B2" and list rows get hour-stable presigned thumbnail
  links (about 15 µs of signing each, openwiki/thumbnails.md) instead of the
  memory store's constant URL.
- **Files** (`loadgen seed-files`), each through the gateway's ticketed line
  and multipart upload as the browser sends them (src/api/uploadTurn.ts),
  store-only (`parseMode: none`, no ingest):
  - every user: three files in each of their two workspaces, two PDFs and a
    DOCX (`fixtures/lecture.pdf`, 2.4 KB; `fixtures/report.docx`, 1.5 KB);
  - every Office file: a thumbnail capture posted to `/api/files/{id}/thumbnail`
    as its editor would (`fixtures/thumbnail.webp`);
  - every PDF: the key ingest's render would set (`thumbs.sh`, the worker's
    `UPDATE files SET thumbnail_key`), since the bench runs no ingest; the
    objects are not written, as list rows only sign the key.
- **Heavy users**, user ids divisible by 100 (60 of 6,000), filled within the
  Free plan's caps: seven workspaces of 100 files (700), 50 more notes in each
  (about 360 materials), 150 quiz attempts, 40 finished review sessions (cards
  rated under the session as src/routes/ReviewSession.tsx does), 150 images
  uploaded into one note (the Embeds tab), and 60 files and 60 notes deleted
  into the trash.
- **Sessions:** two new actions, and paging where the lists page:
  - opening a PDF (8% of actions): its row, then its links and annotations;
  - the Files page (5%), outside the workspace: one tab and sort (files by
    added, name, workspace or size; Blocks by updated, title or workspace;
    Embeds; Trash), one or two pages for most users, every page for a heavy
    user, and one visit in twenty a select all, which loads every page at
    once (`collectSelectionPages`);
  - Learning: a heavy user reads All results (attempts, 30 to a page by
    offset) to the end, and a third of visits open Past reviews.
- **`loadgen pages`**: every list of each heavy user read to its end, one
  request at a time on an otherwise idle stack, so each page's time is its
  own cost. `pages.py` tabulates it.

## Seeding

The seed is a measurement of its own: 240,901 requests in 19 min 45 s (203 a
second, 32 users at a time) for 76,934 uploads, 25,507 Office captures,
20,650 notes, 8,850 embeds and the heavy users' history, with no error.
Postgres sat at about 93% of its core throughout, against 65% for the
gateway (see [Uploads](#uploads)). Under that load the multipart upload's median was 176 ms (p95
594 ms) and its ticket's 105 ms. All 74,040 live files had a thumbnail key at
the end: the Office files' from their captures, the PDFs' from `thumbs.sh`.

## Per page

`loadgen pages` read every list of the 60 heavy users to its end, one request
at a time, nothing else running: about 8,100 requests in 92 s. Median / p95 in ms
per page, through the whole gateway (token check, account read, rate
limiter, query, JSON, thumbnail signing). Files lists hold 640 live files
(7 pages of 100), Blocks about 310 materials, Embeds 150, Trash about 120,
All results 152-218 attempts (6-8 pages of 30), Past reviews 40.

| List | p1 | p2 | p3 | p4 | p5 | p6+ |
| ---- | --- | --- | --- | --- | --- | --- |
| `/api/attempts` | 4 / 7 | 4 / 7 | 4 / 6 | 4 / 7 | 4 / 5 | 4 / 5 |
| `/api/editor-assets` | 25 / 45 | 5 / 26 | 5 / 25 | 4 / 24 |  |  |
| `/api/files sort=added` | 19 / 50 | 11 / 24 | 11 / 30 | 11 / 23 | 10 / 20 | 7 / 12 |
| `/api/files sort=name` | 17 / 34 | 11 / 21 | 9 / 20 | 9 / 20 | 8 / 19 | 7 / 11 |
| `/api/files sort=size` | 15 / 25 | 8 / 21 | 8 / 20 | 8 / 21 | 8 / 19 | 6 / 11 |
| `/api/files sort=workspace` | 26 / 35 | 22 / 38 | 21 / 38 | 20 / 36 | 19 / 37 | 17 / 25 |
| `/api/files?scope=member` | 7 / 12 | 6 / 13 | 6 / 11 | 6 / 11 | 6 / 10 | 5 / 8 |
| `/api/materials sort=title` | 13 / 31 | 5 / 16 | 5 / 15 | 5 / 15 | 5 / 19 | 4 / 10 |
| `/api/materials sort=updated` | 18 / 30 | 14 / 26 | 12 / 24 | 11 / 24 | 11 / 25 | 10 / 21 |
| `/api/materials sort=workspace` | 21 / 33 | 11 / 42 | 10 / 40 | 10 / 33 | 9 / 33 | 8 / 14 |
| `/api/materials?scope=member` | 10 / 16 | 9 / 14 | 8 / 15 | 8 / 12 | 8 / 13 | 8 / 12 |
| `/api/review/sessions` | 6 / 13 | 6 / 12 |  |  |  |  |
| `/api/trash` | 6 / 12 | 6 / 12 | 3 / 11 |  |  |  |

- **No list gets slower as the user scrolls.** The cursor lists cost the
  same at page 7 as at page 2, and the offset-paged attempts list costs 4 ms
  at every page up to 8 (an `OFFSET` of 210 rows is nothing at this size).
- **Page 1 costs 1.5-5 times a later page.** In Postgres a first page's
  statement took about 20 ms against 4-5 ms for a cursor page. Most likely
  the first request reads the user's rows into Postgres's buffers (the
  database is 684 MB, five times `shared_buffers`) and the next pages find
  them there; this was not checked further.
- **A full workspace's file list** (`GET /api/workspaces/{id}/files`, 100
  files, every row's thumbnail link signed) costs 5 ms median, 10 ms p95: the
  signing is not visible at this size.
- **Sorting by workspace is the dearest list**, 17-26 ms at every page of the
  files list, against 7-11 ms by date added. `pages-statements.json` (the
  same probe with `pg_stat_statements` loaded) puts nearly all of it in
  Postgres: 16 ms per cursor page by workspace against 4-5 ms for the other
  sorts. The sort key is each row's shown workspace name
  (`workspaceNameSQL`, a correlated subquery for the owner's account state),
  so every page computes it for every one of the user's files before sorting
  them. The same holds for Blocks sorted by updated (`lostMaterialSQL` per
  row, 9.5 ms per page in Postgres) and by workspace (8.9 ms). It is linear in
  the user's own rows, so a Free account's cap (10 workspaces of 100 files)
  bounds it at about 25-30 ms a page.

## Under load

The 2026-10-24 steps again (pool 8, nothing left out), now with the files,
the heavy users and the new actions; the "without files" columns are that
day's fixed-code runs.

| Users | Ramp, measured | Req/s | p95 | p99 | Without files: p95 / p99 | Gateway CPU | Postgres CPU | Waited | Verdict |
| ----- | -------------- | ----- | --- | --- | ------------------------ | ----------- | ------------ | ------ | ------- |
| 1,000 | 1 min, 2 min   | 157   | 15  | 24  | 14 / 22                  | 0.28        | 0.30         | 16 s   | pass    |
| 3,000 | 2 min, 5 min   | 414   | 64  | 218 | 26 / 73                  | 0.52        | 0.53         | 50 s   | pass    |
| 4,500 | 5 min, 5 min   | 622   | 123 | 329 | 67 / 186                 | 0.67        | 0.67         | 565 s  | pass    |

None had errors. The requests a second and the CPU per request are within
a few percent of the runs without files; what changed is the tail. The list
pages (10-25 ms of Postgres each, against about 1 ms for the average
request) hold a connection and a share of each core longer, and the slowest
routes became the heavy reads they delay. At 4,500 those were a deck or a
quiz (`GET /api/flashcards/{id}`, `/api/quizzes/{id}`), a note, the review
overview and the Study tab at p95 253-305 ms; at 3,000 Blocks by updated and
files by workspace on their last pages were among them at 166-182 ms.

## Uploads

20 fresh users uploading their six files each, four at a time, with
`pg_stat_statements` on (`statements-uploads.txt`): 1,055 ms of Postgres
statement time for 120 uploads and 40 captures, about 8 ms per upload.

| Statement | Calls | Mean |
| --------- | ----- | ---- |
| `INSERT INTO files` (with its storage, blob-reference and tree triggers) | 120 | 3.72 ms |
| `INSERT INTO upload_sessions` | 120 | 1.74 ms |
| `UPDATE upload_sessions` (complete) | 120 | 0.64 ms |
| `UPDATE files SET thumbnail_key` (a capture) | 40 | 1.16 ms |
| account and workspace checks, batch, storage and count reads | 4,000+ | 0.01-0.12 ms |

Through the gateway the multipart upload took 24 ms median and its ticket
9 ms. At the seed's 32 users at a time Postgres spent about 14 ms of CPU per
upload in all (commits, the tree events' notifications), which is where its
65 files a second on one core came from. A class of 300 uploading ten files
each in the same minute would queue for about 45 s.

## What this suggests

1. **Nothing urgent for paging.** Cursor and offset paging both hold their
   cost to the end of these lists.
2. **The computed sorts are the ones to watch** as accounts grow (files by
   workspace, Blocks by updated and by workspace). A plan with more than the
   Free cap of 1,000 files would pay for each page in proportion; a stored
   sort key (the shown workspace name, the effective update time) with an
   index on (owner, key) would make a page an index range read.
3. **Uploads at a class's scale** are bounded by the `files` insert and the
   upload-session rows (about 6 ms of the 8). Worth a look before a school
   has many classes uploading at once; not a limit at today's numbers.

## Not covered

- **Downloads and Office.** The file bytes go from B2 to the browser, and
  Office files open through the collaboration service; neither is the
  gateway's cost. The fake B2 keeps objects in memory, so after the stack
  stops the seeded bytes are gone (rows and keys stay, which is all the
  lists read).
- **Ingest.** Store-only uploads queue no parse; a parsed upload also
  creates its job rows and, later, its chunks and thumbnail.
- **Search** (`GET /api/search`, also signing file rows), which still uses
  the `OR` filter of the 2026-10-24 report.
- **Plans past Free.** Every user here is on Free, so no list is longer than
  its caps allow.

## Reproduce

From `bench/gateway/scripts` on the bench host, after the 2026-10-24 setup
(6,000 users):

```sh
./tls.sh
RATE_LIMIT_DISABLED=true docker compose up -d --build
docker compose exec loadgen /loadgen seed-files -users 6000 -parallel 32
docker compose exec loadgen /loadgen seed-history -users 6000
./thumbs.sh
docker compose up -d server          # the rate limiter back on
docker compose exec loadgen /loadgen pages -users 6000
python3 pages.py ../.results/pages-0-6000.json
./step.sh 3000 2m 5m
```

`seed-history` tops up what a heavy user's `seed-files` did not finish (here
the review sessions, at first rating only cards when the batch was all
questions). Raw records: `2026-10-25-production-box/`.
