-- Local / development demo rows. Not a numbered migration.
-- Applied only when APP_ENV=development (API) or `cmd/migrate -seed`.
-- Idempotent via ON CONFLICT so local restarts can re-run it.
--
-- Quiz/flashcard materials are pre-converted Plate documents (formerly
-- derived from legacy quizzes/decks/cards tables at migration time).

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
