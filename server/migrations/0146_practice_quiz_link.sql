-- Make my own practice (Epo 2026-11-04). A reader's generated quiz is their own
-- standalone material, so only they can reach it and it is charged to them, and
-- nothing a workspace lists, searches, clones or retrieves can show it. These
-- link it back for its maker's study reads only: it joins that workspace's
-- Practice and its answers count toward the topic. A deleted workspace or topic
-- leaves the quiz in its maker's Files.
ALTER TABLE materials
  ADD COLUMN practice_workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  ADD COLUMN practice_topic_id text REFERENCES topics(id) ON DELETE SET NULL;
CREATE INDEX materials_practice_workspace_idx ON materials(practice_workspace_id, owner_user_id)
  WHERE practice_workspace_id IS NOT NULL;
