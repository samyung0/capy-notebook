-- Isolated sharing fixtures for Playwright / Go access tests.
-- Applied after migrations by e2e global setup.

BEGIN;

DELETE FROM attempts WHERE user_id IN ('u_owner', 'u_editor', 'u_commenter', 'u_viewer', 'u_other');
DELETE FROM mistakes WHERE user_id IN ('u_owner', 'u_editor', 'u_commenter', 'u_viewer', 'u_other');
DELETE FROM materials WHERE user_id IN ('u_owner', 'u_editor', 'u_commenter', 'u_viewer', 'u_other');
DELETE FROM workspace_members WHERE user_id IN ('u_owner', 'u_editor', 'u_commenter', 'u_viewer', 'u_other');
DELETE FROM workspaces WHERE user_id IN ('u_owner', 'u_editor', 'u_commenter', 'u_viewer', 'u_other');

INSERT INTO users (id, name, email, class_label, streak) VALUES
  ('u_owner',  'E2E Owner',  'owner@evonotes.test',  'E2E', 0),
  ('u_editor', 'E2E Editor', 'editor@evonotes.test', 'E2E', 0),
  ('u_commenter', 'E2E Commenter', 'commenter@evonotes.test', 'E2E', 0),
  ('u_viewer', 'E2E Viewer', 'viewer@evonotes.test', 'E2E', 0),
  ('u_other',  'E2E Other',  'other@evonotes.test',  'E2E', 0)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  email = EXCLUDED.email;

INSERT INTO workspaces (id, user_id, name, color, privacy, share_role, created_at, last_accessed_at) VALUES
  ('ws_e2e_private', 'u_owner', 'E2E Private Workspace', 'green',  'private', 'viewer', now(), now()),
  ('ws_e2e_link',    'u_owner', 'E2E Link Workspace',    'purple', 'link',    'viewer', now(), now()),
  ('ws_e2e_public',  'u_owner', 'E2E Public Workspace',  'blue',   'public',  'commenter', now(), now()),
  ('ws_e2e_edit',    'u_owner', 'E2E Editable Link Workspace', 'coral', 'link', 'editor', now(), now()),
  ('ws_e2e_invite',  'u_owner', 'E2E Invite Only Workspace', 'graphite', 'private', 'viewer', now(), now()),
  ('ws_e2e_mutate',  'u_owner', 'E2E Mutate Workspace',  'amber',  'private', 'viewer', now(), now())
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  name = EXCLUDED.name,
  privacy = EXCLUDED.privacy,
  share_role = EXCLUDED.share_role;

INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
  ('ws_e2e_private', 'u_owner',  'owner'),
  ('ws_e2e_link',    'u_owner',  'owner'),
  ('ws_e2e_public',  'u_owner',  'owner'),
  ('ws_e2e_edit',    'u_owner',  'owner'),
  ('ws_e2e_invite',  'u_owner',  'owner'),
  ('ws_e2e_mutate',  'u_owner',  'owner'),
  ('ws_e2e_private', 'u_editor', 'editor'),
  ('ws_e2e_private', 'u_commenter', 'commenter'),
  ('ws_e2e_private', 'u_viewer', 'viewer')
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;

