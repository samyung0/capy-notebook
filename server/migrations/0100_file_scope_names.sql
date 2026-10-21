-- A file the chat agent makes (a deck's PPTX) keeps its made-from line as
-- names, like materials.scope_file_names (human/agentic-retrieval.md,
-- 2026-10-21).
ALTER TABLE files
  ADD COLUMN scope_file_names text[] NOT NULL DEFAULT '{}';
