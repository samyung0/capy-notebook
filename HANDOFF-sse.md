# SSE and workspace-tree handoff

Written 10 September 2026 against working-tree changes on `main`, base commit
`d7644f6`. Nothing here is committed or deployed. The work started as one UAT
bug report and uncovered three separate problems behind it.

Every claim below was checked against a running system unless it says otherwise.
Two things could not be verified locally and are named in
[What is not verified](#what-is-not-verified).

## Current position

Opening a workspace on `uat.capynotebook.com` returned
`GET /api/workspaces/{id}/ingest-events 401`. The cause was in the application,
not the deployment: the ingest stream used `EventSource`, which cannot set an
`Authorization` header, while the gateway verifies Clerk tokens with
`clerkhttp.WithHeaderAuthorization()` and has no cookie fallback. The request
always arrived anonymous.

Confirmed at the origin rather than the edge. An unauthenticated request returns
the gateway's own `writeUnauthorized` body:

```
HTTP/2 401
{"message":"unauthorized"}
```

Three environments hid it. Local development runs `AUTH_DISABLED`, MSW makes the
stream a no-op, and the E2E fixture injects identity headers with a Playwright
route interceptor, so even `EventSource` got credentials under test. UAT was the
first place with real Clerk in a real browser.

The 401 was not silent. `ConnectionBanner` treats `ingestStream.status ===
'disconnected'` as a connectivity fault, so every workspace page in UAT was
showing a permanent "Reconnecting…" warning.

Two further problems surfaced while fixing it. The stream opened on every
workspace view whether or not anything was ingesting, and the notification
stream carried a hard ceiling of 100 concurrent streams process-wide.

## What changed

### The 401

`useIngestProgress` now reads the stream with `fetch` and `authHeaders()`
through the existing `consumeSSE`, which is the path `notificationStream.ts`
already used. Reconnect and backoff are unchanged; unmount aborts rather than
closing. Each reconnect mints a fresh token, and because `liveWorkspaceContext`
re-checks access for the life of the stream, a token expiring mid-stream no
longer matters.

`sseData` moved into `src/api/sse.ts` and is shared with the notification
parser. It drops the `: ping` and `: connected` comment frames that
`EventSource` used to filter for free — the failure this would otherwise cause
is silent, since a comment frame parses as an empty payload rather than an
error.

`ingest-events` was the last `EventSource` in the tree. `chatStream.ts` and
`notificationStream.ts` were already on `fetch`, so no sibling remains broken.

### Stream lifetime

The stream now opens only while a file is `pending` or `processing`, derived
from the files the page passes into the hook, keeping the page's primary query
error policy. That window is exactly
upload-and-import-in-flight: the upload mutation inserts the new file as
`pending` before ingest starts, so an upload opens it with no extra signal, and
a reload mid-ingest is covered because the status comes from the server.
Store-only uploads insert as `ready` and never open it.

An action-based trigger was rejected because it misses a reload during ingest
and a collaborator's upload.

Automatic reparse and reindex never open the stream, and this is a property of
the data rather than a policy: `RequestSourceRefresh` leaves `files.status` at
`ready` for the whole job and only writes `indexed=true, status='ready',
revision=revision+1` at publish (`source_refresh.go:301`). The worker still
publishes progress for those jobs; with no subscriber, the Redis publish is a
no-op. No pipeline change was made or needed.

### Polling and the list endpoint

Once the stream is gated shut, the workspace tree has no live signal, and both
files and materials can appear from work the tab did not start.

`ListFiles` returned `content`, an unbounded `text` column holding the whole
body for text sources. It now uses `fileListCols` and returns refs only;
`GetFile` still carries the body. This follows `ListMaterialRefs`, which was
already ref-shaped — files was the outlier, so this is not a new pattern.
`Files.tsx` was the one caller rendering a viewer from list data and now fetches
the full row when its dialog opens. Failed detail requests show the existing
file error panel with a manual Retry action.

`useFiles` and `useMaterials` poll at 30s with `refetchOnWindowFocus`. The
options sit on the hooks, not the query factories, because `RecentItemsCard`
spreads `materialsQuery` across every workspace on the dashboard and must not
poll them all. `refetchIntervalInBackground` stays false, so a background tab is
idle.

The MSW list handlers strip `content` too, so a viewer that forgets to fetch the
full row now fails in development instead of only in production. That
divergence is what let the original bug through.

No OpenAPI or client regeneration: `content` was already optional, so the wire
schema is unchanged. The contract lives in the `File.Content` doc comment and
the test below.

### The notification cap

`maxNotificationStreams` was 100 process-wide. Neither the code nor the plan
that introduced it recorded a reason for that number.

What is verifiable is the cost. `Client.pubSub` routes through
`pubSubPool.NewConn`, so every `Subscribe` held its own TCP connection to Redis.
`server/internal/httpapi/fanout.go` replaces that with one
`PSUBSCRIBE ingest:*, notif:*` per process and an in-memory
`map[channel]→subscribers`. Both handlers now call `broker.subscribe`.
`subscribe` waits for Redis to confirm the pattern before returning, so a caller
cannot miss an event published immediately after it starts listening.

**The reviewer's attention belongs here.** Sharing one subscription means one
goroutine now feeds every stream, so it must never block. Previously a client
that stopped reading parked only its own goroutine in `Fprintf`; with a fanout,
a blocking send would queue every other user behind that one socket and then
overflow go-redis's internal buffer, dropping messages for everybody. Sends are
therefore non-blocking against a 64-slot per-stream buffer, and a stream that
fills its buffer is evicted rather than waited on.

Both clients reconcile current state on every connect. Notifications refetch
from Postgres because Redis Pub/Sub is not durable. Ingest re-reads the file
list, and list reads invalidate cached file details still marked pending or
processing when the server reports ready or failed. This also covers completion
discovered by polling. These reads recover current state, not intermediate
progress events. Removing reconciliation would leave missed events unrecovered.

A review found that an initial Redis subscription failure survived a successful
retry in `broker.failed`. The broker now clears that failure before announcing
readiness; the Redis integration test exercises recovery and subsequent delivery.

The cap is now 10,000, and a refusal logs `notification stream refused at
capacity`. It previously refused silently, with the browser falling back to 30s
polling and nothing else surfacing it.

## Evidence

`cmd/testdb` now starts a disposable Redis alongside Postgres and exports
`CAPY_GO_TEST_REDIS_URL`, so the fanout guarantee is exercised on every
`pnpm test:go` rather than by hand. Against that Redis, with 203 open streams:

```
connected_clients before=2 after 200 more streams=2
```

`PUBSUB NUMPAT` is 2. Routing was checked in the same test: `ingest:ws_1` and
`notif:u_1` each received their own message and `ingest:ws_2` received nothing.

A unit test stalls one subscriber, drains another, and asserts that delivery to
the attentive stream continues, the stalled one is evicted, and `deliver` never
blocks. A second asserts a stopped reader ends every stream rather than leaving
handlers parked.

`file_list_content_test.go` covers both `ListFiles` branches returning no
`content` while `GetFile` keeps it. `workspaceTreePolling.test.ts` pins the
query factories poll-free so nobody moves the interval and fans it across the
dashboard. It also checks that list reads refresh stale details on ready or
failed transitions, then stop fetching the completed body.

In a real browser against MSW, the file list came back with no `content` on any
row and the markdown file rendered through a separate `GET /api/files/f_2`.

The original Go suite passed across 20 packages. After the review fixes,
the fanout and notification tests pass with `-race`, including Redis recovery.
`pnpm test` passes at 61 source files, 293 tests, plus 4 editor benchmark tests.
Typecheck and Biome are clean.

## What is not verified

The 30s interval was never observed firing. The in-app browser pane reports
`visibilityState: hidden`, so `refetchIntervalInBackground: false` correctly
paused it, and the Chrome extension was not connected to give a focused window.
The pause is confirmed; a tick landing is not.

The local browser still uses MSW, which short-circuits `useIngestProgress`.
`ingestProgress.test.ts` now runs its effect with real query observers and
response streams, checking fresh authentication, reconciliation on reconnect
after a missed completion, and cleanup when the final file becomes ready.
The real Clerk browser path still needs UAT verification.

## Open decisions

**10,000 is not a derived number.** With Redis connections no longer per-stream,
the real ceiling is the container's open-file limit, so the cap is only honest
if it sits below `ulimit -n` for the Coolify container. That value has not been
checked.

**The ingest stream still has no cap.** Tolerable when it was per-workspace and
rare, but it is unbounded now. A shared total across both stream types is
probably the coherent shape; scope was left alone rather than widened.

**Redis in `cmd/testdb` was beyond the original ask.** It is what makes the
fanout guarantee enforceable, but it adds a container to every Go test run and
is easy to back out.

## Reviewing this

Read `fanout.go` first, and read `deliver` and `evict` against the two
reconcile-on-connect paths they depend on. That is where a subtle break would
land.

Then check that `File.Content` is genuinely unused from list data — the
generated type marks it optional, so TypeScript will not flag a caller that
silently stops receiving it. This was checked by grep, not by the compiler.

`vendor/betteroffice` tests fail under vitest with `bun:test` import errors.
Pre-existing, confirmed by stashing; use `pnpm test`, not a bare `src/` glob.

Unrelated modifications are present in the tree and are not part of this work:
`README.md`, `human/miscellaneous.md`, `human/deployment-runbook.md`,
`openwiki/deployment-runbook.md`, `public/_headers`, and
`e2e/editor/playwright.editor.config.ts`.
