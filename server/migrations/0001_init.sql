-- Evo Notes — development baseline schema + seed.
--
-- Rewritten as a clean baseline on 2026-07-21 (squash of former migrations
-- 0001–0020, with all incremental ALTERs folded into final-form CREATE TABLEs
-- and legacy backfill/reshape logic removed). Assumes a fresh database.
--
-- The startup runner (internal/store.Migrate) re-applies this file on every
-- boot, so everything must stay idempotent: IF NOT EXISTS / ON CONFLICT.
--
-- Extensions:
--   * pgvector >= 0.7.0 (halfvec HNSW for LightRAG's 2560-dim embeddings) —
--     provided by the pgvector/pgvector:pg16 base of deploy/postgres/Dockerfile.
--   * Apache AGE must be preloaded: run Postgres with
--     `-c shared_preload_libraries=age` (set in deploy/docker-compose.yml).
--     LightRAG creates its own lightrag_* tables and AGE graph on
--     initialize_storages(); the Go migrator only ensures the extensions exist.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;

-- ============================================================================
-- Identity, workspaces, content tree
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  email               text NOT NULL,
  avatar_url          text,
  class_label         text,
  streak              int  NOT NULL DEFAULT 0,
  clerk_id            text UNIQUE,
  stripe_customer_id  text UNIQUE,
  subscription_status text NOT NULL DEFAULT 'none',
  plan_tier           text NOT NULL DEFAULT 'free',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id               text PRIMARY KEY,
  user_id          text REFERENCES users(id),
  name             text NOT NULL,
  color            text NOT NULL DEFAULT 'green',
  privacy          text NOT NULL DEFAULT 'private',
  -- Role granted to link/public visitors who are not explicit members.
  share_role       text NOT NULL DEFAULT 'viewer',
  clone_count      int  NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_share_role_check
    CHECK (share_role IN ('viewer', 'commenter', 'editor'))
);
CREATE INDEX IF NOT EXISTS workspaces_user_idx ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS workspaces_privacy_idx ON workspaces(privacy) WHERE privacy = 'public';

