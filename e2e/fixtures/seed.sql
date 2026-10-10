-- Isolated sharing fixtures for Playwright / Go access tests.
-- Applied after migrations by e2e global setup.

BEGIN;

DELETE FROM attempts WHERE user_id IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');
DELETE FROM review_log WHERE user_id IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');
DELETE FROM review_states WHERE user_id IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');
DELETE FROM study_progress WHERE user_id IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');
DELETE FROM workspace_study WHERE user_id IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');
DELETE FROM materials WHERE created_by IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');
DELETE FROM workspace_members WHERE user_id IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');
DELETE FROM workspaces WHERE user_id IN ('u_owner', 'u_editor', 'u_viewer', 'u_other');

INSERT INTO users (id, name, email, class_label, streak) VALUES
  ('u_owner',  'E2E Owner',  'owner@capynotebook.test',  'E2E', 0),
  ('u_editor', 'E2E Editor', 'editor@capynotebook.test', 'E2E', 0),
  ('u_viewer', 'E2E Viewer', 'viewer@capynotebook.test', 'E2E', 0),
  ('u_other',  'E2E Other',  'other@capynotebook.test',  'E2E', 0)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  email = EXCLUDED.email;

INSERT INTO workspaces (id, user_id, name, privacy, share_role, created_at, last_accessed_at) VALUES
  ('ws_e2e_private', 'u_owner', 'E2E Private Workspace',  'private', 'viewer', now(), now()),
  ('ws_e2e_link',    'u_owner', 'E2E Link Workspace', 'link',    'viewer', now(), now()),
  ('ws_e2e_public',  'u_owner', 'E2E Public Workspace',   'public',  'viewer', now(), now()),
  ('ws_e2e_edit',    'u_owner', 'E2E Editable Link Workspace', 'link', 'editor', now(), now()),
  ('ws_e2e_invite',  'u_owner', 'E2E Invite Only Workspace', 'private', 'viewer', now(), now()),
  ('ws_e2e_mutate',  'u_owner', 'E2E Mutate Workspace',  'private', 'viewer', now(), now())
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
  ('ws_e2e_private', 'u_viewer', 'viewer'),
  -- Invited as a viewer on a workspace whose link already grants editing, so
  -- the effective role has to resolve to the more permissive of the two.
  ('ws_e2e_edit', 'u_viewer', 'viewer')
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;

