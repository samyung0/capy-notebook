# Go gateway capacity on the production box, 2026-10-24

The first load test of the Go gateway (`bench/gateway`): signed-in browser
tabs replayed against the API, with the pool at the planned 8 connections.
The question was how many users one gateway serves and whether the pool is
what limits it. It is not. Two queries that read every user's rows limit it
first, and the more people sign up the lower the limit gets. Both are fixed
in the same change (the member lists rewritten in `listing.go`, migration
0113), and the fixed code was measured too.

## Short version

- **As shipped, the limit is how fast people sign in, and it falls as the
  user base grows.** On this box (one core for the gateway, one for
  Postgres and Redis, 6,000 users' data), 1,000 users arriving over 5
  minutes (3.3 a second) pass with p95 19 ms; 500 arriving over 1 minute
  (8.3 a second) fail with p95 1.7 s while the gateway uses 0.18 cores.
  Steady load costs Postgres 3.5 ms of CPU per request (1.0 ms with the
  fixes below), which would fill its core at about 2,000 users (an
  extrapolation, not measured).
- **The cause is the dashboard's materials list** (`GET /api/materials?
  scope=member`, `ListOwnedMaterials` with `Member`,
  `server/internal/store/listing.go:241`), which every sign-in calls.
  - Its `OR` across three joined tables (`m.owner_user_id`, `w.user_id`,
    workspace membership) has no index path. Each call reads every material
    in the database (60,101 rows) to return the user's 10: 117-144 ms on an
    idle database.
  - The cost grows with the total, not with the user's own rows, so every
    new account lowers the ceiling for everyone.
  - While those calls run they hold the pool's connections. At 1,000 users,
    about 600 requests queued for a connection behind 7 of them and timed
    out at 10 s. Every route failed, `/api/me` included, while the gateway
    used a quarter of its core.
  - The same three ways a row is visible, written as a `UNION` of index
    lookups, return the same rows in 1-4 ms. The change does this for the
    materials and the files list (`visibleWorkspacesSQL`).
- **The next one is learning progress** (`GET /api/learning/progress`,
  `LearningProgress`, `server/internal/store/learning_progress.go:74`).
  - The shell asks for it on every page and refetches it after every card
    rating and quiz submission. It was 70% of Postgres's statement time in
    the diagnostic step.
  - No index on `study_progress` starts with `user_id` usable here (the two
    that do are partial, on `file_id` and `material_id`), so each call
    reads every user's progress (13,782 rows): 2-6 ms now, growing with
    every rating anyone records.
  - An index on `study_progress (user_id, workspace_id)` makes it 0.47 ms
    (migration 0113).
- **With both fixed, one gateway core and one Postgres core hold 4,500 to
  5,000 users.** 4,500 arriving over 5 minutes pass at 599 requests a
  second (p95 67 ms, p99 186 ms); 5,000 are at the edge (p95 403 ms, p99
  1.19 s). There the two cores saturate together, at about 1.1 ms of
  gateway CPU and 1.0 ms of Postgres CPU per request. 1,000 users arriving
  in one minute, which stalled as shipped, pass with p95 14 ms.
- **The pool: 8 is worth having over today's 4; more than 8 is not, on one
  gateway core.**
  - At 2,000 users (the dashboard call left out), 4 connections gave p95
    377 ms and p99 847 ms against 49 and 129 ms with 8.
  - At 3,000 users, 16 connections changed nothing (p95 2.07 s against
    2.22 s). There the waits for a connection come from the single gateway
    core: a goroutine holding a connection queues for CPU before it can
    send its query or read the answer.
- **Sign-in bursts are their own limit.** An arriving user sends about 25
  requests within a few seconds (sign-in, dashboard, workspace, the event
  stream's refetches). 2,500 users arriving over a minute (42 a second)
  pushed p95 over 1 s for 15 s after the ramp; the rest of the run was
  fine.
- **The dashboard's files list had the same `OR` shape** (`ListOwnedFiles`
  with `Member`) and is fixed the same way, unmeasured: the bench users have
  no uploaded files. Global search (`Store.Search`, `queries.go:82`, `:106`,
  `:141`) still filters with that shape; the workload does not search.

## Setup

- **Box:** the production box (4 vCPU AMD EPYC-Rome at 2.0 GHz, 7.6 GiB RAM,
  Docker 29.4.1). Nothing of Capy is deployed there; Coolify and its
  Traefik ran beside the bench, unpinned and mostly idle.
- **Code:** the working tree of `wip/pc-ui-2026-10-23` at 3879db191 plus
  this run's changes (the `loadtest` build files and the pool-wait log in
  `server/cmd/api`; for the "Fixed in code" steps also the listing rewrite
  and migration 0113), copied to the box and built there.
- **Stack:** `bench/gateway/scripts/docker-compose.yml`, Compose project
  `capy-gwbench`:
  - Postgres `pgvector/pgvector:0.8.7-pg16` and Redis `7.4.11-alpine`,
    production's digests and default settings (`shared_buffers` 128 MB,
    `synchronous_commit` on);
  - the gateway built with `-tags loadtest`, `APP_ENV=e2e` (memory blob
    store), Clerk on through the generator, the rate limiter on, Sentry on
    at production's 10% trace sample rate (reports to the generator), the
    bank configured (reads of an empty bank never reach its database);
  - the pool at `pool_max_conns=8` (production's is pgx's default, 4 on
    this box), 16 and 4 where marked.
- **Cores:** the gateway on 0, Postgres and Redis on 1, the generator on 2-3.
  In production the gateway and Postgres share all four cores with Redis,
  cloudflared and retrieval (the collaboration service is pinned to 2-3), so
  each may get more than one core there.
- **Data:** setup provisioned 6,000 users through the Clerk path (account and
  starter workspace, 5 min 43 s at 332 requests a second, no errors), then
  gave each a second workspace with three notes, a quiz of six true/false
  parts and a set of twelve cards in each, and one attempt per quiz:
  12,000 workspaces, 60,000 materials, 94 MB at 3,170 users.

## Workload

Each simulated user is one browser tab (`loadgen/scenario.go`), replaying
what the frontend sends, mapped from `src/` on this date:

- sign-in lands on the dashboard: `/api/me`, the shell (unread count, bank
  progress, learning progress), the workspace list, the dashboard's files,
  materials and thinking lists, then an event stream;
- the user then works in one of their workspaces for 4 to 11 actions
  before going back to the dashboard: open a note (35%), take a quiz (15%),
  study cards with a rating per card (15%), Learning (8%), the Study tab
  (7%), create a note (5%), rename one (6%), notifications (9%); 30% of
  actions start with a window refocus (`/api/me`);
- every move into or out of a workspace reconnects the event stream, which
  refetches the lists on open, and on `tree` and `notification` events;
- each list follows react-query's five-minute staleness, and the pages that
  fetch twice do so;
- think time is exponential: 90 s on a note, 60 s before submitting a quiz,
  6 s per card, 30 s on Learning, among others.

This came to 0.14-0.18 requests a second per user (one every 6-7 s), against
one every 10 s in the video that prompted the test. Chat, uploads, Office
and the question bank's pages are left out: their cost is in other
services.

A step starts its users over the ramp, measures for the duration, and
passes on p95 < 500 ms, p99 < 1 s and fewer than 1% failed requests.

## Results

CPU is the mean share of one core over the measured window; "waited" is
the time requests spent waiting for a pooled connection, summed.

### As shipped

| Users | Ramp, measured | Req/s | p50 | p95 | p99 | Errors | Gateway CPU | Postgres CPU | Waited | Verdict |
| ----- | -------------- | ----- | --- | --- | --- | ------ | ----------- | ------------ | ------ | ------- |
| 250   | 2 min, 5 min   | 30    | 5   | 13  | 20  | 0%     | 0.08        | 0.17         | 0.4 s  | pass    |
| 400   | 2 min, 5 min   | 50    | 5   | 14  | 23  | 0%     | 0.12        | 0.22         | 0.7 s  | pass    |
| 1,000 | 5 min, 5 min   | 127   | 6   | 19  | 37  | 0%     | 0.24        | 0.44         | 6.6 s  | pass    |
| 500   | 1 min, 2 min   | 90    | 7   | 1,672 | 4,223 | 0.14% | 0.18     | 0.28         | 9,922 s | fail   |
| 1,000 | 1 min, 2 min   | 174   | 7   | 9,303 | 10,001 | 4.71% | 0.25    | 0.39         | 59,613 s | fail  |

The dashboard materials call was the slowest route at every step (p95
213-448 ms where the steps passed). Each sign-in calls it once, at about
120 ms of Postgres CPU, so the arrival rate decides: 3.3 a second passed at
1,000 users, 8.3 a second failed at 500. At 1,000 users the errors are the
generator's 10 s timeouts, spread over every route. A goroutine dump taken
in that state ([below](#how-the-pool-stalls)) shows why.

### Dashboard materials call left out (`-skip "GET /api/materials"`)

| Users | Pool | Ramp, measured | Req/s | p50 | p95 | p99 | Gateway CPU | Postgres CPU | Waited | Verdict |
| ----- | ---- | -------------- | ----- | --- | --- | --- | ----------- | ------------ | ------ | ------- |
| 1,000 | 8    | 1 min, 2 min   | 155   | 5   | 16  | 26  | 0.28        | 0.35         | 13 s   | pass    |
| 2,000 | 8    | 1 min, 2 min   | 330   | 7   | 49  | 129 | 0.45        | 0.54         | 878 s  | pass    |
| 2,000 | 4    | 1 min, 2 min   | 332   | 9   | 377 | 847 | 0.46        | 0.54         | 4,434 s | pass   |
| 2,500 | 8    | 1 min, 2 min   | 426   | 11  | 730 | 1,341 | 0.52      | 0.62         | 9,715 s | fail   |
| 3,000 | 8    | 1 min, 2 min   | 539   | 25  | 2,216 | 3,476 | 0.60    | 0.70         | 33,802 s | fail  |
| 3,000 | 16   | 1 min, 2 min   | 537   | 25  | 2,069 | 3,327 | 0.59    | 0.73         | 34,218 s | fail  |

None of these steps had errors. The repeated 2,500 step (the diagnostic
one, below) had its slow seconds only at the start: 15 of 121 measured
seconds had a p95 over 500 ms, all in the first 15, at 900-1,176 requests
a second against 428 over the step. That is the tail of the ramp, 42 new
users a second, not the steady load.

### Both fixes approximated

The learning-progress index was created in the bench database
(`CREATE INDEX study_progress_user_idx ON study_progress (user_id,
workspace_id)`) and the dashboard materials call left out, which is what
the rewritten query would cost to within a few milliseconds per sign-in.
Pool 8.

| Users | Ramp, measured | Req/s | p50 | p95 | p99 | Gateway CPU | Postgres CPU | Waited | Verdict |
| ----- | -------------- | ----- | --- | --- | --- | ----------- | ------------ | ------ | ------- |
| 3,000 | 2 min, 5 min   | 395   | 5   | 28  | 83  | 0.52        | 0.51         | 28 s   | pass    |
| 4,000 | 2 min, 5 min   | 535   | 7   | 764 | 1,718 | 0.62      | 0.61         | 81 s   | fail    |
| 5,000 | 5 min, 5 min   | 657   | 9   | 209 | 540 | 0.70        | 0.68         | 1,030 s | pass   |
| 6,000 | 5 min, 5 min   | 783   | 61  | 1,473 | 2,773 | 0.80    | 0.76         | 5,280 s | fail   |

At 4,000 all 25 slow seconds were the first 25 after the ramp (33 new users
a second). From 40 s on the step held 484 requests a second with a median
per-second p95 of 19 ms and a worst of 126 ms. At 3,000 (25 new users a
second) no second was slow. With the users arriving over 5 minutes (17 and
20 a second), 5,000 passed with both cores at 0.91 at p95 and 11 slow
seconds, and 6,000 failed with 74: about 5,000 users and 650 requests a
second is the ceiling for one gateway core and one Postgres core at this
workload. There the two cores saturate together, as each request costs
about 1.1 ms of gateway CPU and 1.0 ms of Postgres CPU.

### Fixed in code

The member lists rewritten (`visibleWorkspacesSQL` in `listing.go`, the
materials list filtering on `m.id IN (standalone rows UNION ALL rows of the
visible workspaces)`, the files list on `f.workspace_id IN (...)`, the
unused joins dropped) and migration `0117_study_progress_user_idx.sql`,
which the gateway applied to the bench database at start. Nothing left out
of the tabs. Through the gateway the dashboard materials call took 3-31 ms
and learning progress 5-8 ms on single calls, against 125 ms and more
before.

| Users | Ramp, measured | Req/s | p50 | p95 | p99 | Gateway CPU | Postgres CPU | Waited | Verdict |
| ----- | -------------- | ----- | --- | --- | --- | ----------- | ------------ | ------ | ------- |
| 1,000 | 1 min, 2 min   | 155   | 5   | 14  | 22  | 0.28        | 0.29         | 13 s   | pass    |
| 3,000 | 2 min, 5 min   | 397   | 5   | 26  | 73  | 0.52        | 0.52         | 28 s   | pass    |
| 4,000 | 2 min, 5 min   | 539   | 7   | 1,070 | 2,354 | 0.62    | 0.61         | 160 s  | fail    |
| 4,500 | 5 min, 5 min   | 599   | 7   | 67  | 186 | 0.66        | 0.65         | 616 s  | pass    |
| 5,000 | 5 min, 5 min   | 662   | 10  | 403 | 1,193 | 0.71      | 0.70         | 915 s  | fail    |

The 1,000-user step is the one that stalled as shipped (p95 9.3 s, 4.7% of
requests timed out); the dashboard materials call is no longer among the
slowest routes. 3,000 matches the approximation above (p95 28, p99 83).
At 4,000 the 28 slow seconds were again the first 28 after the ramp. At
5,000 the real code missed on p99 where the approximation passed (540 ms):
it still sends the dashboard materials call, now cheap, and both cores were
at 0.85-0.93 at p95, where small differences decide. 4,500 passed with no
slow second.

### Idle tabs

6,000 tabs (every user) signed in, opened a workspace and then only held
its event stream (`run -idle`). Over the 154 s after the last request:

| | Gateway | Postgres |
| --- | --- | --- |
| CPU | 0.17 cores (p95 0.19) | 0.17 cores (p95 0.23) |
| Resident memory | 803 MiB | 665 MiB |

Each stream re-checks the session and the workspace every 25 s
(`sse_events.go:188`): two queries, 480 a second for 6,000 tabs, about
0.03 ms of gateway CPU and 0.36 ms of Postgres CPU per query. At the
gateway's cap of 10,000 streams (`maxEventStreams`) that is about 0.28
cores of the gateway and 0.29 of Postgres for tabs doing nothing. The
resident memory includes what the ramp left behind; the live heap of idle
streams was not measured.

## How the pool stalls

At 1,000 users as shipped, with every connection taken, a goroutine dump
(`SIGQUIT`) of the gateway's 1,284 goroutines showed:

- 7 holding a connection, all in `ListOwnedMaterials`, the dashboard
  materials list, with Postgres running the same statement on 6 of the
  8 backends;
- about 600 waiting in `pgxpool` for a connection: 141 in the auth
  middleware's account read (`ClerkSession`), and 27-52 each in the unread
  count, thinking canvases, workspace list, learning progress, bank
  progress, files list and permission checks;
- 624 in network wait (open event streams and keep-alive connections).

So a slow statement on one route takes every route down: each request
needs a connection for its account read before the handler runs, and no
route has its own pool or a bound on how long it waits for one other than
the client's patience.

## Where the time goes

Postgres, from `pg_stat_statements` over the 2,500-user diagnostic step
(dashboard call left out, no index):

| Calls | Total | Mean | Statement |
| ----- | ----- | ---- | --------- |
| 10,044 | 55.7 s | 5.55 ms | learning progress (`LearningProgress`) |
| 84,840 | 4.0 s | 0.05 ms | workspace role and share check (`workspaceRoles`) |
| 550 | 2.9 s | 5.33 ms | learning's workspace list with last-studied times |
| 33,040 | 2.2 s | 0.07 ms | material access check |
| 105,344 | 2.1 s | 0.02 ms | the auth middleware's account read (`ClerkSession`) |
| 4,478 | 1.8 s | 0.39 ms | latest rating per card (56% of it planning) |
| 11,759 | 1.6 s | 0.14 ms | `INSERT INTO review_log` |

Learning progress alone was 70% of the time of the top 20 statements.
Statements per request came to about 7: the account read, the plan tier
(`users` and `user_subscriptions`, 49,894 calls each), storage usage,
permission checks and the handler's own.

The gateway, from a 30 s CPU profile in the same step (0.44 cores sampled):

- 25-30% in system calls, most of it writing queries to Postgres (pgx sends
  each query in its own write);
- 11% verifying Clerk session tokens: 6% RSA, 5% go-jose parsing the
  claims' JSON;
- 7% garbage collection;
- a live heap of 124 MB at 2,500 users, of which 30 MB HTTP connection
  buffers, 13 MB event-stream subscriptions (`channelBroker.register`,
  about 7 KB per stream) and 35 MB in flight decoding material content into
  `map[string]any` to list study items (`store.materialItems`).

## What this suggests, in order

1. **Done in this change: the dashboard's member lists as unions of index
   lookups** (`ListOwnedMaterials` and `ListOwnedFiles` with `Member`,
   `visibleWorkspacesSQL`), keeping the rule (own workspaces, member
   workspaces under a live owner, own standalone rows) and dropping
   `memberWorkspace`. The store and httpapi suites pass.
2. **Done in this change: `study_progress` indexed by user** (migration
   0113) for learning progress.
3. **Raise the pool to 8**, as planned: at 2,000 users it is the difference
   between p95 49 ms and 377 ms. Past 8 it bought nothing on one gateway
   core; it would matter again with more gateway cores or a second replica.
4. **Re-check idle streams in one query per tick** for all of a process's
   streams (or have revocations published on the stream's Redis channel)
   instead of two queries per stream every 25 s: about 0.3 cores of each of
   the gateway and Postgres at 10,000 tabs.
5. **Spread sign-in bursts or make them cheaper.** An arrival costs about 25
   requests in a few seconds; above 25-30 arrivals a second the gateway and
   Postgres saturate for as long as the burst lasts. Most of those requests
   are the shell and the event stream's refetch of lists the loader has just
   fetched (the duplicates listed in the scenario).
6. **Bound the wait for a connection.** Nothing in the gateway gives up on a
   request before the client does. Behind Cloudflare that is 100 s, and the
   frontend retries a failed query twice, so a stall like the one above
   would hold requests far longer, and multiply them, than the generator's
   10 s timeout without retries shows.
7. **Check global search** (`Store.Search`), which still filters with the
   `OR` of ownership and membership across joined tables. It was not in the
   workload; ⌘K sends it as the user types.

Lesser costs seen on the way: about 7 statements per request, the plan tier
read twice per request, the Clerk token's claims parsed by go-jose's JSON
decoder (5% of gateway CPU), whole notes decoded into `map[string]any` to
list study items, and 6-10 ms to plan the dashboard materials statement.

## Not covered

- **Files.** The bench users have no uploads, so the files list (before
  and after its rewrite) and every file route cost nothing here.
- **Chat, uploads, Office, the question bank's pages and the collaboration
  service.** Their cost is in other services; a real user's chat turn also
  holds an SSE stream to the gateway while the model answers.
- **Data volume.** 6,000 accounts with 10 materials each. Both slow queries
  scale with the total, so a production database with more users, files and
  ratings would be slower than this.
- **Retries and long waits** (point 6).
- **cloudflared and Traefik in front.** The generator talks to the gateway
  directly over the Docker network, keeping a pool of keep-alive connections
  as cloudflared does. The 2026-10-04 collaboration run found cloudflared and
  Traefik at about 45% of the collaboration service's CPU.
- **More than one core for the gateway or Postgres**, as production allows.

## Reproduce

On a box with Docker (the production box here), from a copy of the
repository:

```sh
cd bench/gateway/scripts
./tls.sh    # since 2026-10-25 the stack's B2 is a fake S3 with this certificate
docker compose up -d --build
docker compose exec loadgen /loadgen setup -users 6000 -parallel 32
RAMP=2m DURATION=5m ./ladder.sh 250 400
RAMP=2m DURATION=5m ./ladder.sh 3000 4000 -- -skip "GET /api/materials"
./step.sh 6000 2m 3m -idle
python3 analyze.py ../.results/users-*
```

The diagnostic step layers `docker-compose.statements.yml` on the stack and
reads `statements.sql` after it; the gateway's profiles are at
`http://server:6060/debug/pprof/` inside the bench network. Raw results of
this run: the box's `bench/gateway/.results/`, summarized in
`2026-10-24-production-box/`.
