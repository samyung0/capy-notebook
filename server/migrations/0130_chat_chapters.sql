-- Chat's create_chapter records a receipt (Epo 2026-10-29).
ALTER TABLE agent_operations DROP CONSTRAINT agent_operations_kind_check,
  ADD CONSTRAINT agent_operations_kind_check CHECK (kind IN (
    'create_material','edit_document','undo_edit','trash','restore','purge','create_workspace',
    'create_chapter'));
