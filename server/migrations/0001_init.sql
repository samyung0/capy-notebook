-- Evo Notes — development baseline schema + seed.
--
-- Rewritten as a clean baseline on 2026-07-21 (squash of former migrations
-- 0001–0020, with all incremental ALTERs folded into final-form CREATE TABLEs
-- and legacy backfill/reshape logic removed). Assumes a fresh database.
--
-- The startup runner (internal/store.Migrate) re-applies this file on every
-- boot, so everything must stay idempotent: IF NOT EXISTS / ON CONFLICT.
--
-- Extensions: pgvector only. The retrieval chunk store below is owned by this
-- schema (it was LightRAG's before the in-house cutover), so every environment
-- that applies this file needs the vector type — hence pgvector/pgvector:pg16
-- everywhere, including the CI service container (.github/workflows/ci.yml).
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- Baseline version guard
--
-- Because this file is re-applied on every boot, IF NOT EXISTS makes reshaping
-- an existing table impossible. Rather than accumulate conditional ALTERs, the
-- baseline carries a version: when the recorded version does not match the
-- target below, every application table is dropped and recreated from the
-- definitions in this file. A missing record is treated as a mismatch, which
-- covers both a brand-new database (nothing to drop) and one created by an
-- earlier baseline.
--
-- This is only safe because there is no production deployment. Bump
-- target_version on any destructive change to the definitions below.
--
-- The lightrag_* tables are listed even though this file never creates them:
-- the pipeline used to own them, and a database from before the in-house
-- retrieval cutover would otherwise keep them (and their AGE graphs) forever.
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_baseline (
  id      int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version int NOT NULL
);

DO $$
DECLARE
  target_version constant int := 8;
  recorded_version int;
BEGIN
  -- Serialize concurrent migrators. The runner sends this file as one statement
  -- batch, so it executes in a single implicit transaction and this lock is held
  -- for the whole of it. Without it, a second boot (or a parallel test binary)
  -- can drop tables out from under the first, or deadlock against it. The loser
  -- blocks here and then finds the version already current.
  PERFORM pg_advisory_xact_lock(hashtext('evo_schema_baseline'));
  SELECT version INTO recorded_version FROM schema_baseline WHERE id = 1;
  IF recorded_version IS DISTINCT FROM target_version THEN
    DROP TABLE IF EXISTS
      -- editor_asset_uploads and oauth_connections no longer exist in this
      -- file; they stay listed so a database created by an earlier baseline is
      -- cleaned up rather than keeping a stale table forever.
      attempts, blobs, canvases, card_stats, chapters, conversations,
      editor_asset_uploads, editor_assets, email_outbox, entity_tags,
      event_labels, events, files, jobs, labels, lifecycle_notices,
      material_comments, material_discussions, material_revisions,
      material_yjs_documents, materials, messages, mistakes,
      notification_prefs, notifications, oauth_connections,
      pending_blob_deletions,
      rag_chapter_summaries, rag_chunks, rag_concept_mentions, rag_concepts,
      rag_content_summaries, rag_file_contents, rag_contents,
      rag_file_summaries, rag_workspace_summaries,
      tags, tasks, upload_sessions, user_storage,
      user_storage_deltas, user_subscriptions, users, webhook_events,
      workspace_invites, workspace_members, workspaces,
      -- Retired LightRAG storages (see the header note).
      lightrag_doc_chunks, lightrag_doc_full, lightrag_doc_status,
      lightrag_entity_chunks, lightrag_full_entities, lightrag_full_relations,
      lightrag_llm_cache, lightrag_relation_chunks, lightrag_vdb_chunks,
      lightrag_vdb_entity, lightrag_vdb_relation
      CASCADE;
    -- Apache AGE is gone with LightRAG; dropping the extension takes every
    -- per-workspace graph schema with it. Tolerated failure: the library is no
    -- longer preloaded on databases that still carry the extension record.
    BEGIN
      DROP EXTENSION IF EXISTS age CASCADE;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'could not drop the age extension: %', SQLERRM;
    END;
  END IF;
  INSERT INTO schema_baseline (id, version) VALUES (1, target_version)
    ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version;
END $$;

-- ============================================================================
-- Identity, workspaces, content tree
-- ============================================================================

-- The user row is a durable tombstone: application logic never deletes it.
-- Deletion soft-flags the row and scrubs its PII, which keeps preserved
-- authorship (comments, revisions, materials authored inside other people's
-- workspaces) pointing at a real referent, retains the Stripe customer mapping
-- for invoice history, and prevents free-tier re-registration churn.
--
-- email is nullable precisely because purge scrubs it; read paths must
-- COALESCE. The schema-level cascades below still allow a hard DELETE for
-- operational recovery, but nothing in the application performs one.
CREATE TABLE IF NOT EXISTS users (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  email                 text,
  avatar_url            text,
  class_label           text,
  streak                int  NOT NULL DEFAULT 0,
  stripe_customer_id    text UNIQUE,
  subscription_status   text NOT NULL DEFAULT 'none',
  plan_tier             text NOT NULL DEFAULT 'free'
    CHECK (plan_tier IN ('free', 'pro')),
  locale                text NOT NULL DEFAULT 'en',
  -- Account lifecycle. deletion_requested_at starts the reactivation window;
  -- purge_after is when the purge job runs; deleted_at is set by the purge
  -- itself, after which the row is a scrubbed tombstone.
  deletion_requested_at timestamptz,
  purge_after           timestamptz,
  deleted_at            timestamptz,
  -- Suspension is enforced (all writes rejected) but nothing sets it yet;
  -- there is no automated suspension policy.
  suspended_at          timestamptz,
  suspended_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_purge_window_check
    CHECK (purge_after IS NULL OR deletion_requested_at IS NOT NULL),
  CONSTRAINT users_deleted_requires_request_check
    CHECK (deleted_at IS NULL OR deletion_requested_at IS NOT NULL),
  CONSTRAINT users_suspension_reason_check
    CHECK ((suspended_at IS NULL) = (suspended_reason IS NULL))
);
-- Invite resolution looks users up by email, so live accounts must be unique on
-- it. Tombstones are excluded: a scrubbed row holds no email, and a deleted
-- account must not block the address from being used again.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_uidx
  ON users(lower(email))
  WHERE deleted_at IS NULL AND email IS NOT NULL;
-- Keeps the purge sweep bounded.
CREATE INDEX IF NOT EXISTS users_purge_due_idx
  ON users(purge_after)
  WHERE deleted_at IS NULL AND purge_after IS NOT NULL;

-- Foreign keys onto users(id) follow one rule throughout this schema:
--
--   * the ownership / storage-accounting axis cascades, so a hard DELETE of a
--     user is never blocked and the bytes charged to them go with them;
--   * the authorship / attribution axis is nullable ON DELETE SET NULL, so
--     content that lives inside somebody else's workspace survives.
--
-- In practice the SET NULL branches never fire, because deletion is a soft flag
-- and the scrubbed tombstone keeps the reference intact. They exist so that a
-- hard delete degrades to "author unknown" instead of destroying other users'
-- data. Read paths must therefore treat a null author and a tombstoned author
-- identically ("Deleted user").
CREATE TABLE IF NOT EXISTS workspaces (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  position     int  NOT NULL DEFAULT 0,
  -- Redundant with the primary key, but it is the target every composite
  -- (chapter_id, workspace_id) foreign key below needs, which is what stops a
  -- file or material referencing a chapter in a different workspace.
  UNIQUE (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS chapters_ws_idx ON chapters(workspace_id);

CREATE TABLE IF NOT EXISTS files (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Storage owner, derived from the workspace by trigger. This is the
  -- accounting axis, hence CASCADE.
  user_id               text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Uploader. Attribution only: a collaborator's deletion must not remove
  -- files from a workspace they do not own.
  created_by            text REFERENCES users(id) ON DELETE SET NULL,
  chapter_id            text,
  name                  text NOT NULL,
  kind                  text NOT NULL DEFAULT 'pdf',
  -- Mixed file/material order within a chapter (and the unfiled bucket).
  -- clock_timestamp() so concurrent inserts do not collide on now().
  position              bigint NOT NULL DEFAULT
                          (floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint),
  size_bytes            bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  added_at              timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'ready',   -- processing | ready | failed
  -- True after ingest has written retrieval chunks. Viewable files uploaded
  -- with parseMode=none (audio, store-only) stay false.
  indexed               boolean NOT NULL DEFAULT false,
  parser                text,
  engine                text,
  blob_path             text,
  url                   text,
  content               text,
  -- Durable parser artifacts (direct-to-B2 upload pipeline).
  parsed_blob_path      text,
  parsed_fingerprint    text,
  parsed_parser_version text,
  -- Caption cache object; refcounted separately from the parse zip so a
  -- re-parse can drop parsed_blob_path without recaptioning.
  caption_blob_path     text,
  source_etag           text,
  -- sha256 of the parsed text, written by the ingest worker. Two uploads of the
  -- same document into one workspace are stored twice (they are two files the
  -- user can see and delete) but indexed once.
  content_hash          text,
  UNIQUE (id, workspace_id),
  -- The column list on SET NULL is what makes this work: the default form would
  -- try to null workspace_id too, which is NOT NULL. Requires Postgres 15+.
  FOREIGN KEY (chapter_id, workspace_id)
    REFERENCES chapters(id, workspace_id) ON DELETE SET NULL (chapter_id)
);
CREATE INDEX IF NOT EXISTS files_ws_idx ON files(workspace_id);
CREATE INDEX IF NOT EXISTS files_chapter_idx ON files(chapter_id);
CREATE INDEX IF NOT EXISTS files_chapter_position_idx
  ON files(workspace_id, chapter_id, position);
CREATE INDEX IF NOT EXISTS files_user_idx ON files(user_id);
CREATE INDEX IF NOT EXISTS files_content_hash_idx ON files(workspace_id, content_hash);

-- ============================================================================
-- Materials — the universal Plate-document envelope for study artifacts
-- (notes, quizzes, flashcards, mindmaps, diagrams).
-- ============================================================================

CREATE TABLE IF NOT EXISTS materials (
  id             text PRIMARY KEY,
  -- Author. Distinct from owner_user_id: an editor creating a note inside
  -- somebody else's workspace is the creator, while the workspace owner is
  -- charged for the bytes. Cascading this column would let a collaborator's
  -- account deletion destroy content out of the owner's workspace and silently
  -- drop the owner's storage counter, so it is attribution-only.
  created_by     text REFERENCES users(id) ON DELETE SET NULL,
  workspace_id   text REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Storage owner: the workspace owner, or the creator for standalone
  -- materials. This is the accounting axis, hence CASCADE.
  owner_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_name text NOT NULL DEFAULT '',
  -- Membership: which chapter the material is filed under in the workspace
  -- tree (mirrors files.chapter_id). Nullable = unfiled; unfiles on chapter
  -- delete. Orthogonal to scope_chapters/scope_file_names, which record
  -- generation provenance as display-name snapshots rather than references.
  chapter_id     text,
  kind           text NOT NULL,
  title          text NOT NULL DEFAULT '',
  content        jsonb NOT NULL DEFAULT
    '{"schemaVersion":1,"value":[{"type":"p","children":[{"text":""}]}]}'::jsonb,
  scope_chapters text[] NOT NULL DEFAULT '{}',
  scope_file_names text[] NOT NULL DEFAULT '{}',
  privacy        text NOT NULL DEFAULT 'private',
  color          text NOT NULL DEFAULT 'green',
  -- Mixed file/material order within a chapter (and the unfiled bucket).
  position       bigint NOT NULL DEFAULT
                   (floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint),
  size_bytes     bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  node_count     int NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  max_depth      int NOT NULL DEFAULT 0 CHECK (max_depth >= 0),
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
  ),
  -- A standalone material has no workspace, so the composite chapter reference
  -- is only meaningful when it is filed in one.
  CONSTRAINT materials_chapter_requires_workspace_check
    CHECK (chapter_id IS NULL OR workspace_id IS NOT NULL),
  FOREIGN KEY (chapter_id, workspace_id)
    REFERENCES chapters(id, workspace_id) ON DELETE SET NULL (chapter_id)
);
CREATE INDEX IF NOT EXISTS materials_ws_idx ON materials(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS materials_chapter_idx ON materials(chapter_id);
CREATE INDEX IF NOT EXISTS materials_chapter_position_idx
  ON materials(workspace_id, chapter_id, position);
-- Generated artifacts (and notes) share one list per workspace; duplicate
-- titles are indistinguishable there. Standalone clones have no workspace.
CREATE UNIQUE INDEX IF NOT EXISTS materials_workspace_title_uidx
  ON materials (workspace_id, lower(btrim(title)))
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS materials_privacy_idx ON materials(privacy, kind) WHERE privacy = 'public';
CREATE INDEX IF NOT EXISTS materials_creator_idx ON materials(created_by, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS materials_owner_idx ON materials(owner_user_id, created_at DESC);

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
--
-- material_id is deliberately SET NULL rather than CASCADE. The question
-- snapshot and the denormalized quiz_name / workspace_name exist precisely so
-- an attempt outlives the quiz; deleting a quiz must not erase the score
-- history of everyone who took it. The user's own deletion does cascade, since
-- attempts are their personal history.
CREATE TABLE IF NOT EXISTS attempts (
  id             text PRIMARY KEY,
  user_id        text REFERENCES users(id) ON DELETE CASCADE,
  material_id    text REFERENCES materials(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS attempts_user_idx ON attempts(user_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS attempts_material_idx ON attempts(material_id);

-- Per-user mistakes pool backing the "Review mistakes" virtual quiz. `question`
-- is self-contained, so as with attempts the source quiz disappearing only
-- unlinks the row.
CREATE TABLE IF NOT EXISTS mistakes (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  material_id text REFERENCES materials(id) ON DELETE SET NULL,
  question    jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS mistakes_user_idx ON mistakes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mistakes_material_idx ON mistakes(material_id);

-- ============================================================================
-- Tags — per-user, per-kind catalog (deduped by name) + entity link table.
-- Reusing a tag references the same catalog row, so per-tag metadata (future
-- analytics) survives edits and outlives the entities that reference it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tags (
  id         text PRIMARY KEY,
  user_id    text REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,               -- 'workspace' | 'material'
  name       text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tags_user_idx ON tags(user_id);
CREATE INDEX IF NOT EXISTS tags_name_idx ON tags(lower(name));  -- cross-user search
-- Catalog uniqueness: one tag name per user per kind (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS tags_user_kind_name_uidx
  ON tags(user_id, kind, lower(name));

-- Tag links. The reference used to be a polymorphic (kind, entity_id) pair with
-- no foreign key, which left a dangling row behind every workspace and material
-- delete. Real per-type columns make the cleanup a cascade instead of something
-- every delete path has to remember, and the CHECK keeps a row pointing at
-- exactly one entity.
--
-- Orphaned catalog rows are deliberately NOT collected: the tags table exists to
-- outlive the entities referencing it so per-tag metadata survives edits and
-- reuse, and a few hundred bytes per user is not worth the write amplification.
CREATE TABLE IF NOT EXISTS entity_tags (
  tag_id       text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  material_id  text REFERENCES materials(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_tags_single_entity_check
    CHECK (num_nonnulls(workspace_id, material_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS entity_tags_workspace_uidx
  ON entity_tags(workspace_id, tag_id) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entity_tags_material_uidx
  ON entity_tags(material_id, tag_id) WHERE material_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_tags_tag_idx ON entity_tags(tag_id);

-- ============================================================================
-- Personal planner: labels, events, tasks, canvases
-- ============================================================================

CREATE TABLE IF NOT EXISTS labels (
  id      text PRIMARY KEY,
  -- Labels are user-owned calendar categories: ownership axis, so CASCADE.
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  name    text NOT NULL,
  color   text NOT NULL DEFAULT 'green'
);
CREATE INDEX IF NOT EXISTS labels_user_idx ON labels(user_id);

CREATE TABLE IF NOT EXISTS events (
  id        text PRIMARY KEY,
  user_id   text REFERENCES users(id) ON DELETE CASCADE,
  title     text NOT NULL,
  start_at  timestamptz NOT NULL,
  end_at    timestamptz NOT NULL,
  location  text,
  note      text
);
CREATE INDEX IF NOT EXISTS events_user_idx ON events(user_id);

-- Event labels were a text[] of label ids with no referential integrity, so
-- deleting a label left every event referencing it holding a dead id. A join
-- table lets the cascade clean up after itself.
CREATE TABLE IF NOT EXISTS event_labels (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label_id text NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, label_id)
);
CREATE INDEX IF NOT EXISTS event_labels_label_idx ON event_labels(label_id);

CREATE TABLE IF NOT EXISTS tasks (
  id       text PRIMARY KEY,
  user_id  text REFERENCES users(id) ON DELETE CASCADE,
  title    text NOT NULL,
  meta     text,
  done     boolean NOT NULL DEFAULT false,
  due_date timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks(user_id);

CREATE TABLE IF NOT EXISTS canvases (
  id         text PRIMARY KEY,
  user_id    text REFERENCES users(id) ON DELETE CASCADE,
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
  user_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                text NOT NULL,
  data                jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object'),
  href                text,
  workspace_id        text REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Actionable, recipient-only workspace-invitation notifications.
  workspace_invite_id text REFERENCES workspace_invites(id) ON DELETE CASCADE,
  at                  timestamptz NOT NULL DEFAULT now(),
  read_at             timestamptz
);
-- Matches the (at,id) keyset cursor used for pagination; a plain
-- (user_id, at DESC) index would be a redundant prefix of this one.
CREATE INDEX IF NOT EXISTS notifications_user_at_id_idx
  ON notifications(user_id, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications(user_id)
  WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_workspace_invite_idx
  ON notifications(workspace_invite_id)
  WHERE workspace_invite_id IS NOT NULL;

-- Product mail is sent asynchronously from this transactional outbox. The
-- payload is cleared after a successful send because invite payloads contain
-- the one-time plaintext token.
CREATE TABLE IF NOT EXISTS email_outbox (
  id                   text PRIMARY KEY,
  user_id              text REFERENCES users(id) ON DELETE SET NULL,
  to_email             text NOT NULL,
  template             text NOT NULL,
  locale               text NOT NULL DEFAULT 'en',
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key      text UNIQUE,
  status               text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts             int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  provider_message_id  text,
  last_error           text,
  lease_token          text,
  lease_expires_at     timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);
CREATE INDEX IF NOT EXISTS email_outbox_claim_idx
  ON email_outbox(next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS email_outbox_lease_idx
  ON email_outbox(lease_expires_at)
  WHERE status = 'sending';

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id                 text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_workspace_invite  boolean NOT NULL DEFAULT true,
  email_membership        boolean NOT NULL DEFAULT true,
  -- Over-quota / billing buffer warnings. Lifecycle emails (deletion requested,
  -- purge) are always sent and do not consult this flag.
  email_billing           boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for the buffer-period reminder schedule. Kind is scoped to one
-- subscription period_end so a later re-lapse can notify again.
CREATE TABLE IF NOT EXISTS lifecycle_notices (
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  period_end timestamptz NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, period_end)
);
CREATE INDEX IF NOT EXISTS lifecycle_notices_user_idx
  ON lifecycle_notices(user_id, sent_at DESC);

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
  -- Attribution axis: a discussion opened inside somebody else's document must
  -- not vanish because its author left.
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
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
  -- Attribution axis. See material_discussions.created_by.
  user_id           text REFERENCES users(id) ON DELETE SET NULL,
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
-- AI chat persistence. Conversations are workspace-scoped: grounding searches
-- the owning workspace's chunks, so every conversation carries both user_id
-- (ownership) and workspace_id (scope).
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

-- oauth_connections is gone: Clerk owns the OAuth lifecycle for provider
-- integrations and hands out fresh access tokens from its token wallet, so no
-- provider credentials are stored locally. Retaining tokens for deleted
-- accounts would also be a liability the purge path cannot discharge.

-- One row per Stripe subscription. users.plan_tier stays as the denormalized
-- fast read for the storage gate, but it is derived from here.
--
-- current_period_end is what makes the lapse buffer computable at all, and
-- stripe_event_created is the ordering guard: Stripe does not guarantee webhook
-- delivery order, so an older event must never overwrite newer state.
CREATE TABLE IF NOT EXISTS user_subscriptions (
  stripe_subscription_id text PRIMARY KEY,
  user_id                text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                 text NOT NULL,
  price_id               text NOT NULL DEFAULT '',
  plan_tier              text NOT NULL DEFAULT 'free'
    CHECK (plan_tier IN ('free', 'pro')),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  ended_at               timestamptz,
  -- Stripe event `created` (unix seconds) that produced this row's state.
  stripe_event_created   bigint NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_subscriptions_user_idx
  ON user_subscriptions(user_id, current_period_end DESC);
-- Drives the lapse sweep: subscriptions whose paid period has run out.
CREATE INDEX IF NOT EXISTS user_subscriptions_period_end_idx
  ON user_subscriptions(current_period_end)
  WHERE current_period_end IS NOT NULL;

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

-- Summary rollups are debounced rather than queued per edit: moving ten files
-- between chapters should rebuild the tree once. One pending job per workspace
-- is all that can exist, and the trigger below inserts ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_pending_rollup_idx
  ON jobs ((payload->>'workspaceId'))
  WHERE type = 'summaries_rollup' AND status = 'pending';

-- ============================================================================
-- Retrieval store — chunks, the summary tree and the concept index
--
-- Owned by this schema (the Python pipeline writes the rows but no longer owns
-- the DDL), which is what makes deletion automatic: every table cascades from
-- workspaces/files/chapters, so dropping a workspace drops its index with it.
-- No teardown job, and cloning a workspace is an INSERT..SELECT away.
-- ============================================================================

-- Parsed content is canonical within a workspace. Multiple logical files may
-- reference it, so deleting either upload cannot orphan the other file's index.
CREATE TABLE IF NOT EXISTS rag_contents (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  status       text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready')),
  UNIQUE (workspace_id, content_hash),
  UNIQUE (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS rag_file_contents (
  file_id      text PRIMARY KEY,
  workspace_id text NOT NULL,
  content_id   text NOT NULL,
  FOREIGN KEY (file_id, workspace_id)
    REFERENCES files(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (content_id, workspace_id)
    REFERENCES rag_contents(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS rag_file_contents_content_idx ON rag_file_contents(content_id);

-- One retrievable passage. `text` is what a citation shows and what the model
-- reads; `indexed_text` is prefixed with structural headings but not a logical
-- file name, because the same content may be visible through several files.
CREATE TABLE IF NOT EXISTS rag_chunks (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id   text NOT NULL REFERENCES rag_contents(id) ON DELETE CASCADE,
  chunk_idx    int  NOT NULL,
  -- Heading breadcrumb, e.g. 'Chapter 4 › Light reactions'. Empty for formats
  -- without headings.
  section_path text NOT NULL DEFAULT '',
  text         text NOT NULL,
  indexed_text text NOT NULL,
  token_count  int  NOT NULL DEFAULT 0,
  -- 1-based, null for sources with no page model (txt/md, parseMode=normal).
  page_start   int,
  page_end     int,
  -- [{page, bbox: [x0,y0,x1,y1], space}] for every source block in the chunk.
  -- `space` records the coordinate convention so a later highlight overlay does
  -- not have to guess; MinerU emits 'mineru-1000-lefttop'.
  regions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Written by the pipeline, not generated: the tokenizer bigrams CJK runs so
  -- one column serves mixed-language corpora, which no built-in text search
  -- configuration can do.
  search       tsvector,
  -- halfvec because 2560 dims (Qwen3-Embedding-4B) exceeds pgvector's 2000-dim
  -- ceiling for plain vector HNSW. Changing EMBEDDING_DIM means changing this
  -- and re-ingesting; the pipeline hard-fails on a mismatch rather than drift.
  embedding    halfvec(2560),
  UNIQUE (content_id, chunk_idx)
);
CREATE INDEX IF NOT EXISTS rag_chunks_ws_idx ON rag_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS rag_chunks_content_idx ON rag_chunks(content_id);
CREATE INDEX IF NOT EXISTS rag_chunks_search_idx ON rag_chunks USING gin(search);
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
  ON rag_chunks USING hnsw (embedding halfvec_cosine_ops);

-- Summary + outline belong to canonical content, so duplicate logical files
-- share the model output while retaining independent file lifecycles.
CREATE TABLE IF NOT EXISTS rag_content_summaries (
  content_id   text PRIMARY KEY REFERENCES rag_contents(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint  text NOT NULL DEFAULT '',
  summary      text NOT NULL DEFAULT '',
  -- [{title, pageStart}] section headings, the agent's table of contents.
  outline      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rag_content_summaries_ws_idx ON rag_content_summaries(workspace_id);

-- Rolled up from the file summaries below them, never from raw content, which
-- is what keeps invalidation local: a moved file rebuilds two rows from a few
-- KB of existing prose.
CREATE TABLE IF NOT EXISTS rag_chapter_summaries (
  chapter_id   text PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  summary      text NOT NULL DEFAULT '',
  dirty        boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rag_chapter_summaries_dirty_idx
  ON rag_chapter_summaries(workspace_id) WHERE dirty;

-- Files with no chapter roll up here directly, so 'uncategorized' needs no
-- placeholder chapter.
CREATE TABLE IF NOT EXISTS rag_workspace_summaries (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  summary      text NOT NULL DEFAULT '',
  dirty        boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Concept index: the relation-free half of a knowledge graph. Mentions are
-- per-chunk, so unlike an aggregated entity description they filter cleanly by
-- file, and co-mention self-joins give the bridging that relation extraction
-- was supposed to provide.
CREATE TABLE IF NOT EXISTS rag_concepts (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Casefolded/whitespace-collapsed form; the dedup key across files.
  norm         text NOT NULL,
  UNIQUE (workspace_id, norm)
);

CREATE TABLE IF NOT EXISTS rag_concept_mentions (
  concept_id text NOT NULL REFERENCES rag_concepts(id) ON DELETE CASCADE,
  chunk_id   text NOT NULL REFERENCES rag_chunks(id) ON DELETE CASCADE,
  PRIMARY KEY (concept_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS rag_concept_mentions_chunk_idx ON rag_concept_mentions(chunk_id);

CREATE OR REPLACE FUNCTION delete_unreferenced_rag_concept() RETURNS trigger AS $$
BEGIN
  DELETE FROM rag_concepts c
  WHERE c.id = OLD.concept_id
    AND NOT EXISTS (
      SELECT 1 FROM rag_concept_mentions m WHERE m.concept_id = OLD.concept_id
    );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rag_concept_mentions_delete_orphan ON rag_concept_mentions;
CREATE CONSTRAINT TRIGGER rag_concept_mentions_delete_orphan
  AFTER DELETE ON rag_concept_mentions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION delete_unreferenced_rag_concept();

-- Canonical content exists only while at least one logical file references it.
-- File/workspace cascades therefore clean the retrieval index without a job.
CREATE OR REPLACE FUNCTION delete_unreferenced_rag_content() RETURNS trigger AS $$
BEGIN
  DELETE FROM rag_contents c
  WHERE c.id = OLD.content_id
    AND NOT EXISTS (
      SELECT 1 FROM rag_file_contents fc WHERE fc.content_id = OLD.content_id
    );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rag_file_contents_delete_orphan ON rag_file_contents;
CREATE TRIGGER rag_file_contents_delete_orphan
  AFTER DELETE OR UPDATE OF content_id ON rag_file_contents
  FOR EACH ROW EXECUTE FUNCTION delete_unreferenced_rag_content();

-- Reorganizing files invalidates summaries, and the paths that reorganize them
-- are many (move, delete, chapter delete's SET NULL, clone, account purge).
-- A trigger cannot be forgotten by a new writer the way a handler call can.
CREATE OR REPLACE FUNCTION mark_summaries_dirty() RETURNS trigger AS $$
DECLARE
  ws     text;
  ch     text;
  before text;
  after  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ws := OLD.workspace_id; before := OLD.chapter_id;
  ELSIF TG_OP = 'INSERT' THEN
    ws := NEW.workspace_id; after := NEW.chapter_id;
  ELSE
    ws := NEW.workspace_id; before := OLD.chapter_id; after := NEW.chapter_id;
  END IF;

  -- The parent is deleted before its cascade reaches this table, so a workspace
  -- (or account) delete arrives here with nothing left to summarize. Marking it
  -- would fail the foreign key and take the delete down with it.
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ws) THEN
    RETURN NULL;
  END IF;

  FOREACH ch IN ARRAY ARRAY[before, after] LOOP
    CONTINUE WHEN ch IS NULL;
    -- Selected rather than valued for the same reason: deleting a chapter nulls
    -- files.chapter_id through RI, and OLD then names a chapter that is gone.
    INSERT INTO rag_chapter_summaries (chapter_id, workspace_id, dirty)
    SELECT c.id, c.workspace_id, true FROM chapters c WHERE c.id = ch
    ON CONFLICT (chapter_id) DO UPDATE SET dirty = true;
  END LOOP;

  INSERT INTO rag_workspace_summaries (workspace_id, dirty) VALUES (ws, true)
  ON CONFLICT (workspace_id) DO UPDATE SET dirty = true;

  INSERT INTO jobs (id, type, payload)
  VALUES ('job_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10),
          'summaries_rollup', jsonb_build_object('workspaceId', ws))
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- Only chapter membership matters here; content changes mark themselves dirty
-- from the ingest worker, which knows whether the text actually changed.
DROP TRIGGER IF EXISTS files_mark_summaries_dirty ON files;
CREATE TRIGGER files_mark_summaries_dirty
  AFTER INSERT OR DELETE OR UPDATE OF chapter_id ON files
  FOR EACH ROW EXECUTE FUNCTION mark_summaries_dirty();

-- ============================================================================
-- Blob layer: refcounts and the deletion outbox
-- ============================================================================

-- One row per live object in the bucket, refcounted across every table that
-- names it. The count is maintained entirely by triggers rather than by
-- application code, because references disappear through FK cascades — a
-- workspace delete, a material delete, a user purge — where no handler runs.
--
-- Deliberately no size/content_type/etag columns. They already live on the
-- referencing rows, and two rows can legitimately share one path (cloning a
-- workspace copies blob_path rather than duplicating the object), which would
-- leave this table needing a conflict policy for metadata it does not own.
--
-- Deliberately no declared foreign key from files.blob_path or
-- editor_assets.object_path either: the row here is created by the referencing
-- table's AFTER INSERT trigger, so an immediate FK check would fire before it
-- exists. The refcount triggers are the enforcement, and unlike a helper
-- function they cannot be bypassed by a new writer that forgets to call them.
CREATE TABLE IF NOT EXISTS blobs (
  object_path text PRIMARY KEY,
  ref_count   int NOT NULL CHECK (ref_count > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Objects whose last database reference is gone, waiting for the reaper to
-- delete them from B2. Durable, so a failed or crashed delete is retried
-- instead of silently leaking bytes that keep being billed.
CREATE TABLE IF NOT EXISTS pending_blob_deletions (
  object_path text PRIMARY KEY,
  -- Upload paths are queued with a delay: a presigned PUT that lands after the
  -- session row is gone still has to be collected, and deleting before the URL
  -- expires would leave that late object behind forever.
  not_before  timestamptz NOT NULL DEFAULT now(),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_blob_deletions_due_idx
  ON pending_blob_deletions(not_before);

-- ============================================================================
-- Direct browser-to-B2 uploads and editor media assets
-- ============================================================================

-- Editor media stored directly in Backblaze B2. The browser uploads to a
-- short-lived, server-reserved object URL. Plate documents persist only the
-- stable editor_assets.id; read URLs are resolved on demand after
-- workspace/share authorization.
CREATE TABLE IF NOT EXISTS editor_assets (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  purpose      text NOT NULL CHECK (purpose IN ('image','audio','pdf','file')),
  object_path  text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  -- No 'expired' state: an abandoned reservation deletes this row so the
  -- refcount trigger can release its object. A row that stays behind holding a
  -- reference would make its object uncollectable.
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready')),
  etag         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id, workspace_id),
  CHECK (
    (purpose='image' AND size_bytes <= 20971520) OR
    (purpose='audio' AND size_bytes <= 104857600) OR
    (purpose='pdf' AND size_bytes <= 52428800) OR
    (purpose='file' AND size_bytes <= 104857600)
  ),
  CHECK ((status='ready') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS editor_assets_workspace_idx
  ON editor_assets(workspace_id, status);

-- One reservation table for both upload flows. They were separate tables with
-- ~90% identical columns, one shared reservation trigger and two near-duplicate
-- sweepers; target discriminates instead. The destinations stay separate
-- tables, because files and editor_assets diverge in both columns and query
-- patterns, and a single wide table risks an editor asset leaking into the file
-- tree or the RAG ingest scope.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id            text PRIMARY KEY,
  target        text NOT NULL DEFAULT 'source'
    CHECK (target IN ('source','editor_asset')),
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Storage owner (the workspace owner), which is who the reservation is
  -- charged to. created_by is the uploader, carried onto files.created_by when
  -- the session finalizes.
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by    text REFERENCES users(id) ON DELETE SET NULL,
  -- object_path is where the browser PUTs; final_path is where the object is
  -- promoted to on completion. Neither is unique-per-target, so both
  -- constraints stay table-wide.
  object_path   text NOT NULL UNIQUE,
  final_path    text NOT NULL UNIQUE,
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  declared_size bigint NOT NULL CHECK (declared_size >= 0),
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','expired')),
  -- Source-only: the file tree placement and parser selection.
  chapter_id    text,
  chapter_name  text NOT NULL DEFAULT '',
  name          text NOT NULL DEFAULT '',
  kind          text NOT NULL DEFAULT '',
  parse_mode    text NOT NULL DEFAULT '',
  -- Whether the ingest worker should describe the figures this parse extracts.
  -- Chosen per file at reservation time and copied onto the ingest job, because
  -- the choice changes the indexed text and therefore the content hash.
  caption_images boolean NOT NULL DEFAULT false,
  source_etag   text,
  file_id       text REFERENCES files(id) ON DELETE SET NULL,
  -- Editor-asset-only: the pending row in editor_assets this fills in.
  asset_id      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  completed_at  timestamptz,
  FOREIGN KEY (chapter_id, workspace_id)
    REFERENCES chapters(id, workspace_id) ON DELETE SET NULL (chapter_id),
  -- Deleting the asset row takes its reservation with it, which is what keeps
  -- the reserved-bytes counter correct through a workspace cascade.
  FOREIGN KEY (asset_id, workspace_id)
    REFERENCES editor_assets(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_source_fields CHECK (
    target <> 'source' OR (name <> '' AND kind <> '' AND parse_mode <> '')
  ),
  CONSTRAINT upload_sessions_asset_fields CHECK (
    (target = 'editor_asset') = (asset_id IS NOT NULL)
  ),
  CONSTRAINT upload_sessions_file_target CHECK (
    file_id IS NULL OR target = 'source'
  )
);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx
  ON upload_sessions(status, expires_at);
-- Completing an editor-asset upload looks the session up by asset; one live
-- reservation per asset.
CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_asset_uidx
  ON upload_sessions(asset_id) WHERE asset_id IS NOT NULL;

-- ============================================================================
-- Logical storage accounting
-- ============================================================================

-- The counter is deliberately separate from users. Material saves append to
-- user_storage_deltas instead of taking this row lock; creation gates fold the
-- pending deltas into their read before deciding whether to allow a write.
CREATE TABLE IF NOT EXISTS user_storage (
  user_id        text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  used_bytes     bigint NOT NULL DEFAULT 0,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_storage_deltas (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_storage_deltas_user_idx
  ON user_storage_deltas(user_id, id);

CREATE OR REPLACE FUNCTION ensure_user_storage_row(p_user_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'storage owner is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RETURN;
  END IF;
  INSERT INTO user_storage (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION adjust_user_storage_used(p_user_id text, p_delta bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM ensure_user_storage_row(p_user_id);
  UPDATE user_storage
  SET used_bytes = GREATEST(0, used_bytes + p_delta),
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION adjust_user_storage_reserved(p_user_id text, p_delta bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM ensure_user_storage_row(p_user_id);
  UPDATE user_storage
  SET reserved_bytes = GREATEST(0, reserved_bytes + p_delta),
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION append_user_storage_delta(p_user_id text, p_delta bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_delta = 0 THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RETURN;
  END IF;
  PERFORM ensure_user_storage_row(p_user_id);
  INSERT INTO user_storage_deltas (user_id, delta_bytes)
  VALUES (p_user_id, p_delta);
END;
$$;

-- ============================================================================
-- Resource metering (inference, GPU, egress, mail)
-- ============================================================================
--
-- The second budget. Storage above is billed to the workspace owner because
-- the bytes sit in their account; everything here is billed to the *actor* who
-- asked for the work, because the cost is the request itself and it is gone
-- whether or not anything was kept. An editor generating into someone else's
-- workspace spends their own credits and the owner's disk.
--
-- Shape mirrors storage accounting on purpose: an append-only ledger for the
-- hot path, a counter row for the gate to lock, and a reconcile pass to repair
-- drift. Analytics (PostHog) never feeds these tables — it is sampled, ad
-- blockable, and asynchronous, none of which is acceptable for something a
-- user is charged for.

-- usage_events is the source of truth for what was consumed. Append-only:
-- corrections are new rows, never updates, so a replay always reproduces the
-- same balance.
CREATE TABLE IF NOT EXISTS usage_events (
  id             bigserial PRIMARY KEY,
  -- The W3C trace id of the request that caused this. One chat turn produces
  -- several rows (embedding, agent steps, final answer) that share a trace,
  -- which is the only way to answer "what did that one question cost".
  trace_id       text,
  actor_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   text REFERENCES workspaces(id) ON DELETE SET NULL,
  -- What was consumed: llm | embedding | caption | transcribe | parse_gpu |
  -- email | egress.
  kind           text NOT NULL,
  -- Where the user was: chat | generate | editor | ingest | transcribe |
  -- system. Same kind, different product surface.
  surface        text NOT NULL DEFAULT 'system',
  provider       text NOT NULL DEFAULT '',
  model          text NOT NULL DEFAULT '',
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  -- Non-token resources: GPU milliseconds, bytes, message counts.
  units          bigint NOT NULL DEFAULT 0,
  unit           text NOT NULL DEFAULT '',
  -- Internal credits, in millionths, so tier allowances stay integers.
  credit_micros  bigint NOT NULL DEFAULT 0,
  -- Reservation this settles, when the spend was gated in advance.
  reservation_id text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_actor_idx
  ON usage_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_trace_idx
  ON usage_events(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_events_rollup_idx
  ON usage_events(created_at, kind);

-- The counter the spend gate locks. period_start makes the monthly allowance
-- reset lazily on first read of a new month rather than needing a cron that
-- must not be missed.
CREATE TABLE IF NOT EXISTS user_credits (
  user_id         text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  period_start    date NOT NULL DEFAULT date_trunc('month', now())::date,
  used_micros     bigint NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Reservations exist because a post-hoc ledger lets two concurrent requests
-- both pass a gate that neither would pass alone. Reserve an estimate, settle
-- the measured cost, and sweep whatever leaked — the same lifecycle as
-- upload_sessions.
CREATE TABLE IF NOT EXISTS credit_reservations (
  id             text PRIMARY KEY,
  actor_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   text REFERENCES workspaces(id) ON DELETE SET NULL,
  trace_id       text,
  surface        text NOT NULL DEFAULT 'system',
  amount_micros  bigint NOT NULL,
  status         text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'settled', 'released')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  settled_at     timestamptz
);
CREATE INDEX IF NOT EXISTS credit_reservations_open_idx
  ON credit_reservations(expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS credit_reservations_actor_idx
  ON credit_reservations(actor_user_id, created_at DESC);

-- Pre-aggregated for the operator dashboard. Dashboard queries must never scan
-- the raw ledger: it is the same database serving chat requests.
CREATE TABLE IF NOT EXISTS usage_daily (
  day           date NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  surface       text NOT NULL DEFAULT '',
  provider      text NOT NULL DEFAULT '',
  model         text NOT NULL DEFAULT '',
  events        bigint NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  units         bigint NOT NULL DEFAULT 0,
  credit_micros bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, actor_user_id, kind, surface, provider, model)
);
CREATE INDEX IF NOT EXISTS usage_daily_day_idx ON usage_daily(day DESC);

-- Watermark for the rollup job, so a restart resumes instead of recomputing.
CREATE TABLE IF NOT EXISTS usage_rollup_state (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_event_id       bigint NOT NULL DEFAULT 0,
  last_run_at         timestamptz
);
INSERT INTO usage_rollup_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Operator access (internal ops dashboard)
-- ============================================================================
--
-- Membership is the entire authorization model, and there is deliberately no
-- API that grants it: a row is inserted by hand against the database. An
-- escalation path reachable from the product would make every bug in the
-- product a path to everyone's data.
CREATE TABLE IF NOT EXISTS operators (
  user_id      text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'admin')),
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE OR REPLACE FUNCTION set_file_storage_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT w.user_id INTO NEW.user_id
  FROM workspaces w
  WHERE w.id = NEW.workspace_id;
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'workspace % has no storage owner', NEW.workspace_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_upload_storage_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT w.user_id INTO NEW.user_id
  FROM workspaces w
  WHERE w.id = NEW.workspace_id;
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'workspace % has no storage owner', NEW.workspace_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_editor_asset_storage_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT w.user_id INTO NEW.user_id
  FROM workspaces w
  WHERE w.id = NEW.workspace_id;
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'workspace % has no storage owner', NEW.workspace_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prepare_material_storage_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Ownership is derived on insert and on a workspace move only, never from a
  -- later authorship change: created_by is nulled when an author's account is
  -- hard-deleted, and re-deriving there would both re-own the row and fail
  -- outright once the surrounding cascade has already removed the workspace.
  -- Ownership transfer therefore has to rewrite owner_user_id explicitly.
  IF TG_OP = 'INSERT' OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    IF NEW.workspace_id IS NULL THEN
      -- Standalone material: the creator is also the storage owner.
      NEW.owner_user_id = NEW.created_by;
    ELSE
      SELECT w.user_id INTO NEW.owner_user_id
      FROM workspaces w
      WHERE w.id = NEW.workspace_id;
    END IF;
    IF NEW.owner_user_id IS NULL THEN
      RAISE EXCEPTION 'material % has no storage owner', NEW.id;
    END IF;
  END IF;
  NEW.size_bytes = octet_length(NEW.content::text);
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Blob refcounting
-- ---------------------------------------------------------------------------

-- blob_enqueue_deletion is the only writer of the outbox. It refuses to queue a
-- path something still points at, which is what makes it safe for the
-- upload-session trigger to queue final_path unconditionally: if the session
-- completed, the file that took the path over holds a reference.
CREATE OR REPLACE FUNCTION blob_enqueue_deletion(p_path text, p_delay interval)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_path IS NULL OR p_path = '' THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM blobs WHERE object_path = p_path) THEN
    RETURN;
  END IF;
  INSERT INTO pending_blob_deletions (object_path, not_before)
  VALUES (p_path, now() + p_delay)
  ON CONFLICT (object_path) DO UPDATE
    SET not_before = greatest(pending_blob_deletions.not_before, excluded.not_before);
END;
$$;

CREATE OR REPLACE FUNCTION blob_ref(p_path text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_path IS NULL OR p_path = '' THEN
    RETURN;
  END IF;
  INSERT INTO blobs (object_path, ref_count) VALUES (p_path, 1)
  ON CONFLICT (object_path) DO UPDATE SET ref_count = blobs.ref_count + 1;
  -- A queued path can come back to life: cloning a workspace re-references a
  -- path whose last file was just deleted. Cancelling the queued delete is what
  -- stops the reaper removing an object that is live again.
  DELETE FROM pending_blob_deletions WHERE object_path = p_path;
END;
$$;

CREATE OR REPLACE FUNCTION blob_unref(p_path text, p_delay interval)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  remaining int;
BEGIN
  IF p_path IS NULL OR p_path = '' THEN
    RETURN;
  END IF;
  -- Decrement only while other references remain; the last one deletes the row
  -- so the CHECK (ref_count > 0) invariant holds without a zero state.
  UPDATE blobs SET ref_count = ref_count - 1
  WHERE object_path = p_path AND ref_count > 1
  RETURNING ref_count INTO remaining;
  IF remaining IS NOT NULL THEN
    RETURN;
  END IF;
  DELETE FROM blobs WHERE object_path = p_path;
  PERFORM blob_enqueue_deletion(p_path, p_delay);
END;
$$;

-- One function for every table that names blob paths. The columns arrive as
-- trigger arguments and are read through to_jsonb, so files (two blob columns)
-- and editor_assets (one) share it. Row-level AFTER triggers fire on FK
-- cascades, which is the entire point: a workspace or user delete never runs
-- handler code, and this is what keeps the bucket in step with it.
CREATE OR REPLACE FUNCTION account_blob_refs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  col      text;
  old_row  jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_row  jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  old_path text;
  new_path text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    old_path := old_row ->> col;
    new_path := new_row ->> col;
    IF old_path IS DISTINCT FROM new_path THEN
      -- Reference before dereference, so a path moving between two rows in one
      -- statement is never briefly unreferenced and queued for deletion.
      PERFORM blob_ref(new_path);
      PERFORM blob_unref(old_path, interval '0');
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- How long a vanished upload session's objects sit before the reaper takes
-- them. It has to outlast the presigned PUT URL: a request already in flight
-- can still create the object after the row is gone, and deleting early would
-- leave that object unreferenced and unqueued forever.
CREATE OR REPLACE FUNCTION account_upload_blob_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM blob_enqueue_deletion(OLD.object_path, interval '1 day');
  PERFORM blob_enqueue_deletion(OLD.final_path, interval '1 day');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION account_file_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM adjust_user_storage_used(NEW.user_id, NEW.size_bytes);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM adjust_user_storage_used(OLD.user_id, -OLD.size_bytes);
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    PERFORM adjust_user_storage_used(OLD.user_id, -OLD.size_bytes);
    PERFORM adjust_user_storage_used(NEW.user_id, NEW.size_bytes);
  ELSIF OLD.size_bytes IS DISTINCT FROM NEW.size_bytes THEN
    PERFORM adjust_user_storage_used(NEW.user_id, NEW.size_bytes - OLD.size_bytes);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION account_material_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM adjust_user_storage_used(NEW.owner_user_id, NEW.size_bytes);
  ELSIF TG_OP = 'DELETE' THEN
    -- Material edits are ledger-backed. Keep deletion in the same ledger so
    -- a pending growth delta cannot be stranded above a clamped base counter.
    PERFORM append_user_storage_delta(OLD.owner_user_id, -OLD.size_bytes);
  ELSIF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    PERFORM append_user_storage_delta(OLD.owner_user_id, -OLD.size_bytes);
    PERFORM append_user_storage_delta(NEW.owner_user_id, NEW.size_bytes);
  ELSIF OLD.size_bytes IS DISTINCT FROM NEW.size_bytes THEN
    PERFORM append_user_storage_delta(NEW.owner_user_id, NEW.size_bytes - OLD.size_bytes);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION account_upload_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_pending boolean := false;
  new_pending boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_pending := OLD.status = 'pending';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_pending := NEW.status = 'pending';
  END IF;

  IF old_pending AND NOT new_pending THEN
    PERFORM adjust_user_storage_reserved(OLD.user_id, -OLD.declared_size);
  ELSIF NOT old_pending AND new_pending THEN
    PERFORM adjust_user_storage_reserved(NEW.user_id, NEW.declared_size);
  ELSIF old_pending AND new_pending
    AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    -- Ownership transfer moves a live reservation, and the counter has to move
    -- with it or the old owner is charged for bytes they can no longer see.
    PERFORM adjust_user_storage_reserved(OLD.user_id, -OLD.declared_size);
    PERFORM adjust_user_storage_reserved(NEW.user_id, NEW.declared_size);
  ELSIF old_pending AND new_pending
    AND OLD.declared_size IS DISTINCT FROM NEW.declared_size THEN
    PERFORM adjust_user_storage_reserved(
      NEW.user_id, NEW.declared_size - OLD.declared_size
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION account_editor_asset_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_ready boolean := false;
  new_ready boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_ready := OLD.status = 'ready';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_ready := NEW.status = 'ready';
  END IF;
  IF TG_OP = 'INSERT' AND new_ready THEN
    PERFORM adjust_user_storage_used(NEW.user_id, NEW.size_bytes);
  ELSIF TG_OP = 'DELETE' AND old_ready THEN
    PERFORM adjust_user_storage_used(OLD.user_id, -OLD.size_bytes);
  ELSIF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    IF old_ready THEN
      PERFORM adjust_user_storage_used(OLD.user_id, -OLD.size_bytes);
    END IF;
    IF new_ready THEN
      PERFORM adjust_user_storage_used(NEW.user_id, NEW.size_bytes);
    END IF;
  ELSIF TG_OP = 'UPDATE' AND old_ready AND NOT new_ready THEN
    PERFORM adjust_user_storage_used(OLD.user_id, -OLD.size_bytes);
  ELSIF TG_OP = 'UPDATE' AND NOT old_ready AND new_ready THEN
    PERFORM adjust_user_storage_used(NEW.user_id, NEW.size_bytes);
  ELSIF TG_OP = 'UPDATE' AND old_ready AND new_ready
    AND OLD.size_bytes IS DISTINCT FROM NEW.size_bytes THEN
    PERFORM adjust_user_storage_used(NEW.user_id, NEW.size_bytes - OLD.size_bytes);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS files_storage_owner_before ON files;
CREATE TRIGGER files_storage_owner_before
BEFORE INSERT OR UPDATE OF workspace_id ON files
FOR EACH ROW EXECUTE FUNCTION set_file_storage_owner();
DROP TRIGGER IF EXISTS files_storage_after ON files;
CREATE TRIGGER files_storage_after
AFTER INSERT OR UPDATE OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION account_file_storage();
DROP TRIGGER IF EXISTS files_blob_refs_after ON files;
CREATE TRIGGER files_blob_refs_after
AFTER INSERT OR UPDATE OF blob_path, parsed_blob_path OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('blob_path', 'parsed_blob_path', 'caption_blob_path');

DROP TRIGGER IF EXISTS upload_sessions_storage_owner_before ON upload_sessions;
CREATE TRIGGER upload_sessions_storage_owner_before
BEFORE INSERT OR UPDATE OF workspace_id ON upload_sessions
FOR EACH ROW EXECUTE FUNCTION set_upload_storage_owner();
DROP TRIGGER IF EXISTS upload_sessions_reservation_after ON upload_sessions;
CREATE TRIGGER upload_sessions_reservation_after
AFTER UPDATE OR DELETE ON upload_sessions
FOR EACH ROW EXECUTE FUNCTION account_upload_reservation();
DROP TRIGGER IF EXISTS upload_sessions_blob_deletion_after ON upload_sessions;
CREATE TRIGGER upload_sessions_blob_deletion_after
AFTER DELETE ON upload_sessions
FOR EACH ROW EXECUTE FUNCTION account_upload_blob_deletion();

DROP TRIGGER IF EXISTS editor_assets_storage_owner_before ON editor_assets;
CREATE TRIGGER editor_assets_storage_owner_before
BEFORE INSERT OR UPDATE OF workspace_id ON editor_assets
FOR EACH ROW EXECUTE FUNCTION set_editor_asset_storage_owner();
DROP TRIGGER IF EXISTS editor_assets_blob_refs_after ON editor_assets;
CREATE TRIGGER editor_assets_blob_refs_after
AFTER INSERT OR UPDATE OF object_path OR DELETE ON editor_assets
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('object_path');
DROP TRIGGER IF EXISTS editor_assets_storage_after ON editor_assets;
CREATE TRIGGER editor_assets_storage_after
AFTER INSERT OR UPDATE OR DELETE ON editor_assets
FOR EACH ROW EXECUTE FUNCTION account_editor_asset_storage();

DROP TRIGGER IF EXISTS materials_storage_before ON materials;
CREATE TRIGGER materials_storage_before
BEFORE INSERT OR UPDATE OF workspace_id, content ON materials
FOR EACH ROW EXECUTE FUNCTION prepare_material_storage_fields();
DROP TRIGGER IF EXISTS materials_storage_after ON materials;
CREATE TRIGGER materials_storage_after
AFTER INSERT OR UPDATE OR DELETE ON materials
FOR EACH ROW EXECUTE FUNCTION account_material_storage();

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

INSERT INTO files (id, workspace_id, chapter_id, name, kind, size_bytes, added_at, status, indexed, url, content) VALUES
  ('f_1', 'ws_bio',  'ch_1', 'Cell structure.pdf',       'pdf',   2480 * 1024, now()-interval '20 day', 'ready', true, 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf', NULL),
  ('f_2', 'ws_bio',  'ch_1', 'Organelles cheatsheet.md', 'md',      14 * 1024, now()-interval '19 day', 'ready', true, NULL, '# Organelles

- **Nucleus** — stores DNA, controls the cell.
- **Mitochondria** — the powerhouse; ATP via respiration.
- **Ribosomes** — protein synthesis.
- **Golgi apparatus** — packaging & shipping.

The cell membrane is a *phospholipid bilayer* that controls what enters and leaves.'),
  ('f_3', 'ws_bio',  'ch_2', 'Osmosis notes.txt',        'txt',      6 * 1024, now()-interval '18 day', 'ready', true, NULL, 'Osmosis is the diffusion of water across a semi-permeable membrane from low to high solute concentration.'),
  ('f_4', 'ws_bio',  'ch_3', 'Mendelian genetics.pdf',   'pdf',   1890 * 1024, now()-interval '15 day', 'ready', true, 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf', NULL),
  ('f_5', 'ws_bio',  NULL,   'Punnett squares.png',      'image',  420 * 1024, now()-interval '14 day', 'ready', true, NULL, NULL),
  ('f_6', 'ws_calc', 'ch_c1','Integration by parts.pdf', 'pdf',    980 * 1024, now()-interval '10 day', 'ready', true, 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf', NULL),
  ('f_7', 'ws_calc', 'ch_c2','Taylor series.md',         'md',      11 * 1024, now()-interval '9 day',  'ready', true, NULL, '# Taylor series

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
INSERT INTO entity_tags (workspace_id, tag_id)
  SELECT v.entity_id, t.id
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

INSERT INTO materials (id, created_by, workspace_id, workspace_name, kind, title, content, scope_chapters, scope_file_names, privacy, color, created_at) VALUES
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
       '{}'::jsonb, created_by, created_at
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

INSERT INTO attempts (id, user_id, material_id, quiz_name, workspace_name, chapters, correct, total, pct, taken_at) VALUES
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
INSERT INTO events (id, user_id, title, start_at, end_at, location) VALUES
  ('ev_1', 'u_1', 'Biology lecture',   date_trunc('day', now())+interval '8 hour',  date_trunc('day', now())+interval '9 hour',  'Room B2 · 158'),
  ('ev_2', 'u_1', 'Calculus tutorial', date_trunc('day', now())+interval '11 hour', date_trunc('day', now())+interval '12 hour 30 minute', 'Room 124'),
  ('ev_3', 'u_1', 'History essay due',  date_trunc('day', now())+interval '15 hour', date_trunc('day', now())+interval '16 hour', NULL),
  ('ev_4', 'u_1', 'Study group',        date_trunc('day', now())+interval '1 day 13 hour', date_trunc('day', now())+interval '1 day 15 hour', 'Library'),
  ('ev_5', 'u_1', 'Chem midterm',       date_trunc('day', now())+interval '2 day 9 hour',  date_trunc('day', now())+interval '2 day 11 hour', 'Hall A'),
  ('ev_6', 'u_1', 'Past revision',      date_trunc('day', now())-interval '30 day'+interval '10 hour', date_trunc('day', now())-interval '30 day'+interval '11 hour', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO event_labels (event_id, label_id) VALUES
  ('ev_1', 'lb_bio'),
  ('ev_2', 'lb_calc'), ('ev_2', 'lb_study'),
  ('ev_3', 'lb_hist'), ('ev_3', 'lb_exam'),
  ('ev_4', 'lb_study'),
  ('ev_5', 'lb_exam'),
  ('ev_6', 'lb_bio')
ON CONFLICT DO NOTHING;

INSERT INTO tasks (id, user_id, title, meta, done, due_date) VALUES
  ('tk_1', 'u_1', 'Read Chapter 3 — Genetics',      'Biology 101',              false, date_trunc('day', now())+interval '23 hour'),
  ('tk_2', 'u_1', 'Finish integration worksheet',   'Calculus II · 12 problems',false, date_trunc('day', now())+interval '23 hour'),
  ('tk_3', 'u_1', 'Review flashcards',              'Cell organelles',          true,  date_trunc('day', now())+interval '23 hour'),
  ('tk_4', 'u_1', 'Outline history essay this is a very long task title just to test how UI can handle',          'World History this is a very long task title just to test how UI can handle',            false, date_trunc('day', now())+interval '1 day 23 hour'),
  ('tk_5', 'u_1', 'Outline history essay 2',          'World History 2',            false, date_trunc('day', now())+interval '1 day 23 hour')
ON CONFLICT (id) DO NOTHING;

INSERT INTO notifications (id, user_id, kind, data, at, read_at) VALUES
  ('nt_1', 'u_1', 'event',  '{"code":"event_starting","eventName":"Calculus tutorial","time":"11:00","location":"Room 124"}', now()-interval '1 hour', NULL),
  ('nt_2', 'u_1', 'quiz',   '{"code":"quiz_attempt_graded","quizName":"Cell biology basics","score":"8/10"}', now()-interval '5 hour', NULL),
  ('nt_3', 'u_1', 'system', '{"code":"welcome"}', now()-interval '1 day', now()-interval '1 day')
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
