# Evo Notes

Study workspace: notes, sources, quizzes, flashcards, schedule, and AI retrieval.

## Parts

- **Web app** (`src/`) — React/Vite SPA. Plate notes editor, file viewers, workspace chat/generate, quizzes, flashcards, schedule, tasks, Excalidraw canvas, Explore, billing. Clerk auth. Paraglide i18n (`messages/`).
- **API** (`server/`) — Go HTTP gateway (`/api`). Workspaces, materials, files, comments, sharing, quota, billing, jobs, notifications. Owns Postgres migrations.
- **Collaboration** (`collaboration/`) — Hocuspocus/Yjs sidecar. Authoritative live document state for materials.
- **Pipeline** (`pipeline/`) — Python ingest worker (parse, chunk, embed, summarize) and FastAPI retrieval service (chat, generate).
- **Parser** (`modal/`) — Marker + RapidOCR on Modal CPU (`evo-mineru-fast`). One parse route.
- **Postgres** — App data plus `pgvector` retrieval index.
- **Redis** — Pub/sub and collaboration replica sync.
- **Object storage** — Backblaze B2 for uploads, parse artifacts, and editor assets.
- **Emails** (`emails/`) — React Email templates (invites, billing, account lifecycle).
- **Contract** (`openapi.yaml`) — OpenAPI spec; Orval generates the frontend client.
- **Deploy** (`deploy/`) — Docker Compose for local backend stack.
- **Docs** (`openwiki/`) — Domain notes (authz, quota, retrieval, editor).
- **Tests** — Vitest (`src/`, `collaboration/`), Go (`server/`), pytest (`pipeline/`), Playwright (`e2e/`).