INSERT INTO chapters (id, workspace_id, name, position) VALUES
  ('ch_e2e_private', 'ws_e2e_private', 'Private chapter', 0),
  ('ch_e2e_link',    'ws_e2e_link',    'Link chapter',    0),
  ('ch_e2e_public',  'ws_e2e_public',  'Public chapter',  0),
  ('ch_e2e_edit',    'ws_e2e_edit',    'Editable link chapter', 0),
  ('ch_e2e_invite',  'ws_e2e_invite',  'Invite only chapter', 0),
  ('ch_e2e_mutate',  'ws_e2e_mutate',  'Mutate chapter',  0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO files (id, workspace_id, chapter_id, name, kind, size_kb, added_at, status, content) VALUES
  ('f_e2e_private', 'ws_e2e_private', 'ch_e2e_private', 'secret-notes.md', 'md', 1, now(), 'ready',
   '# Secret private notes\nOnly owner and editor should see this.'),
  ('f_e2e_link', 'ws_e2e_link', 'ch_e2e_link', 'shared-notes.md', 'md', 1, now(), 'ready',
   '# Shared link notes\nAnyone with the link can read this.'),
  ('f_e2e_public', 'ws_e2e_public', 'ch_e2e_public', 'public-notes.md', 'md', 1, now(), 'ready',
   '# Public notes\nDiscoverable on Explore.'),
  ('f_e2e_edit', 'ws_e2e_edit', 'ch_e2e_edit', 'editable-notes.md', 'md', 1, now(), 'ready',
   '# Editable shared notes\nMaterial content may be edited by signed-in visitors.')
ON CONFLICT (id) DO NOTHING;

-- Minimal Plate quiz / flashcard documents.
INSERT INTO materials (
  id, user_id, workspace_id, workspace_name, kind, title, content,
  chapter_id, scope_chapters, scope_file_ids, privacy, color, created_at, updated_at, revision, updated_by
) VALUES
  (
    'qz_e2e_private', 'u_owner', 'ws_e2e_private', 'E2E Private Workspace', 'quiz',
    'E2E Private Quiz',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"qz_e2e_private:title","children":[{"text":"E2E Private Quiz"}]},{"type":"quiz","id":"qz_e2e_private:quiz","timeLimitMin":15,"children":[{"type":"quiz_question","id":"q_priv_1","questionType":"boolean","level":"recall","correctBoolean":true,"children":[{"type":"quiz_prompt","children":[{"text":"Private quiz prompt?"}]}]}]}]}'::jsonb,
    'ch_e2e_private', '{Private chapter}', '{}', 'private', 'green', now(), now(), 1, 'u_owner'
  ),
  (
    'qz_e2e_link', 'u_owner', NULL, '', 'quiz',
    'E2E Link Quiz',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"qz_e2e_link:title","children":[{"text":"E2E Link Quiz"}]},{"type":"quiz","id":"qz_e2e_link:quiz","children":[{"type":"quiz_question","id":"q_link_1","questionType":"boolean","level":"recall","correctBoolean":true,"children":[{"type":"quiz_prompt","children":[{"text":"Link quiz prompt?"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'link', 'purple', now(), now(), 1, 'u_owner'
  ),
  (
    'qz_e2e_public', 'u_owner', NULL, '', 'quiz',
    'E2E Public Quiz',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"qz_e2e_public:title","children":[{"text":"E2E Public Quiz"}]},{"type":"quiz","id":"qz_e2e_public:quiz","children":[{"type":"quiz_question","id":"q_pub_1","questionType":"boolean","level":"recall","correctBoolean":false,"children":[{"type":"quiz_prompt","children":[{"text":"Public quiz prompt?"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'public', 'blue', now(), now(), 1, 'u_owner'
  ),
  (
    'qz_e2e_mutate', 'u_owner', NULL, '', 'quiz',
    'E2E Mutate Quiz',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"qz_e2e_mutate:title","children":[{"text":"E2E Mutate Quiz"}]},{"type":"quiz","id":"qz_e2e_mutate:quiz","children":[{"type":"quiz_question","id":"q_mut_1","questionType":"boolean","level":"recall","correctBoolean":true,"children":[{"type":"quiz_prompt","children":[{"text":"Mutate quiz prompt?"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'private', 'amber', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_private', 'u_owner', 'ws_e2e_private', 'E2E Private Workspace', 'flashcards',
    'E2E Private Deck',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"dk_e2e_private:title","children":[{"text":"E2E Private Deck"}]},{"type":"flashcards","id":"dk_e2e_private:flashcards","children":[{"type":"flashcard","id":"c_e2e_priv_1","children":[{"type":"flashcard_front","children":[{"text":"Private front"}]},{"type":"flashcard_back","children":[{"text":"Private back"}]}]}]}]}'::jsonb,
    'ch_e2e_private', '{}', '{}', 'private', 'green', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_link', 'u_owner', NULL, '', 'flashcards',
    'E2E Link Deck',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"dk_e2e_link:title","children":[{"text":"E2E Link Deck"}]},{"type":"flashcards","id":"dk_e2e_link:flashcards","children":[{"type":"flashcard","id":"c_e2e_link_1","children":[{"type":"flashcard_front","children":[{"text":"Link front"}]},{"type":"flashcard_back","children":[{"text":"Link back"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'link', 'purple', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_public', 'u_owner', NULL, '', 'flashcards',
    'E2E Public Deck',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"dk_e2e_public:title","children":[{"text":"E2E Public Deck"}]},{"type":"flashcards","id":"dk_e2e_public:flashcards","children":[{"type":"flashcard","id":"c_e2e_pub_1","children":[{"type":"flashcard_front","children":[{"text":"Public front"}]},{"type":"flashcard_back","children":[{"text":"Public back"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'public', 'blue', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_mutate', 'u_owner', NULL, '', 'flashcards',
    'E2E Mutate Deck',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"dk_e2e_mutate:title","children":[{"text":"E2E Mutate Deck"}]},{"type":"flashcards","id":"dk_e2e_mutate:flashcards","children":[{"type":"flashcard","id":"c_e2e_mut_1","children":[{"type":"flashcard_front","children":[{"text":"Mutate front"}]},{"type":"flashcard_back","children":[{"text":"Mutate back"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'private', 'amber', now(), now(), 1, 'u_owner'
  ),
  (
    'note_e2e_private', 'u_owner', 'ws_e2e_private', 'E2E Private Workspace', 'note',
    'Secret private title',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_private:title","children":[{"text":"Secret private title"}]},{"type":"p","id":"note_e2e_private:body","children":[{"text":"Hidden body"}]}]}'::jsonb,
    'ch_e2e_private', '{}', '{}', 'private', 'green', now(), now(), 1, 'u_owner'
  ),
  (
    'note_e2e_link', 'u_owner', 'ws_e2e_link', 'E2E Link Workspace', 'note',
    'E2E Viewer Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_link:title","children":[{"text":"E2E Viewer Note"}]},{"type":"p","id":"note_e2e_link:body","children":[{"text":"Static viewer content"}]}]}'::jsonb,
    'ch_e2e_link', '{}', '{}', 'private', 'purple', now(), now(), 1, 'u_owner'
  ),
  (
    'note_e2e_public', 'u_owner', 'ws_e2e_public', 'E2E Public Workspace', 'note',
    'E2E Commenter Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_public:title","children":[{"text":"E2E Commenter Note"}]},{"type":"p","id":"note_e2e_public:body","children":[{"text":"Suggest a clearer sentence"}]}]}'::jsonb,
    'ch_e2e_public', '{}', '{}', 'private', 'blue', now(), now(), 1, 'u_owner'
  ),
  (
    'note_e2e_comment', 'u_owner', 'ws_e2e_public', 'E2E Public Workspace', 'note',
    'E2E Comment Highlight Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_comment:title","children":[{"text":"E2E Comment Highlight Note"}]},{"type":"p","id":"note_e2e_comment:body","children":[{"text":"Comment on this selected sentence"}]}]}'::jsonb,
    'ch_e2e_public', '{}', '{}', 'private', 'blue', now(), now(), 1, 'u_owner'
  ),
  (
    'note_e2e_edit', 'u_owner', 'ws_e2e_edit', 'E2E Editable Link Workspace', 'note',
    'E2E Editable Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_edit:title","children":[{"text":"E2E Editable Note"}]},{"type":"p","id":"note_e2e_edit:body","children":[{"text":"Signed-in editors can change this text"}]}]}'::jsonb,
    'ch_e2e_edit', '{}', '{}', 'private', 'coral', now(), now(), 1, 'u_owner'
  ),
  (
    'note_e2e_review', 'u_owner', 'ws_e2e_edit', 'E2E Editable Link Workspace', 'note',
    'E2E Suggestion Review Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_review:title","children":[{"text":"E2E Suggestion Review Note"}]},{"type":"p","id":"note_e2e_review:body","children":[{"text":"Original review sentence"}]}]}'::jsonb,
    'ch_e2e_edit', '{}', '{}', 'private', 'coral', now(), now(), 1, 'u_owner'
  )
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  workspace_id = EXCLUDED.workspace_id,
  workspace_name = EXCLUDED.workspace_name,
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  privacy = EXCLUDED.privacy,
  revision = 1,
  has_pending_suggestions = false;

INSERT INTO material_revisions (
  material_id, revision, parent_revision, event_type, title, content,
  has_pending_suggestions, event_metadata, created_by, created_at
)
SELECT id, revision, NULL, 'create', title, content,
       has_pending_suggestions, '{}'::jsonb, user_id, created_at
FROM materials
WHERE id IN (
  'qz_e2e_private', 'qz_e2e_link', 'qz_e2e_public', 'qz_e2e_mutate',
  'dk_e2e_private', 'dk_e2e_link', 'dk_e2e_public', 'dk_e2e_mutate',
  'note_e2e_private', 'note_e2e_link', 'note_e2e_public', 'note_e2e_comment',
  'note_e2e_edit', 'note_e2e_review'
)
ON CONFLICT (material_id, revision) DO UPDATE SET
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  parent_revision = EXCLUDED.parent_revision,
  event_type = EXCLUDED.event_type,
  has_pending_suggestions = EXCLUDED.has_pending_suggestions,
  event_metadata = EXCLUDED.event_metadata,
  created_by = EXCLUDED.created_by;

INSERT INTO card_stats (card_id, material_id, srs, known) VALUES
  ('c_e2e_priv_1', 'dk_e2e_private', '{"due":"1970-01-01T00:00:00Z","stability":0,"difficulty":0,"elapsed_days":0,"scheduled_days":0,"reps":0,"lapses":0,"state":0,"last_review":null}'::jsonb, false),
  ('c_e2e_link_1', 'dk_e2e_link',    '{"due":"1970-01-01T00:00:00Z","stability":0,"difficulty":0,"elapsed_days":0,"scheduled_days":0,"reps":0,"lapses":0,"state":0,"last_review":null}'::jsonb, false),
  ('c_e2e_pub_1',  'dk_e2e_public',  '{"due":"1970-01-01T00:00:00Z","stability":0,"difficulty":0,"elapsed_days":0,"scheduled_days":0,"reps":0,"lapses":0,"state":0,"last_review":null}'::jsonb, false),
  ('c_e2e_mut_1',  'dk_e2e_mutate',  '{"due":"1970-01-01T00:00:00Z","stability":0,"difficulty":0,"elapsed_days":0,"scheduled_days":0,"reps":0,"lapses":0,"state":0,"last_review":null}'::jsonb, false)
ON CONFLICT (card_id) DO NOTHING;

COMMIT;
