-- Exams carry a short description (12 to 15 words) under the name on the
-- /qb exam strips (Epo, 2026-10-08). Like full_label and cover, the syllabus
-- catalogs in lab/questions/syllabi own it and `go run ./cmd/bank exams`
-- writes it; the two pilot exams are filled here so the column can be required.
ALTER TABLE exams ADD COLUMN description text;
UPDATE exams SET description='Hong Kong''s university entrance exam, taken at the end of secondary school.' WHERE id='hkdse';
UPDATE exams SET description='English test for study, work and migration, scored in bands from 1 to 9.' WHERE id='ielts';
UPDATE exams SET description=full_label WHERE description IS NULL;
ALTER TABLE exams ALTER COLUMN description SET NOT NULL;
