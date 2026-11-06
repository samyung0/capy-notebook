-- A drawing answer (Epo 2026-11-06): the board a member drew for one part of
-- one attempt, kept in the bucket and charged to the person attempting, in
-- practice and in assignments. Its marking image is kept only while the part
-- waits on the AI (a Not marked part, the provider busy or no credits), so a
-- later check can run; it goes once the part is marked. No picture of a drawing
-- is otherwise stored: lists and results draw it from its board.
CREATE TABLE drawings (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_id  text NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  part_id     text NOT NULL CHECK (part_id <> '' AND length(part_id) <= 128),
  board_key   text NOT NULL,
  board_bytes bigint NOT NULL CHECK (board_bytes > 0),
  image_key   text,
  image_bytes bigint NOT NULL DEFAULT 0 CHECK (image_bytes >= 0),
  image_type  text CHECK (image_type IN ('image/webp', 'image/jpeg', 'image/png')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, part_id),
  CHECK ((image_key IS NULL) = (image_bytes = 0)),
  CHECK ((image_key IS NULL) = (image_type IS NULL))
);
CREATE INDEX drawings_user_idx ON drawings(user_id, created_at DESC, id DESC);

-- The board and the image are counted blob references, so a deleted row, a
-- replaced board and a dropped image queue their objects for the reaper,
-- through every cascade (attempt, assignment, workspace, account).
CREATE TRIGGER drawings_blob_refs_after
AFTER INSERT OR UPDATE OF board_key, image_key OR DELETE ON drawings
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('board_key', 'image_key');

-- Charged as deltas, as materials and frozen assignment copies are, so a
-- cascade keeps no lock order on the counter row.
CREATE FUNCTION account_drawing_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM append_user_storage_delta(OLD.user_id, -(OLD.board_bytes + OLD.image_bytes));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM append_user_storage_delta(NEW.user_id, NEW.board_bytes + NEW.image_bytes);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION account_drawing_storage() FROM PUBLIC;

CREATE TRIGGER drawings_storage_after
AFTER INSERT OR UPDATE OF user_id, board_bytes, image_bytes OR DELETE ON drawings
FOR EACH ROW EXECUTE FUNCTION account_drawing_storage();

-- A quiz deleted for good takes its practice attempts' drawings with it (Epo
-- 2026-11-06); the attempts stay, with their marks. An assignment keeps its own
-- frozen copy, so its attempts' drawings go only with the assignment.
CREATE FUNCTION drop_quiz_practice_drawings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM drawings d
   USING attempts a
   WHERE d.attempt_id = a.id
     AND a.material_id = OLD.id
     AND a.assignment_id IS NULL;
  RETURN OLD;
END;
$$;
REVOKE EXECUTE ON FUNCTION drop_quiz_practice_drawings() FROM PUBLIC;

CREATE TRIGGER materials_drop_practice_drawings
BEFORE DELETE ON materials
FOR EACH ROW WHEN (OLD.kind = 'quiz')
EXECUTE FUNCTION drop_quiz_practice_drawings();
