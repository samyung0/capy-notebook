-- Exams carry a full name and a cover for the bank's exam switcher
-- (human/question-bank.md, 2026-10-08). The syllabus catalogs in
-- lab/questions/syllabi own both; `go run ./cmd/bank exams` writes them.
-- The two pilot exams are filled here so the columns can be required.
ALTER TABLE exams ADD COLUMN full_label text, ADD COLUMN cover jsonb;
UPDATE exams SET full_label='Hong Kong Diploma of Secondary Education',
  cover='{"style":"symbols","color":"#7866cf","kind":"math"}' WHERE id='hkdse';
UPDATE exams SET full_label='International English Language Testing System',
  cover='{"style":"paper","color":"#2a78d6","kind":"latin","line":"Paraphrase, then summarise."}' WHERE id='ielts';
ALTER TABLE exams ALTER COLUMN full_label SET NOT NULL, ALTER COLUMN cover SET NOT NULL;
