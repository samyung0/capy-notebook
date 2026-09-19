-- Quiz and flashcards blocks inside a note are material rows of their own,
-- referenced from the note by a material_ref node. The parent note owns their
-- lifecycle: they share its workspace, stay private and unfiled, follow it
-- through trash, restore, purge and clone, and are trashed when their
-- reference leaves the note.
ALTER TABLE materials ADD COLUMN parent_material_id text
  REFERENCES materials(id) ON DELETE CASCADE;
ALTER TABLE materials ADD CONSTRAINT materials_embedded_check CHECK (
  parent_material_id IS NULL
  OR (kind IN ('quiz','flashcards') AND chapter_id IS NULL AND privacy = 'private')
);
CREATE INDEX materials_parent_idx ON materials(parent_material_id)
  WHERE parent_material_id IS NOT NULL;
