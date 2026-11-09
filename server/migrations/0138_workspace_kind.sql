-- A workspace is for a class or for personal use (Epo 2026-11-04, board U3):
-- it decides what each person sees in Study and how an editor is named. Set at
-- creation, changed by the owner, and nothing is deleted when it changes.
ALTER TABLE workspaces ADD COLUMN kind text NOT NULL DEFAULT 'personal'
  CHECK (kind IN ('class','personal'));
