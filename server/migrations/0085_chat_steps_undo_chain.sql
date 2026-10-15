-- The chat's Steps setting: how much of a turn's tool work the chat shows.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_steps text NOT NULL DEFAULT 'normal'
  CHECK (chat_steps IN ('normal','verbose'));

-- What the Undo of a chat step does. 'edit' applies the stored inverse
-- commands under their guards (an AI edit, or the Undo of one, whose Undo is
-- Redo); 'trash' moves a file the chat created into the trash, and 'restore'
-- brings it back from the trash episode in `inverse`. Every Undo stores the
-- step that reverses it, so Undo and Redo alternate along one chain
-- (undone_by links each step to the next). Compaction and source rebases
-- release only 'edit' steps; trash and purge release every step.
ALTER TABLE agent_edit_inverses ADD COLUMN IF NOT EXISTS step text NOT NULL DEFAULT 'edit'
  CHECK (step IN ('edit','trash','restore'));
