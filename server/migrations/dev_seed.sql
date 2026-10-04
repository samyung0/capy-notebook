-- Local / development demo rows. Not a numbered migration.
-- Applied only when APP_ENV=development (API) or `cmd/migrate -seed`.
-- Idempotent via ON CONFLICT so local restarts can re-run it.
--
-- Quiz/flashcard materials are pre-converted Plate documents (formerly
-- derived from the unified quiz/flashcards material model).

-- u_1 is the default dev user on the free plan. u_2 is on the pro plan
-- (30 MB source files, larger storage and credit limits) for testing large
-- uploads and paid-tier gates; select it with DEV_USER_ID=u_2.
INSERT INTO users (id, name, email, class_label, streak, plan_tier, subscription_status) VALUES
  ('u_1', 'Kate Malone', 'kate@capynotebook.app', 'Grade 11 · Science', 0, 'free', 'none'),
  ('u_2', 'Theo Park',   'theo@capynotebook.app', 'Grade 12 · Science', 0, 'pro',  'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, user_id, name, privacy, created_at, last_accessed_at) VALUES
  ('ws_bio',  'u_1', 'Biology 101',  'private', now()-interval '40 day', now()-interval '3 hour'),
  ('ws_calc', 'u_1', 'Calculus II', 'private', now()-interval '30 day', now()-interval '1 day'),
  ('ws_hist', 'u_1', 'World History',  'link',    now()-interval '22 day', now()-interval '2 day'),
  ('ws_chem', 'u_1', 'Organic Chemistry',   'private', now()-interval '12 day', now()-interval '5 day'),
  ('ws_eng',  'u_1', 'English Literature',  'public',  now()-interval '8 day',  now()-interval '20 hour')
ON CONFLICT (id) DO NOTHING;

-- Owners of the demo workspaces only. Do not touch later real workspaces.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, user_id, 'owner'
FROM workspaces
WHERE id IN ('ws_bio', 'ws_calc', 'ws_hist', 'ws_chem', 'ws_eng')
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role='owner';

INSERT INTO chapters (id, workspace_id, name, position) VALUES
  ('ch_1',  'ws_bio',  'Cell structure',           0),
  ('ch_2',  'ws_bio',  'Membranes & transport',    1),
  ('ch_3',  'ws_bio',  'Genetics',                 2),
  ('ch_c1', 'ws_calc', 'Techniques of integration',0),
  ('ch_c2', 'ws_calc', 'Sequences & series',       1)
ON CONFLICT (id) DO NOTHING;

-- No seeded files: a file row needs a real object in the blob store, which the
-- seed cannot create. Upload fixtures through the app instead.

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
   $json${"value":[{"id":"qz_1:quiz","type":"quiz","children":[{"type":"quiz_question","id":"q1","question":{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Which organelle is the powerhouse of the cell?"}],"answer":{"type":"mcq","options":["Nucleus","Mitochondria","Ribosome","Golgi apparatus"],"correct":[1]},"marks":1,"solution":[{"type":"text","text":"Mitochondria produce ATP through cellular respiration."}]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]},{"type":"quiz_question","id":"q2","question":{"id":"q2","stem":[],"parts":[{"id":"q2:part:1","blocks":[{"type":"text","text":"The cell membrane is a phospholipid bilayer."}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[{"type":"text","text":"The membrane is two layers of phospholipids with hydrophilic heads out and hydrophobic tails in."}]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]},{"type":"quiz_question","id":"q3","question":{"id":"q3","stem":[],"parts":[{"id":"q3:part:1","blocks":[{"type":"text","text":"Select all that are membrane-bound organelles."}],"answer":{"type":"multi","options":["Ribosome","Nucleus","Mitochondria","Cytosol"],"correct":[1,2]},"marks":1,"solution":[{"type":"text","text":"Ribosomes are ribonucleoprotein particles, not membrane-bound.\n\nCorrect — enclosed by a double-membrane nuclear envelope.\n\nCorrect — bounded by an outer and inner membrane.\n\nThe cytosol is the fluid itself, not a membrane-bound compartment."}]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]},{"type":"quiz_question","id":"q4","question":{"id":"q4","stem":[],"parts":[{"id":"q4:part:1","blocks":[{"type":"text","text":"The diffusion of water across a membrane is called ____."}],"answer":{"type":"short","accepted":["osmosis"]},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]},{"type":"quiz_question","id":"q5","question":{"id":"q5","stem":[],"parts":[{"id":"q5:part:1","blocks":[{"type":"text","text":"Order the path of protein secretion."}],"answer":{"type":"ordering","items":["Ribosome","Rough ER","Golgi apparatus","Vesicle","Cell membrane"]},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]},{"type":"quiz_question","id":"q6","question":{"id":"q6","stem":[],"parts":[{"id":"q6:part:1","blocks":[{"type":"text","text":"Match the organelle to its function."}],"answer":{"type":"matching","options":["Stores DNA","Makes ATP","Builds proteins"],"pairs":[{"left":"Nucleus","right":0},{"left":"Mitochondria","right":1},{"left":"Ribosome","right":2}]},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}],"schemaVersion":1}$json$::jsonb,
   '{"Cell structure","Membranes & transport"}', '{}', 'private', 'green', now()-interval '4 day'),
  ('qz_2', 'u_1', 'ws_bio', 'Biology 101', 'quiz', 'Genetics check-in',
   $json${"value":[{"id":"qz_2:quiz","type":"quiz","children":[{"type":"quiz_question","id":"q7","question":{"id":"q7","stem":[],"parts":[{"id":"q7:part:1","blocks":[{"type":"text","text":"A cross between Aa × Aa gives what genotype ratio?"}],"answer":{"type":"mcq","options":["1:2:1","3:1","1:1","9:3:3:1"],"correct":[0]},"marks":1,"solution":[{"type":"text","text":"Correct — the genotype ratio is 1 AA : 2 Aa : 1 aa.\n\nThat is the phenotype ratio, not the genotype ratio.\n\nA 1:1 ratio comes from a test cross (Aa × aa).\n\nThat is a dihybrid (two-gene) ratio, not a monohybrid one."}]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]},{"type":"quiz_question","id":"q8","question":{"id":"q8","stem":[],"parts":[{"id":"q8:part:1","blocks":[{"type":"text","text":"Define a dominant allele in one sentence."}],"answer":{"type":"short","accepted":["an allele expressed in the phenotype even when only one copy is present"]},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}],"schemaVersion":1}$json$::jsonb,
   '{"Genetics"}', '{}', 'private', 'green', now()-interval '2 day'),
  ('qz_3', 'u_1', 'ws_calc', 'Calculus II', 'quiz', 'Integration techniques',
   $json${"value":[{"id":"qz_3:quiz","type":"quiz","children":[{"type":"quiz_question","id":"q9","question":{"id":"q9","stem":[],"parts":[{"id":"q9:part:1","blocks":[{"type":"text","text":"∫ x·eˣ dx is best solved by…"}],"answer":{"type":"mcq","options":["Substitution","Integration by parts","Partial fractions","Trig substitution"],"correct":[1]},"marks":1,"solution":[{"type":"text","text":"No single inner function's derivative appears, so u-substitution stalls.\n\nCorrect — a polynomial times an exponential is the classic parts case.\n\nPartial fractions apply to rational functions, not this product.\n\nTrig substitution targets radical forms like √(a²−x²)."}]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]},{"type":"quiz_question","id":"q10","question":{"id":"q10","stem":[],"parts":[{"id":"q10:part:1","blocks":[{"type":"text","text":"∫ 1/x dx = ln|x| + C"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[{"type":"text","text":"The antiderivative of 1/x is ln|x|; the absolute value covers negative x."}]}],"layout":"paper","labels":"letters"},"children":[{"text":""}]}]}],"schemaVersion":1}$json$::jsonb,
   '{"Techniques of integration"}', '{}', 'private', 'green', now()-interval '6 day'),
  ('dk_1', 'u_1', 'ws_bio', 'Biology 101', 'flashcards', 'Cell organelles',
   $json${"value": [{"id": "dk_1:flashcards", "type": "flashcards", "children": [{"id": "c_1", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Mitochondria"}]}, {"type": "flashcard_back", "children": [{"text": "Powerhouse of the cell — produces ATP."}]}]}, {"id": "c_2", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Nucleus"}]}, {"type": "flashcard_back", "children": [{"text": "Stores DNA and controls cell activity."}]}]}, {"id": "c_3", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Ribosome"}]}, {"type": "flashcard_back", "children": [{"text": "Site of protein synthesis."}]}]}, {"id": "c_4", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "Golgi apparatus"}]}, {"type": "flashcard_back", "children": [{"text": "Packages and ships proteins."}]}]}]}], "schemaVersion": 1}$json$::jsonb,
   '{}', '{}', 'private', 'green', now()),
  ('dk_2', 'u_1', 'ws_calc', 'Calculus II', 'flashcards', 'Integration rules',
   $json${"value": [{"id": "dk_2:flashcards", "type": "flashcards", "children": [{"id": "c_5", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "∫ eˣ dx"}]}, {"type": "flashcard_back", "children": [{"text": "eˣ + C"}]}]}, {"id": "c_6", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": "∫ 1/x dx"}]}, {"type": "flashcard_back", "children": [{"text": "ln|x| + C"}]}]}]}], "schemaVersion": 1}$json$::jsonb,
   '{}', '{}', 'private', 'purple', now()),
  ('dk_3', 'u_1', 'ws_hist', 'World History', 'flashcards', 'History dates',
   $json${"value": [{"id": "dk_3:flashcards", "type": "flashcards", "children": [{"id": "dk_3:card:1", "type": "flashcard", "children": [{"type": "flashcard_front", "children": [{"text": ""}]}, {"type": "flashcard_back", "children": [{"text": ""}]}]}]}], "schemaVersion": 1}$json$::jsonb,
   '{}', '{}', 'private', 'amber', now())
ON CONFLICT (id) DO NOTHING;

-- The card -> set lookup for each seeded card.
INSERT INTO flashcard_cards (card_id, material_id) VALUES
  ('c_1', 'dk_1'), ('c_2', 'dk_1'), ('c_3', 'dk_1'), ('c_4', 'dk_1'),
  ('c_5', 'dk_2'), ('c_6', 'dk_2'), ('dk_3:card:1', 'dk_3')
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
  ('tk_4', 'u_1', 'Outline history essay with a long title to test how the UI handles it',          'World History this is a very long task title just to test how UI can handle',            false, date_trunc('day', now())+interval '1 day 23 hour'),
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
