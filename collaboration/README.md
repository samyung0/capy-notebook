# Evo Notes collaboration service

Self-hosted Hocuspocus/Yjs authority for live Plate material content.

## Configuration

Local `pnpm dev` works with no env file: missing values fall back to the same
defaults as `deploy/docker-compose.yml` / the Go API
(`http://localhost:5173`, `dev-collaboration-secret`, local Postgres/Redis).

Optional: `cp .env.example .env` and edit. `dev` / `start` / `chaos` load
`.env` via Node `--env-file-if-exists` when present.

```text
COLLABORATION_ALLOWED_ORIGINS=http://localhost:5173   # comma-separated
COLLABORATION_SECRET=dev-collaboration-secret         # must match Go
API_URL=http://localhost:8080
DATABASE_URL=postgres://evo:evo@localhost:5432/evo?sslmode=disable
REDIS_URL=redis://localhost:6379/0
```

Production must set these explicitly (docker-compose already does). Optional
controls include `PORT` (1234), `COLLABORATION_DEBOUNCE_MS` (2000),
`COLLABORATION_MAX_DEBOUNCE_MS` (10000), and
`COLLABORATION_MAX_PAYLOAD_BYTES` (2 MiB).

Endpoints:

- WebSocket: `/`
- liveness/readiness: `/healthz`, `/readyz`
- Prometheus text metrics: `/metrics`
- authenticated Go command API: `POST /internal/commands`

## Persistence and recovery

Rooms are named `material:{id}:schema:{epoch}`. The first load initializes the
`content` Y.XmlText from `materials.content` under a PostgreSQL advisory/row
lock. After that, the binary Y.Doc is never reconstructed from JSON.

Every store merges persisted and in-memory updates while holding the material
lock, increments `stored_version`, and commits the encoded state. Failed stores
remain in an in-memory retry queue. A successful store sends a validated Plate
projection to Go; rows where projection lags are retried periodically.

On restart, the exact stored binary update is loaded. Redis synchronizes
document and awareness updates between replicas but is not persistence.

Idle, oversized rooms are compacted from the projected Plate value when no
clients are connected. Compaction increments the room epoch so clients receive a
fresh Y.Doc instead of merging stale history.

Graceful SIGINT/SIGTERM handling flushes pending Hocuspocus stores before
closing PostgreSQL and Redis connections.

## Durability receipts

Clients ask for a receipt with a `checkpoint-request` stateless message. Their
IDs are held in memory per room, claimed before the store reads the document, and
returned in the `checkpoint-persisted` broadcast once PostgreSQL commits, along
with the stored version and the document metrics. Nothing is written into the
Y.Doc, so a receipt costs no Yjs update and leaves nothing behind in the
persisted state.

## Document limits

Limits (2 MiB, 10 000 nodes, depth 16) live in `src/limits.ts` and must stay in
sync with `src/lib/const.ts` and `server/internal/materialdoc/document.go`.

`beforeHandleMessage` measures an update before it is applied. Measuring means
cloning the document and serializing it, so it is amortized over a budget of
applied update bytes and only runs per update once the document is near a limit.
An over-limit document still accepts updates that do not worsen size, node count,
or depth; without that allowance the deletions needed to recover would also be
rejected. A rejected update closes just that connection after sending it
`document-rejected`, so the client discards its forked Y.Doc rather than
reconnecting and resending it forever.

The store hook repeats the check as a backstop. Hocuspocus swallows store
failures and keeps the document loaded, so a limit failure there broadcasts
`document-rejected` and evicts the room across all replicas instead of leaving it
live and silently unsavable.

## Access

Go signs five-minute HS256 tokens with exact room, schema, user, and `write` or
`comment` access. The sidecar verifies token claims and browser origin.
Comment connections are read-only at the server protocol layer.

Go publishes:

- `evo:collaboration:comments` for stateless discussion invalidation;
- `evo:collaboration:evict` for ACL/lifecycle reconnects.

## Operations

Monitor active rooms/connections, encoded Y.Doc size, store/projection latency
and failures, version lag, event-loop delay, RSS, disconnects, and
Redis/PostgreSQL latency. Start with one replica. Do not impose an arbitrary
room-size cap; add a distributed measured limit only after load testing.

Keep Yjs garbage collection enabled. Treat compaction/rebasing as a separate
tested maintenance operation.

## Local chaos peers

To exercise remote cursors and concurrent edits against a real sidecar (not
MSW), open a material in the app with the live collaboration stack, then spawn
synthetic peers that join/leave and apply small Plate/Yjs updates:

```bash
# same secret + allowed origin as deploy/docker-compose.yml
pnpm --filter @evo-notes/collaboration chaos -- \
  --material-id <material_id> \
  --peers 4
```

Useful flags: `--room material:<id>:schema:<n>` (required after compaction
bumps the schema epoch), `--origin http://localhost:5173`, `--no-edits`
(presence only), `--access comment`, `--edit-ms 700-2800`,
`--session-ms 6000-20000`. Tokens are minted locally with
`COLLABORATION_SECRET` (default `dev-collaboration-secret`).

Keep `VITE_USE_MSW=false` (or otherwise still talk to the real collab
WebSocket). Chaos peers share the authoritative Y.Doc with your browser, so
your typing continues to merge normally.

## Commands

```bash
pnpm --filter @evo-notes/collaboration typecheck
pnpm --filter @evo-notes/collaboration test
pnpm --filter @evo-notes/collaboration build
pnpm --filter @evo-notes/collaboration chaos -- --help
```
