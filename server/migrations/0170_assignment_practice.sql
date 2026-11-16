-- When staff turned a closed assignment's quiz to practice (Epo 2026-11-11).
-- Under Show answers Do not show a class's quiz stays held from its viewer
-- members past the close, as while the assignment was open, until then.
ALTER TABLE assignments ADD COLUMN practice_at timestamptz;