CREATE TABLE IF NOT EXISTS chapters (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  position     int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chapters_ws_idx ON chapters(workspace_id);

CREATE TABLE IF NOT EXISTS files (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chapter_id            text REFERENCES chapters(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  kind                  text NOT NULL DEFAULT 'pdf',
  size_kb               int  NOT NULL DEFAULT 0,
  added_at              timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'ready',   -- processing | ready | failed
  parser                text,
  engine                text,
  blob_path             text,
  url                   text,
  content               text,
  -- LightRAG document id written back by the Python worker after ingest
  -- (deterministic md5 of the canonical basename); resolves basename
  -- collisions / job retries and maps file -> document for deletion.
  doc_id                text,
  -- Durable parser artifacts (direct-to-B2 upload pipeline).
  parsed_blob_path      text,
  parsed_fingerprint    text,
  parsed_parser_version text,
  source_etag           text
);
CREATE INDEX IF NOT EXISTS files_ws_idx ON files(workspace_id);
CREATE INDEX IF NOT EXISTS files_chapter_idx ON files(chapter_id);

-- ============================================================================
-- Materials — the universal Plate-document envelope for study artifacts
-- (notes, quizzes, flashcards, mindmaps, diagrams).
-- ============================================================================

CREATE TABLE IF NOT EXISTS materials (
  id             text PRIMARY KEY,
  -- Ownership lives directly on the material; workspace_id is optional
  -- provenance / container membership (standalone materials have none).
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   text REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_name text NOT NULL DEFAULT '',
  -- Membership: which chapter the material is filed under in the workspace
  -- tree (mirrors files.chapter_id). Nullable = unfiled; unfiles on chapter
  -- delete. Orthogonal to scope_chapters, which records generation provenance.
  chapter_id     text REFERENCES chapters(id) ON DELETE SET NULL,
  kind           text NOT NULL,
  title          text NOT NULL DEFAULT '',
  content        jsonb NOT NULL DEFAULT
    '{"schemaVersion":1,"value":[{"type":"p","children":[{"text":""}]}]}'::jsonb,
  scope_chapters text[] NOT NULL DEFAULT '{}',
  scope_file_ids text[] NOT NULL DEFAULT '{}',
  privacy        text NOT NULL DEFAULT 'private',
  color          text NOT NULL DEFAULT 'green',
  clone_count    int    NOT NULL DEFAULT 0,
  revision       bigint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT materials_kind_check
    CHECK (kind IN ('mindmap','diagram','quiz','flashcards','note')),
  CONSTRAINT materials_content_envelope_check CHECK (
    jsonb_typeof(content) = 'object'
    AND content->>'schemaVersion' = '1'
    AND jsonb_typeof(content->'value') = 'array'
  )
);
CREATE INDEX IF NOT EXISTS materials_ws_idx ON materials(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS materials_chapter_idx ON materials(chapter_id);
CREATE INDEX IF NOT EXISTS materials_privacy_idx ON materials(privacy, kind) WHERE privacy = 'public';
CREATE INDEX IF NOT EXISTS materials_user_idx ON materials(user_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS material_revisions (
  material_id            text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  -- One mutable snapshot per UTC day. Saves during the same day replace this
  -- row; materials.revision remains the per-mutation concurrency counter.
  version_date           date NOT NULL,
  revision               bigint NOT NULL,
  parent_revision        bigint,
  event_type             text NOT NULL DEFAULT 'create'
                           CHECK (event_type IN ('create','edit')),
  title                  text NOT NULL,
  content                jsonb NOT NULL,
  event_metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
                           CHECK (jsonb_typeof(event_metadata) = 'object'),
  created_by             text REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_revision IS NULL OR parent_revision < revision),
  PRIMARY KEY (material_id, version_date),
  UNIQUE (material_id, revision)
);

-- The encoded Y.Doc is the authoritative material-content state after lazy
-- initialization. materials.content is an asynchronously updated read model.
CREATE TABLE IF NOT EXISTS material_yjs_documents (
  material_id       text PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  room_schema       integer NOT NULL DEFAULT 1 CHECK (room_schema > 0),
  state             bytea NOT NULL,
  stored_version    bigint NOT NULL DEFAULT 1 CHECK (stored_version > 0),
  projected_version bigint NOT NULL DEFAULT 0 CHECK (projected_version >= 0),
  projection_error  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  projected_at      timestamptz,
  CHECK (projected_version <= stored_version)
);
CREATE INDEX IF NOT EXISTS material_yjs_projection_pending_idx
  ON material_yjs_documents(updated_at)
  WHERE projected_version < stored_version;

-- Per-card FSRS scheduling state (shape mirrors SrsState in src/api/types.ts),
-- keyed by the flashcard element id inside the material document.
CREATE TABLE IF NOT EXISTS card_stats (
  card_id     text PRIMARY KEY,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  srs         jsonb NOT NULL,
  known       boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS card_stats_material_idx ON card_stats(material_id);
-- Raw-text index: (srs->>'due')::timestamptz cannot be indexed — the
-- text->timestamptz cast is only STABLE (timezone-dependent) and Postgres
-- requires IMMUTABLE index expressions. The stored values are uniform
-- ISO-8601 UTC strings, which sort chronologically.
CREATE INDEX IF NOT EXISTS card_stats_due_idx ON card_stats ((srs->>'due'));

-- Quiz attempts. `answers` is a map keyed by question id (mirrors the frontend
-- Answer union); `questions` is the snapshot taken at submit time so later
-- quiz edits don't distort historical results.
CREATE TABLE IF NOT EXISTS attempts (
  id             text PRIMARY KEY,
  user_id        text,
  quiz_id        text,
  quiz_name      text NOT NULL DEFAULT '',
  workspace_name text NOT NULL DEFAULT '',
  chapters       text[] NOT NULL DEFAULT '{}',
  correct        int NOT NULL DEFAULT 0,
  total          int NOT NULL DEFAULT 0,
  pct            int NOT NULL DEFAULT 0,
  answers        jsonb NOT NULL DEFAULT '{}',
  questions      jsonb NOT NULL DEFAULT '[]',
  taken_at       timestamptz NOT NULL DEFAULT now()
);

-- Per-user mistakes pool backing the "Review mistakes" virtual quiz.
CREATE TABLE IF NOT EXISTS mistakes (
  user_id     text NOT NULL,
  question_id text NOT NULL,
  question    jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS mistakes_user_idx ON mistakes(user_id, updated_at DESC);

-- ============================================================================
-- Tags — per-user, per-kind catalog (deduped by name) + entity link table.
-- Reusing a tag references the same catalog row, so per-tag metadata (future
-- analytics) survives edits and outlives the entities that reference it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tags (
  id         text PRIMARY KEY,
  user_id    text REFERENCES users(id),
  kind       text NOT NULL,               -- 'workspace' | 'quiz' | 'card'
  name       text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tags_user_idx ON tags(user_id);
CREATE INDEX IF NOT EXISTS tags_name_idx ON tags(lower(name));  -- cross-user search
-- Catalog uniqueness: one tag name per user per kind (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS tags_user_kind_name_uidx
  ON tags(user_id, kind, lower(name));

CREATE TABLE IF NOT EXISTS entity_tags (
  kind       text NOT NULL,               -- 'workspace' | 'quiz' | 'card'
  entity_id  text NOT NULL,               -- id of the owning workspace/quiz/card
  tag_id     text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, entity_id, tag_id)
);
CREATE INDEX IF NOT EXISTS entity_tags_entity_idx ON entity_tags(kind, entity_id);
CREATE INDEX IF NOT EXISTS entity_tags_tag_idx ON entity_tags(tag_id);

-- ============================================================================
-- Personal planner: labels, events, tasks, canvases
-- ============================================================================

CREATE TABLE IF NOT EXISTS labels (
  id      text PRIMARY KEY,
  user_id text REFERENCES users(id),   -- labels are user-owned calendar categories
  name    text NOT NULL,
  color   text NOT NULL DEFAULT 'green'
);
CREATE INDEX IF NOT EXISTS labels_user_idx ON labels(user_id);

CREATE TABLE IF NOT EXISTS events (
  id        text PRIMARY KEY,
  user_id   text REFERENCES users(id),
  title     text NOT NULL,
  start_at  timestamptz NOT NULL,
  end_at    timestamptz NOT NULL,
  label_ids text[] NOT NULL DEFAULT '{}',
  location  text,
  note      text
);
CREATE INDEX IF NOT EXISTS events_user_idx ON events(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id       text PRIMARY KEY,
  user_id  text REFERENCES users(id),
  title    text NOT NULL,
  meta     text,
  done     boolean NOT NULL DEFAULT false,
  due_date timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks(user_id);

CREATE TABLE IF NOT EXISTS canvases (
  id         text PRIMARY KEY,
  user_id    text REFERENCES users(id),
  name       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  scene      jsonb
);
CREATE INDEX IF NOT EXISTS canvases_user_idx ON canvases(user_id);

-- ============================================================================
-- Collaboration: membership, invitations, notifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','commenter','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx
  ON workspace_members(user_id, workspace_id);

-- Identity-bound invitations: created against a resolved user account
-- (invited_user_id); `email` is retained for display only.
CREATE TABLE IF NOT EXISTS workspace_invites (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email           text NOT NULL,
  invited_user_id text REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('editor','commenter','viewer')),
  token_hash      bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_by     text REFERENCES users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_pending_user_idx
  ON workspace_invites(workspace_id, invited_user_id)
  WHERE accepted_at IS NULL
    AND revoked_at IS NULL
    AND invited_user_id IS NOT NULL;
-- Keeps periodic invitation-expiry cleanup bounded.
CREATE INDEX IF NOT EXISTS workspace_invites_expiry_idx
  ON workspace_invites(expires_at)
  WHERE accepted_at IS NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id                  text PRIMARY KEY,
  user_id             text REFERENCES users(id),
  kind                text NOT NULL,
  title               text NOT NULL,
  body                text NOT NULL,
  href                text,
  -- Actionable, recipient-only workspace-invitation notifications.
  workspace_invite_id text REFERENCES workspace_invites(id) ON DELETE CASCADE,
  at                  timestamptz NOT NULL DEFAULT now(),
  read                boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_workspace_invite_idx
  ON notifications(workspace_invite_id)
  WHERE workspace_invite_id IS NOT NULL;

-- ============================================================================
-- Collaboration: comment discussions and comments
-- ============================================================================

CREATE TABLE IF NOT EXISTS material_discussions (
  id          text PRIMARY KEY,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  block_id    text,
  anchor_start bytea,
  anchor_end   bytea,
  anchor_version integer NOT NULL DEFAULT 1 CHECK (anchor_version > 0),
  anchor_quote text NOT NULL DEFAULT '',
  created_by  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_resolved boolean NOT NULL DEFAULT false,
  deleted_at  timestamptz,
  deleted_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((anchor_start IS NULL) = (anchor_end IS NULL)),
  CHECK (anchor_start IS NULL OR (octet_length(anchor_start) BETWEEN 1 AND 4096)),
  CHECK (anchor_end IS NULL OR (octet_length(anchor_end) BETWEEN 1 AND 4096)),
  CHECK (length(anchor_quote) <= 1000)
);
CREATE INDEX IF NOT EXISTS material_discussions_material_idx
  ON material_discussions(material_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS material_comments (
  id                text PRIMARY KEY,
  discussion_id     text NOT NULL REFERENCES material_discussions(id) ON DELETE CASCADE,
  parent_comment_id text REFERENCES material_comments(id) ON DELETE SET NULL,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_rich      jsonb NOT NULL,
  is_edited         boolean NOT NULL DEFAULT false,
  deleted_at        timestamptz,
  deleted_by        text REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_comment_id IS NULL OR parent_comment_id <> id)
);
CREATE INDEX IF NOT EXISTS material_comments_discussion_idx
  ON material_comments(discussion_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS material_comments_parent_idx
  ON material_comments(parent_comment_id, created_at) WHERE parent_comment_id IS NOT NULL;

-- ============================================================================
-- AI chat persistence. Conversations are workspace-scoped: RAG grounding runs
-- against the owning workspace's per-tenant LightRAG index, so every
-- conversation carries both user_id (ownership) and workspace_id (scope).
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
  id           text PRIMARY KEY,
  user_id      text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text,
  metadata     jsonb NOT NULL DEFAULT '{}',   -- system prompt, RAG filters, etc.
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_ws_idx ON conversations(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','system')),
  content         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'complete', -- streaming | complete | aborted | error
  token_count     int,
  metadata        jsonb NOT NULL DEFAULT '{}',       -- RAG citations, generation_id, usage
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, created_at);

-- ============================================================================
-- Auth/billing plumbing and the async job queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS oauth_connections (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  access_token  text NOT NULL,
  refresh_token text,
  expires_at    timestamptz,
  scopes        text,
  account_email text,
  UNIQUE(user_id, provider)
);
CREATE INDEX IF NOT EXISTS oauth_connections_user_idx ON oauth_connections(user_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           text PRIMARY KEY,
  source       text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  processed_at timestamptz,
  error        text
);
CREATE INDEX IF NOT EXISTS webhook_events_source_idx ON webhook_events(source, processed_at);

-- Postgres-backed job queue for async ingestion (claimed via SKIP LOCKED).
CREATE TABLE IF NOT EXISTS jobs (
  id         text PRIMARY KEY,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  attempts   int NOT NULL DEFAULT 0,
  error      text,
  locked_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);

-- ============================================================================
-- Direct browser-to-B2 uploads and editor media assets
-- ============================================================================

CREATE TABLE IF NOT EXISTS upload_sessions (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chapter_id    text REFERENCES chapters(id) ON DELETE SET NULL,
  object_path   text NOT NULL UNIQUE,
  final_path    text NOT NULL UNIQUE,
  name          text NOT NULL,
  kind          text NOT NULL,
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  declared_size bigint NOT NULL CHECK (declared_size >= 0),
  parse_mode    text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  source_etag   text,
  file_id       text REFERENCES files(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx
  ON upload_sessions(status, expires_at);

-- Editor media stored directly in Backblaze B2. The browser uploads to a
-- short-lived, server-reserved object URL. Plate documents persist only the
-- stable editor_assets.id; read URLs are resolved on demand after
-- workspace/share authorization.
CREATE TABLE IF NOT EXISTS editor_assets (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  purpose      text NOT NULL CHECK (purpose IN ('image','audio','video','pdf','file')),
  object_path  text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','expired')),
  etag         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id, workspace_id),
  CHECK (
    (purpose='image' AND size_bytes <= 20971520) OR
    (purpose='audio' AND size_bytes <= 104857600) OR
    (purpose='video' AND size_bytes <= 524288000) OR
    (purpose='pdf' AND size_bytes <= 52428800) OR
    (purpose='file' AND size_bytes <= 104857600)
  ),
  CHECK ((status='ready') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS editor_assets_workspace_idx
  ON editor_assets(workspace_id, status);

CREATE TABLE IF NOT EXISTS editor_asset_uploads (
  id            text PRIMARY KEY,
  asset_id      text NOT NULL UNIQUE,
  workspace_id  text NOT NULL,
  object_path   text NOT NULL UNIQUE,
  content_type  text NOT NULL,
  declared_size bigint NOT NULL CHECK (declared_size > 0),
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','expired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  completed_at  timestamptz,
  FOREIGN KEY (asset_id, workspace_id)
    REFERENCES editor_assets(id, workspace_id) ON DELETE CASCADE,
  CHECK ((status='completed') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS editor_asset_uploads_expiry_idx
  ON editor_asset_uploads(status, expires_at);

-- ============================================================================
-- Seed data — mirrors src/mocks/db.ts so the real backend starts with the same
-- dummy content the frontend was built against. Idempotent via ON CONFLICT.
-- Quiz/flashcard materials are pre-converted Plate documents (formerly derived
-- from legacy quizzes/decks/cards tables at migration time).
-- ============================================================================

INSERT INTO users (id, name, email, class_label, streak) VALUES
  ('u_1', 'Kate Malone', 'kate@evonotes.app', 'Grade 11 · Science', 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, user_id, name, color, privacy, created_at, last_accessed_at) VALUES
  ('ws_bio',  'u_1', 'Biology 101',        'green',  'private', now()-interval '40 day', now()-interval '3 hour'),
  ('ws_calc', 'u_1', 'Calculus II',        'purple', 'private', now()-interval '30 day', now()-interval '1 day'),
  ('ws_hist', 'u_1', 'World History',      'amber',  'link',    now()-interval '22 day', now()-interval '2 day'),
  ('ws_chem', 'u_1', 'Organic Chemistry',  'blue',   'private', now()-interval '12 day', now()-interval '5 day'),
  ('ws_eng',  'u_1', 'English Literature', 'coral',  'public',  now()-interval '8 day',  now()-interval '20 hour')
ON CONFLICT (id) DO NOTHING;

-- Every workspace owner is an explicit member; re-asserted on each boot.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, user_id, 'owner'
FROM workspaces
WHERE user_id IS NOT NULL
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role='owner';

INSERT INTO chapters (id, workspace_id, name, position) VALUES
  ('ch_1',  'ws_bio',  'Cell structure',           0),
  ('ch_2',  'ws_bio',  'Membranes & transport',    1),
  ('ch_3',  'ws_bio',  'Genetics',                 2),
  ('ch_c1', 'ws_calc', 'Techniques of integration',0),
  ('ch_c2', 'ws_calc', 'Sequences & series',       1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO files (id, workspace_id, chapter_id, name, kind, size_kb, added_at, status, url, content) VALUES
  ('f_1', 'ws_bio',  'ch_1', 'Cell structure.pdf',       'pdf',   2480, now()-interval '20 day', 'ready', 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf', NULL),
  ('f_2', 'ws_bio',  'ch_1', 'Organelles cheatsheet.md', 'md',      14, now()-interval '19 day', 'ready', NULL, '# Organelles

- **Nucleus** — stores DNA, controls the cell.
- **Mitochondria** — the powerhouse; ATP via respiration.
- **Ribosomes** — protein synthesis.
- **Golgi apparatus** — packaging & shipping.

The cell membrane is a *phospholipid bilayer* that controls what enters and leaves.'),
  ('f_3', 'ws_bio',  'ch_2', 'Osmosis notes.txt',        'txt',      6, now()-interval '18 day', 'ready', NULL, 'Osmosis is the diffusion of water across a semi-permeable membrane from low to high solute concentration.'),
  ('f_4', 'ws_bio',  'ch_3', 'Mendelian genetics.pdf',   'pdf',   1890, now()-interval '15 day', 'ready', 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf', NULL),
  ('f_5', 'ws_bio',  NULL,   'Punnett squares.png',      'image',  420, now()-interval '14 day', 'ready', NULL, NULL),
  ('f_6', 'ws_calc', 'ch_c1','Integration by parts.pdf', 'pdf',    980, now()-interval '10 day', 'ready', 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf', NULL),
  ('f_7', 'ws_calc', 'ch_c2','Taylor series.md',         'md',      11, now()-interval '9 day',  'ready', NULL, '# Taylor series

A function f(x) near a point a:

f(x) = Σ fⁿ(a)/n! · (x − a)ⁿ')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tags (id, user_id, kind, name) VALUES
  ('tag_1', 'u_1', 'workspace', 'Cells'),
  ('tag_2', 'u_1', 'workspace', 'Genetics'),
  ('tag_3', 'u_1', 'workspace', 'Integrals'),
  ('tag_4', 'u_1', 'workspace', 'Series'),
  ('tag_5', 'u_1', 'workspace', 'Modern'),
  ('tag_6', 'u_1', 'workspace', 'Essays'),
  ('tag_7', 'u_1', 'workspace', 'Reactions'),
  ('tag_8', 'u_1', 'workspace', 'Poetry'),
  ('tag_9', 'u_1', 'workspace', 'Shakespeare')
ON CONFLICT (user_id, kind, lower(name)) DO NOTHING;

-- Links resolve the tag id by name so they never dangle regardless of which id
-- won the catalog row.
INSERT INTO entity_tags (kind, entity_id, tag_id)
  SELECT 'workspace', v.entity_id, t.id
  FROM (VALUES
    ('ws_bio',  'Cells'),
    ('ws_bio',  'Genetics'),
    ('ws_calc', 'Integrals'),
    ('ws_calc', 'Series'),
    ('ws_hist', 'Modern'),
    ('ws_hist', 'Essays'),
    ('ws_chem', 'Reactions'),
    ('ws_eng',  'Poetry'),
    ('ws_eng',  'Shakespeare')
  ) AS v(entity_id, name)
  JOIN tags t ON t.user_id = 'u_1' AND t.kind = 'workspace' AND lower(t.name) = lower(v.name)
  WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = v.entity_id)
  ON CONFLICT DO NOTHING;

INSERT INTO materials (id, user_id, workspace_id, workspace_name, kind, title, content, scope_chapters, scope_file_ids, privacy, color, created_at) VALUES
  ('qz_1', 'u_1', 'ws_bio', 'Biology 101', 'quiz', 'Cell biology basics',
   $json${"value": [{"type": "h1", "children": [{"text": "Cell biology basics"}]}, {"id": "qz_1:quiz", "type": "quiz", "children": [{"id": "q1", "type": "quiz_question", "level": "recall", "children": [{"type": "quiz_prompt", "children": [{"text": "Which organelle is the powerhouse of the cell?"}]}, {"id": "q1:option:1", "type": "quiz_option", "children": [{"text": "Nucleus"}], "explanation": "The nucleus stores DNA; it does not generate the cell's ATP."}, {"id": "q1:option:2", "type": "quiz_option", "children": [{"text": "Mitochondria"}], "explanation": "Correct — mitochondria produce ATP through cellular respiration."}, {"id": "q1:option:3", "type": "quiz_option", "children": [{"text": "Ribosome"}], "explanation": "Ribosomes synthesize proteins, not energy."}, {"id": "q1:option:4", "type": "quiz_option", "children": [{"text": "Golgi apparatus"}], "explanation": "The Golgi packages and ships proteins; it is not an energy source."}, {"type": "quiz_explanation", "children": [{"text": "Mitochondria produce ATP through cellular respiration."}]}], "questionType": "mcq", "correctOptionIds": ["q1:option:2"]}, {"id": "q2", "type": "quiz_question", "level": "recall", "children": [{"type": "quiz_prompt", "children": [{"text": "The cell membrane is a phospholipid bilayer."}]}, {"id": "q2:option:1", "type": "quiz_option", "children": [{"text": "True"}]}, {"id": "q2:option:2", "type": "quiz_option", "children": [{"text": "False"}]}, {"type": "quiz_explanation", "children": [{"text": "The membrane is two layers of phospholipids with hydrophilic heads out and hydrophobic tails in."}]}], "questionType": "boolean", "correctBoolean": true, "correctOptionIds": ["q2:option:1"]}, {"id": "q3", "type": "quiz_question", "level": "application", "children": [{"type": "quiz_prompt", "children": [{"text": "Select all that are membrane-bound organelles."}]}, {"id": "q3:option:1", "type": "quiz_option", "children": [{"text": "Ribosome"}], "explanation": "Ribosomes are ribonucleoprotein particles, not membrane-bound."}, {"id": "q3:option:2", "type": "quiz_option", "children": [{"text": "Nucleus"}], "explanation": "Correct — enclosed by a double-membrane nuclear envelope."}, {"id": "q3:option:3", "type": "quiz_option", "children": [{"text": "Mitochondria"}], "explanation": "Correct — bounded by an outer and inner membrane."}, {"id": "q3:option:4", "type": "quiz_option", "children": [{"text": "Cytosol"}], "explanation": "The cytosol is the fluid itself, not a membrane-bound compartment."}], "questionType": "multi", "correctOptionIds": ["q3:option:2", "q3:option:3"]}, {"id": "q4", "type": "quiz_question", "level": "application", "children": [{"type": "quiz_prompt", "children": [{"text": "The diffusion of water across a membrane is called ____."}]}, {"id": "q4:option:1", "role": "accepted-answer", "type": "quiz_option", "children": [{"text": "osmosis"}]}], "questionType": "fill", "acceptedAnswers": ["osmosis"]}, {"id": "q5", "type": "quiz_question", "level": "analysis", "children": [{"type": "quiz_prompt", "children": [{"text": "Order the path of protein secretion."}]}, {"id": "q5:option:1", "role": "ordering-item", "type": "quiz_option", "children": [{"text": "Ribosome"}]}, {"id": "q5:option:2", "role": "ordering-item", "type": "quiz_option", "children": [{"text": "Rough ER"}]}, {"id": "q5:option:3", "role": "ordering-item", "type": "quiz_option", "children": [{"text": "Golgi apparatus"}]}, {"id": "q5:option:4", "role": "ordering-item", "type": "quiz_option", "children": [{"text": "Vesicle"}]}, {"id": "q5:option:5", "role": "ordering-item", "type": "quiz_option", "children": [{"text": "Cell membrane"}]}], "questionType": "ordering"}, {"id": "q6", "type": "quiz_question", "level": "application", "pairs": [{"left": "Nucleus", "right": "Stores DNA"}, {"left": "Mitochondria", "right": "Makes ATP"}, {"left": "Ribosome", "right": "Builds proteins"}], "children": [{"type": "quiz_prompt", "children": [{"text": "Match the organelle to its function."}]}, {"id": "q6:option:1", "role": "matching-pair", "type": "quiz_option", "children": [{"text": "Nucleus → Stores DNA"}]}, {"id": "q6:option:2", "role": "matching-pair", "type": "quiz_option", "children": [{"text": "Mitochondria → Makes ATP"}]}, {"id": "q6:option:3", "role": "matching-pair", "type": "quiz_option", "children": [{"text": "Ribosome → Builds proteins"}]}], "questionType": "matching"}]}], "schemaVersion": 1}$json$::jsonb,
   '{"Cell structure","Membranes & transport"}', '{}', 'private', 'green', now()-interval '4 day'),
  ('qz_2', 'u_1', 'ws_bio', 'Biology 101', 'quiz', 'Genetics check-in',
   $json${"value": [{"type": "h1", "children": [{"text": "Genetics check-in"}]}, {"id": "qz_2:quiz", "type": "quiz", "children": [{"id": "q7", "type": "quiz_question", "level": "application", "children": [{"type": "quiz_prompt", "children": [{"text": "A cross between Aa × Aa gives what genotype ratio?"}]}, {"id": "q7:option:1", "type": "quiz_option", "children": [{"text": "1:2:1"}], "explanation": "Correct — the genotype ratio is 1 AA : 2 Aa : 1 aa."}, {"id": "q7:option:2", "type": "quiz_option", "children": [{"text": "3:1"}], "explanation": "That is the phenotype ratio, not the genotype ratio."}, {"id": "q7:option:3", "type": "quiz_option", "children": [{"text": "1:1"}], "explanation": "A 1:1 ratio comes from a test cross (Aa × aa)."}, {"id": "q7:option:4", "type": "quiz_option", "children": [{"text": "9:3:3:1"}], "explanation": "That is a dihybrid (two-gene) ratio, not a monohybrid one."}], "questionType": "mcq", "correctOptionIds": ["q7:option:1"]}, {"id": "q8", "type": "quiz_question", "level": "analysis", "children": [{"type": "quiz_prompt", "children": [{"text": "Define a dominant allele in one sentence."}]}, {"id": "q8:option:1", "role": "accepted-answer", "type": "quiz_option", "children": [{"text": "an allele expressed in the phenotype even when only one copy is present"}]}], "questionType": "short", "acceptedAnswers": ["an allele expressed in the phenotype even when only one copy is present"]}]}], "schemaVersion": 1}$json$::jsonb,
   '{"Genetics"}', '{}', 'private', 'green', now()-interval '2 day'),
  ('qz_3', 'u_1', 'ws_calc', 'Calculus II', 'quiz', 'Integration techniques',
   $json${"value": [{"type": "h1", "children": [{"text": "Integration techniques"}]}, {"id": "qz_3:quiz", "type": "quiz", "children": [{"id": "q9", "type": "quiz_question", "level": "application", "children": [{"type": "quiz_prompt", "children": [{"text": "∫ x·eˣ dx is best solved by…"}]}, {"id": "q9:option:1", "type": "quiz_option", "children": [{"text": "Substitution"}], "explanation": "No single inner function's derivative appears, so u-substitution stalls."}, {"id": "q9:option:2", "type": "quiz_option", "children": [{"text": "Integration by parts"}], "explanation": "Correct — a polynomial times an exponential is the classic parts case."}, {"id": "q9:option:3", "type": "quiz_option", "children": [{"text": "Partial fractions"}], "explanation": "Partial fractions apply to rational functions, not this product."}, {"id": "q9:option:4", "type": "quiz_option", "children": [{"text": "Trig substitution"}], "explanation": "Trig substitution targets radical forms like √(a²−x²)."}], "questionType": "mcq", "correctOptionIds": ["q9:option:2"]}, {"id": "q10", "type": "quiz_question", "level": "recall", "children": [{"type": "quiz_prompt", "children": [{"text": "∫ 1/x dx = ln|x| + C"}]}, {"id": "q10:option:1", "type": "quiz_option", "children": [{"text": "True"}]}, {"id": "q10:option:2", "type": "quiz_option", "children": [{"text": "False"}]}, {"type": "quiz_explanation", "children": [{"text": "The antiderivative of 1/x is ln|x|; the absolute value covers negative x."}]}], "questionType": "boolean", "correctBoolean": true, "correctOptionIds": ["q10:option:1"]}]}], "schemaVersion": 1}$json$::jsonb,
   '{"Techniques of integration"}', '{}', 'public', 'green', now()-interval '6 day'),
  ('dk_1', 'u_1', 'ws_bio', 'Biology 101', 'flashcards', 'Cell organelles',
   $json${"value": [{"type": "h1", "children": [{"text": "Cell organelles"}]}, {"id": "dk_1:flashcards", "type": "flashcards", "children": [{"id": "c_1", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Mitochondria"}]}, {"type": "flashcard_back", "children": [{"text": "Powerhouse of the cell — produces ATP."}]}]}, {"id": "c_2", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Nucleus"}]}, {"type": "flashcard_back", "children": [{"text": "Stores DNA and controls cell activity."}]}]}, {"id": "c_3", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Ribosome"}]}, {"type": "flashcard_back", "children": [{"text": "Site of protein synthesis."}]}]}, {"id": "c_4", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Golgi apparatus"}]}, {"type": "flashcard_back", "children": [{"text": "Packages and ships proteins."}]}]}]}], "schemaVersion": 1}$json$::jsonb,
   '{}', '{}', 'private', 'green', now()),
  ('dk_2', 'u_1', 'ws_calc', 'Calculus II', 'flashcards', 'Integration rules',
   $json${"value": [{"type": "h1", "children": [{"text": "Integration rules"}]}, {"id": "dk_2:flashcards", "type": "flashcards", "children": [{"id": "c_5", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "∫ eˣ dx"}]}, {"type": "flashcard_back", "children": [{"text": "eˣ + C"}]}]}, {"id": "c_6", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "∫ 1/x dx"}]}, {"type": "flashcard_back", "children": [{"text": "ln|x| + C"}]}]}]}], "schemaVersion": 1}$json$::jsonb,
   '{}', '{}', 'private', 'purple', now()),
  ('dk_3', 'u_1', 'ws_hist', 'World History', 'flashcards', 'History dates',
   $json${"value": [{"type": "h1", "children": [{"text": "History dates"}]}, {"id": "dk_3:flashcards", "type": "flashcards", "children": [{"id": "dk_3:card:1", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": ""}]}, {"type": "flashcard_back", "children": [{"text": ""}]}]}]}], "schemaVersion": 1}$json$::jsonb,
   '{}', '{}', 'private', 'amber', now())
ON CONFLICT (id) DO NOTHING;

-- Every seeded material starts with one daily version snapshot.
INSERT INTO material_revisions (
  material_id, version_date, revision, parent_revision, event_type, title, content,
  event_metadata, created_by, created_at
)
SELECT id, (created_at AT TIME ZONE 'UTC')::date, revision, NULL, 'create', title, content,
       '{}'::jsonb, user_id, created_at
FROM materials
WHERE id IN ('qz_1','qz_2','qz_3','dk_1','dk_2','dk_3')
ON CONFLICT (material_id, version_date) DO NOTHING;

-- FSRS state per seeded card: already-known cards get a plausible "review"
-- state that isn't due yet (so knownPct / dueCount look realistic); the rest
-- start fresh. ON CONFLICT keeps real review progress across restarts.
INSERT INTO card_stats (card_id, material_id, srs, known) VALUES
  ('c_1', 'dk_1', jsonb_build_object(
    'due', to_jsonb(now() + interval '3 days'),
    'stability', 12, 'difficulty', 5, 'elapsed_days', 0, 'scheduled_days', 3,
    'reps', 2, 'lapses', 0, 'state', 2, 'learning_steps', 0), true),
  ('c_2', 'dk_1', jsonb_build_object(
    'due', to_jsonb(now() + interval '3 days'),
    'stability', 12, 'difficulty', 5, 'elapsed_days', 0, 'scheduled_days', 3,
    'reps', 2, 'lapses', 0, 'state', 2, 'learning_steps', 0), true),
  ('c_5', 'dk_2', jsonb_build_object(
    'due', to_jsonb(now() + interval '3 days'),
    'stability', 12, 'difficulty', 5, 'elapsed_days', 0, 'scheduled_days', 3,
    'reps', 2, 'lapses', 0, 'state', 2, 'learning_steps', 0), true),
  ('c_3', 'dk_1', jsonb_build_object(
    'due', to_jsonb(now()),
    'stability', 0, 'difficulty', 0, 'elapsed_days', 0, 'scheduled_days', 0,
    'reps', 0, 'lapses', 0, 'state', 0, 'learning_steps', 0), false),
  ('c_4', 'dk_1', jsonb_build_object(
    'due', to_jsonb(now()),
    'stability', 0, 'difficulty', 0, 'elapsed_days', 0, 'scheduled_days', 0,
    'reps', 0, 'lapses', 0, 'state', 0, 'learning_steps', 0), false),
  ('c_6', 'dk_2', jsonb_build_object(
    'due', to_jsonb(now()),
    'stability', 0, 'difficulty', 0, 'elapsed_days', 0, 'scheduled_days', 0,
    'reps', 0, 'lapses', 0, 'state', 0, 'learning_steps', 0), false),
  ('dk_3:card:1', 'dk_3', jsonb_build_object(
    'due', to_jsonb(now()),
    'stability', 0, 'difficulty', 0, 'elapsed_days', 0, 'scheduled_days', 0,
    'reps', 0, 'lapses', 0, 'state', 0, 'learning_steps', 0), false)
ON CONFLICT (card_id) DO NOTHING;

INSERT INTO attempts (id, user_id, quiz_id, quiz_name, workspace_name, chapters, correct, total, pct, taken_at) VALUES
  ('at_1', 'u_1', 'qz_1', 'Cell biology basics',   'Biology 101', '{"Cell structure"}',            8, 10, 80, now()-interval '2 day'),
  ('at_2', 'u_1', 'qz_3', 'Integration techniques','Calculus II', '{"Techniques of integration"}', 6, 10, 60, now()-interval '3 day'),
  ('at_3', 'u_1', 'qz_2', 'Genetics check-in',     'Biology 101', '{"Genetics"}',                  4, 10, 40, now()-interval '5 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO labels (id, user_id, name, color) VALUES
  ('lb_bio',   'u_1', 'Biology',     'green'),
  ('lb_calc',  'u_1', 'Calculus',    'purple'),
  ('lb_hist',  'u_1', 'History',     'amber'),
  ('lb_exam',  'u_1', 'Exam',        'coral'),
  ('lb_study', 'u_1', 'Study group', 'blue')
ON CONFLICT (id) DO NOTHING;

-- Events anchored to "today" so the calendar always has same-day content.
INSERT INTO events (id, user_id, title, start_at, end_at, label_ids, location) VALUES
  ('ev_1', 'u_1', 'Biology lecture',   date_trunc('day', now())+interval '8 hour',  date_trunc('day', now())+interval '9 hour',  '{lb_bio}',          'Room B2 · 158'),
  ('ev_2', 'u_1', 'Calculus tutorial', date_trunc('day', now())+interval '11 hour', date_trunc('day', now())+interval '12 hour 30 minute', '{lb_calc,lb_study}', 'Room 124'),
  ('ev_3', 'u_1', 'History essay due',  date_trunc('day', now())+interval '15 hour', date_trunc('day', now())+interval '16 hour', '{lb_hist,lb_exam}', NULL),
  ('ev_4', 'u_1', 'Study group',        date_trunc('day', now())+interval '1 day 13 hour', date_trunc('day', now())+interval '1 day 15 hour', '{lb_study}', 'Library'),
  ('ev_5', 'u_1', 'Chem midterm',       date_trunc('day', now())+interval '2 day 9 hour',  date_trunc('day', now())+interval '2 day 11 hour', '{lb_exam}', 'Hall A'),
  ('ev_6', 'u_1', 'Past revision',      date_trunc('day', now())-interval '30 day'+interval '10 hour', date_trunc('day', now())-interval '30 day'+interval '11 hour', '{lb_bio}', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tasks (id, user_id, title, meta, done, due_date) VALUES
  ('tk_1', 'u_1', 'Read Chapter 3 — Genetics',      'Biology 101',              false, date_trunc('day', now())+interval '23 hour'),
  ('tk_2', 'u_1', 'Finish integration worksheet',   'Calculus II · 12 problems',false, date_trunc('day', now())+interval '23 hour'),
  ('tk_3', 'u_1', 'Review flashcards',              'Cell organelles',          true,  date_trunc('day', now())+interval '23 hour'),
  ('tk_4', 'u_1', 'Outline history essay this is a very long task title just to test how UI can handle',          'World History this is a very long task title just to test how UI can handle',            false, date_trunc('day', now())+interval '1 day 23 hour'),
  ('tk_5', 'u_1', 'Outline history essay 2',          'World History 2',            false, date_trunc('day', now())+interval '1 day 23 hour')
ON CONFLICT (id) DO NOTHING;

INSERT INTO notifications (id, user_id, kind, title, body, at, read) VALUES
  ('nt_1', 'u_1', 'event',  'Calculus tutorial soon', 'Starts at 11:00 in Room 124.',        now()-interval '1 hour', false),
  ('nt_2', 'u_1', 'quiz',   'New attempt graded',     'Cell biology basics — 8/10.',         now()-interval '5 hour', false),
  ('nt_3', 'u_1', 'system', 'Welcome to Evo Notes',   'Upload your first source to get started.', now()-interval '1 day', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO canvases (id, user_id, name, updated_at) VALUES
  ('cv_1', 'u_1', 'Bio mind map',     now()-interval '4 hour'),
  ('cv_2', 'u_1', 'Essay brainstorm', now()-interval '2 day')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Boot cleanup — this file re-runs on every server start, so any assistant
-- message still marked 'streaming' is orphaned from a crashed/killed stream.
-- Mark them 'aborted' so history loads never surface a stuck bubble.
-- ============================================================================

UPDATE messages SET status='aborted' WHERE status='streaming';
