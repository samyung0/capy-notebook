-- Pictures on a drawing answer's board (Epo 2026-11-09, todo-board-images.md):
-- an image the member pasted on the board, sent with the board at Done or
-- Check and stored beside it. Each is the file its image block names by
-- source_id. They are charged to the person attempting with the drawing
-- (picture_bytes, in the drawing's own storage delta) and go wherever the
-- drawing goes: replaced by its next Done, deleted with it.
ALTER TABLE drawings
  ADD COLUMN picture_bytes bigint NOT NULL DEFAULT 0 CHECK (picture_bytes >= 0);

CREATE TABLE drawing_pictures (
  drawing_id text NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  source_id  text NOT NULL CHECK (source_id <> '' AND length(source_id) <= 128),
  object_key text NOT NULL,
  bytes      bigint NOT NULL CHECK (bytes > 0),
  type       text NOT NULL CHECK (type IN ('image/webp', 'image/jpeg', 'image/png', 'image/gif')),
  PRIMARY KEY (drawing_id, source_id)
);

-- Counted blob references, as the board and the marking image are: a replaced
-- or deleted picture queues its object for the reaper, through every cascade.
CREATE TRIGGER drawing_pictures_blob_refs_after
AFTER INSERT OR UPDATE OF object_key OR DELETE ON drawing_pictures
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('object_key');

CREATE OR REPLACE FUNCTION account_drawing_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM append_user_storage_delta(OLD.user_id, -(OLD.board_bytes + OLD.image_bytes + OLD.picture_bytes));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM append_user_storage_delta(NEW.user_id, NEW.board_bytes + NEW.image_bytes + NEW.picture_bytes);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER drawings_storage_after ON drawings;
CREATE TRIGGER drawings_storage_after
AFTER INSERT OR UPDATE OF user_id, board_bytes, image_bytes, picture_bytes OR DELETE ON drawings
FOR EACH ROW EXECUTE FUNCTION account_drawing_storage();
