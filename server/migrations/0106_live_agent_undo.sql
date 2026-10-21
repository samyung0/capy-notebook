-- The chat's Undo is live (Epo 2026-10-20): the collaboration room that took an
-- agent edit reverts its Yjs items while it stays loaded, and nothing is stored
-- for it but receipts. Each Undo or Redo receipt names the step it reversed,
-- at most once; a reloaded conversation follows that chain to show where it
-- stands. The stored inverses go: deleting them first releases their charged
-- bytes through the storage trigger.
DELETE FROM agent_edit_inverses;
DROP TABLE agent_edit_inverses;
DROP FUNCTION account_edit_inverse_storage();

ALTER TABLE agent_operations ADD COLUMN undo_of text;
CREATE UNIQUE INDEX agent_operations_undo_of_idx ON agent_operations(undo_of) WHERE undo_of IS NOT NULL;