INSERT INTO chapters (id, workspace_id, name, position) VALUES
  ('ch_e2e_private', 'ws_e2e_private', 'Private chapter', 0),
  ('ch_e2e_link',    'ws_e2e_link',    'Link chapter',    0),
  ('ch_e2e_public',  'ws_e2e_public',  'Public chapter',  0),
  ('ch_e2e_edit',    'ws_e2e_edit',    'Editable link chapter', 0),
  ('ch_e2e_invite',  'ws_e2e_invite',  'Invite only chapter', 0),
  ('ch_e2e_mutate',  'ws_e2e_mutate',  'Mutate chapter',  0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO files (id, workspace_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, indexed) VALUES
  ('f_e2e_private', 'ws_e2e_private', 'u_owner', 'ch_e2e_private', 'secret-notes.md', 'md', 1024, now(), 'ready', true),
  ('f_e2e_link', 'ws_e2e_link', 'u_owner', 'ch_e2e_link', 'shared-notes.md', 'md', 1024, now(), 'ready', true),
  ('f_e2e_public', 'ws_e2e_public', 'u_owner', 'ch_e2e_public', 'public-notes.md', 'md', 1024, now(), 'ready', true),
  ('f_e2e_edit', 'ws_e2e_edit', 'u_owner', 'ch_e2e_edit', 'editable-notes.md', 'md', 1024, now(), 'ready', true)
ON CONFLICT (id) DO NOTHING;

-- Minimal Plate quiz / flashcard documents.
INSERT INTO materials (
  id, created_by, workspace_id, workspace_name, kind, title, content,
  chapter_id, scope_chapters, scope_file_names, privacy, color, created_at, updated_at, revision, updated_by
) VALUES
  (
    'qz_e2e_private', 'u_owner', 'ws_e2e_private', 'E2E Private Workspace', 'quiz',
    'E2E Private Quiz',
    '{"schemaVersion":1,"value":[{"type":"quiz","id":"qz_e2e_private:quiz","children":[{"type":"quiz_question","id":"q_priv_1","question":{"id":"q_priv_1","stem":[],"parts":[{"id":"q_priv_1:part:1","blocks":[{"type":"text","text":"Private quiz prompt?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}]}'::jsonb,
    'ch_e2e_private', '{Private chapter}', '{}', 'private', 'green', now(), now(), 1, 'u_owner'
  ),
  (
    'qz_e2e_link', 'u_owner', NULL, '', 'quiz',
    'E2E Link Quiz',
    '{"schemaVersion":1,"value":[{"type":"quiz","id":"qz_e2e_link:quiz","children":[{"type":"quiz_question","id":"q_link_1","question":{"id":"q_link_1","stem":[],"parts":[{"id":"q_link_1:part:1","blocks":[{"type":"text","text":"Link quiz prompt?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'link', 'purple', now(), now(), 1, 'u_owner'
  ),
  (
    'qz_e2e_public', 'u_owner', NULL, '', 'quiz',
    'E2E Public Quiz',
    '{"schemaVersion":1,"value":[{"type":"quiz","id":"qz_e2e_public:quiz","children":[{"type":"quiz_question","id":"q_pub_1","question":{"id":"q_pub_1","stem":[],"parts":[{"id":"q_pub_1:part:1","blocks":[{"type":"text","text":"Public quiz prompt?"}],"answer":{"type":"boolean","correct":false},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'public', 'blue', now(), now(), 1, 'u_owner'
  ),
  (
    'qz_e2e_mutate', 'u_owner', NULL, '', 'quiz',
    'E2E Mutate Quiz',
    '{"schemaVersion":1,"value":[{"type":"quiz","id":"qz_e2e_mutate:quiz","children":[{"type":"quiz_question","id":"q_mut_1","question":{"id":"q_mut_1","stem":[],"parts":[{"id":"q_mut_1:part:1","blocks":[{"type":"text","text":"Mutate quiz prompt?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'private', 'amber', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_private', 'u_owner', 'ws_e2e_private', 'E2E Private Workspace', 'flashcards',
    'E2E Private Flashcards',
    '{"schemaVersion":1,"value":[{"type":"flashcards","id":"dk_e2e_private:flashcards","children":[{"type":"flashcard","id":"c_e2e_priv_1","children":[{"type":"flashcard_front","children":[{"text":"Private front"}]},{"type":"flashcard_back","children":[{"text":"Private back"}]}]}]}]}'::jsonb,
    'ch_e2e_private', '{}', '{}', 'private', 'green', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_link', 'u_owner', NULL, '', 'flashcards',
    'E2E Link Flashcards',
    '{"schemaVersion":1,"value":[{"type":"flashcards","id":"dk_e2e_link:flashcards","children":[{"type":"flashcard","id":"c_e2e_link_1","children":[{"type":"flashcard_front","children":[{"text":"Link front"}]},{"type":"flashcard_back","children":[{"text":"Link back"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'link', 'purple', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_public', 'u_owner', NULL, '', 'flashcards',
    'E2E Public Flashcards',
    '{"schemaVersion":1,"value":[{"type":"flashcards","id":"dk_e2e_public:flashcards","children":[{"type":"flashcard","id":"c_e2e_pub_1","children":[{"type":"flashcard_front","children":[{"text":"Public front"}]},{"type":"flashcard_back","children":[{"text":"Public back"}]}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'public', 'blue', now(), now(), 1, 'u_owner'
  ),
  (
    'dk_e2e_mutate', 'u_owner', NULL, '', 'flashcards',
    'E2E Mutate Flashcards',
    '{"schemaVersion":1,"value":[{"type":"flashcards","id":"dk_e2e_mutate:flashcards","children":[{"type":"flashcard","id":"c_e2e_mut_1","children":[{"type":"flashcard_front","children":[{"text":"Mutate front"}]},{"type":"flashcard_back","children":[{"text":"Mutate back"}]}]}]}]}'::jsonb,
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
    'E2E Public Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_public:title","children":[{"text":"E2E Public Note"}]},{"type":"p","id":"note_e2e_public:body","children":[{"text":"Suggest a clearer sentence"}]}]}'::jsonb,
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
    'E2E Collaboration Review Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_review:title","children":[{"text":"E2E Collaboration Review Note"}]},{"type":"p","id":"note_e2e_review:body","children":[{"text":"Original review sentence"}]}]}'::jsonb,
    'ch_e2e_edit', '{}', '{}', 'private', 'coral', now(), now(), 1, 'u_owner'
  )
ON CONFLICT (id) DO UPDATE SET
  created_by = EXCLUDED.created_by,
  workspace_id = EXCLUDED.workspace_id,
  workspace_name = EXCLUDED.workspace_name,
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  privacy = EXCLUDED.privacy,
  revision = 1;

INSERT INTO flashcard_cards (card_id, material_id) VALUES
  ('c_e2e_priv_1', 'dk_e2e_private'),
  ('c_e2e_link_1', 'dk_e2e_link'),
  ('c_e2e_pub_1',  'dk_e2e_public'),
  ('c_e2e_mut_1',  'dk_e2e_mutate')
ON CONFLICT (card_id) DO NOTHING;

-- A library-built note crediting its own book, embedding a quiz that credits
-- another (embedded rows record their own provenance).
INSERT INTO materials (
  id, created_by, workspace_id, workspace_name, kind, title, content,
  chapter_id, scope_chapters, scope_file_names, privacy, color, created_at, updated_at, revision, updated_by,
  parent_material_id, provenance
) VALUES
  (
    'note_e2e_credits', 'u_owner', 'ws_e2e_private', 'E2E Private Workspace', 'note',
    'E2E Credited Note',
    '{"schemaVersion":1,"value":[{"type":"h1","id":"note_e2e_credits:title","children":[{"text":"E2E Credited Note"}]},{"type":"p","id":"note_e2e_credits:body","children":[{"text":"Adapted from the note source"}]},{"type":"material_ref","id":"note_e2e_credits:quiz","materialId":"qz_e2e_credits","refKind":"quiz","children":[{"text":""}]}]}'::jsonb,
    'ch_e2e_private', '{}', '{}', 'private', 'blue', now(), now(), 1, 'u_owner',
    NULL,
    '{"books":[{"id":"e2e_note_book","title":"Note Source Book","authors":["Note Author"],"license":"CC BY 4.0","excerptIds":["e2e_n1"],"version":1}]}'::jsonb
  ),
  (
    'qz_e2e_credits', 'u_owner', 'ws_e2e_private', 'E2E Private Workspace', 'quiz',
    '6f1d2c3b-0e2e-4c4e-9d1a-c4ed175e2e01',
    '{"schemaVersion":1,"value":[{"type":"quiz","id":"qz_e2e_credits:quiz","children":[{"type":"quiz_question","id":"q_cred_1","question":{"id":"q_cred_1","stem":[],"parts":[{"id":"q_cred_1:part:1","blocks":[{"type":"text","text":"Credited quiz prompt?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}]}'::jsonb,
    NULL, '{}', '{}', 'private', 'blue', now(), now(), 1, 'u_owner',
    'note_e2e_credits',
    '{"books":[{"id":"e2e_quiz_book","title":"Quiz Source Book","authors":["Quiz Author"],"license":"CC BY-SA 4.0","excerptIds":["e2e_q1"],"version":1}],"license":"CC BY-SA 4.0"}'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  content = EXCLUDED.content,
  provenance = EXCLUDED.provenance,
  trashed_at = NULL,
  trashed_by = NULL,
  trash_episode_id = NULL,
  purge_after = NULL,
  revision = 1;

COMMIT;
