# Evo Notes collaboration service

Self-hosted Hocuspocus/Yjs authority for live Plate material content.

## Configuration

Required:

```text
DATABASE_URL=postgres://...
REDIS_URL=redis://...
API_URL=http://server:8080
COLLABORATION_SECRET=<same value as Go>
COLLABORATION_ALLOWED_ORIGINS=https://app.example.com
```

Optional controls include `PORT` (1234),
`COLLABORATION_DEBOUNCE_MS` (2000),
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
clients are connected. Compaction clears transient checkpoints and increments
the room epoch so clients receive a fresh Y.Doc instead of merging stale
history.

Graceful SIGINT/SIGTERM handling flushes pending Hocuspocus stores before
closing PostgreSQL and Redis connections.

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

## Commands

```bash
pnpm --filter @evo-notes/collaboration typecheck
pnpm --filter @evo-notes/collaboration test
pnpm --filter @evo-notes/collaboration build
```
