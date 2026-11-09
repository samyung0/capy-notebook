-- Chapters become topics (Epo 2026-11-03, human/study-progress.md): one flat
-- list per workspace that groups files and later tags questions, so a topic
-- keeps an optional one-line description for that tagging. A file has at most
-- one topic; files without one are Other files. No legacy data: the rename
-- moves nothing but names and the stored 'chapter' kinds.
ALTER TABLE chapters RENAME TO topics;
ALTER TABLE files RENAME COLUMN chapter_id TO topic_id;
ALTER TABLE materials RENAME COLUMN chapter_id TO topic_id;
ALTER TABLE materials RENAME COLUMN scope_chapters TO scope_topics;
ALTER TABLE attempts RENAME COLUMN chapters TO topics;
ALTER TABLE upload_sessions RENAME COLUMN chapter_id TO topic_id;
ALTER TABLE upload_sessions RENAME COLUMN chapter_name TO topic_name;
ALTER TABLE review_sessions RENAME COLUMN chapter_id TO topic_id;

-- Constraint and index names follow (defaults such as chapters_pkey or
-- files_chapter_id_workspace_id_fkey, and the named ones).
DO $rename$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.connamespace = 'public'::regnamespace AND c.conname LIKE '%chapter%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
      r.tbl, r.conname, replace(r.conname, 'chapter', 'topic'));
  END LOOP;
  FOR r IN
    SELECT i.relname
    FROM pg_class i
    WHERE i.relkind = 'i' AND i.relnamespace = 'public'::regnamespace
      AND i.relname LIKE '%chapter%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, replace(r.relname, 'chapter', 'topic'));
  END LOOP;
END
$rename$;

ALTER TABLE topics ADD COLUMN description text NOT NULL DEFAULT ''
  CHECK (char_length(description) <= 200);

ALTER TABLE review_sessions DROP CONSTRAINT review_sessions_group_kind_check;
UPDATE review_sessions SET group_kind = 'topic' WHERE group_kind = 'chapter';
ALTER TABLE review_sessions ADD CONSTRAINT review_sessions_group_kind_check
  CHECK (group_kind IN ('topic','others','workspace','plan'));

ALTER TABLE agent_operations DROP CONSTRAINT agent_operations_kind_check;
UPDATE agent_operations SET kind = 'create_topic' WHERE kind = 'create_chapter';
ALTER TABLE agent_operations ADD CONSTRAINT agent_operations_kind_check CHECK (kind IN (
  'create_material','edit_document','undo_edit','trash','restore','purge','create_workspace',
  'create_topic'));

-- Topic cap by the workspace owner's plan (Epo 2026-11-03): 10 on Free, 20 on
-- Pro. A workspace already past it keeps its topics and adds no more.
ALTER TABLE plan_limits ADD COLUMN topics_per_workspace int;
UPDATE plan_limits SET topics_per_workspace = CASE plan_tier
  WHEN 'free' THEN 10
  WHEN 'pro' THEN 20
END;
ALTER TABLE plan_limits
  ALTER COLUMN topics_per_workspace SET NOT NULL,
  ADD CONSTRAINT plan_limits_topics_per_workspace_check CHECK (topics_per_workspace > 0);

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capy_ops') THEN
    GRANT SELECT (topics_per_workspace) ON plan_limits TO capy_ops;
  END IF;
END
$grant$;
