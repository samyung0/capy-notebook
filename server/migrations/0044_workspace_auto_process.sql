-- One switch for automatic processing of edits (Office reparse, text and note
-- reindex), on where either old switch was on.
ALTER TABLE workspaces ADD COLUMN auto_process boolean NOT NULL DEFAULT true;
UPDATE workspaces SET auto_process = auto_reparse OR auto_reindex;
ALTER TABLE workspaces DROP COLUMN auto_reparse, DROP COLUMN auto_reindex;
