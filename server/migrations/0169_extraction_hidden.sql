-- Make a quiz from a file asks whether the quiz starts hidden from members
-- (Epo 2026-11-11): the run keeps the answer until its quiz is saved. Runs from
-- before the switch hid theirs.
ALTER TABLE question_extractions ADD COLUMN hidden boolean NOT NULL DEFAULT true;
ALTER TABLE question_extractions ALTER COLUMN hidden DROP DEFAULT;
