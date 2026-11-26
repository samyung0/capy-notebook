-- Submissions are charged to no one (Epo 2026-11-25): a paper's or hand-in's
-- file stays as handed in for good, so its member could never free its bytes.
-- An assignment's drawing is kept the same way and is free too (Epo
-- 2026-11-25, "Yes, make them free"); a practice drawing stays charged.
-- account_file_storage charges only files outside a submission, the counters
-- give back what submissions were charged, and their pending uploads reserve
-- nothing (account_upload_reservation releases the difference). A session
-- remembers it was a submission, so one whose attempt or assignment was
-- deleted never lands as an ordinary file, and an upload-only assignment has
-- one attempt.
CREATE OR REPLACE FUNCTION account_file_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_bytes bigint := 0;
  new_bytes bigint := 0;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.submission_position IS NULL THEN
    old_bytes := OLD.size_bytes;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.submission_position IS NULL THEN
    new_bytes := NEW.size_bytes;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF new_bytes <> 0 THEN
      PERFORM adjust_user_storage_used(NEW.user_id, new_bytes);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF old_bytes <> 0 THEN
      PERFORM adjust_user_storage_used(OLD.user_id, -old_bytes);
    END IF;
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    PERFORM adjust_user_storage_used(OLD.user_id, -old_bytes);
    PERFORM adjust_user_storage_used(NEW.user_id, new_bytes);
  ELSIF old_bytes <> new_bytes THEN
    PERFORM adjust_user_storage_used(NEW.user_id, new_bytes - old_bytes);
  END IF;
  RETURN NULL;
END;
$$;

UPDATE user_storage st
SET used_bytes = GREATEST(0, st.used_bytes - x.bytes), updated_at = now()
FROM (
  SELECT user_id, sum(size_bytes) AS bytes FROM files
  WHERE submission_position IS NOT NULL GROUP BY user_id
) x
WHERE st.user_id = x.user_id;

UPDATE upload_sessions SET reserved_size = 0
WHERE status = 'pending' AND (attempt_id IS NOT NULL OR hand_in_assignment_id IS NOT NULL)
  AND reserved_size IS DISTINCT FROM 0;

ALTER TABLE upload_sessions ADD COLUMN submission boolean NOT NULL DEFAULT false;
UPDATE upload_sessions SET submission = true
WHERE attempt_id IS NOT NULL OR hand_in_assignment_id IS NOT NULL;

UPDATE assignments SET attempts_allowed = 1
WHERE upload_only AND attempts_allowed <> 1;

-- A drawing knows whether it answers an assignment (its attempt's kind, fixed
-- for the attempt's life), so its charge follows it through every cascade.
ALTER TABLE drawings ADD COLUMN assignment boolean NOT NULL DEFAULT false;
UPDATE drawings d SET assignment = true
FROM attempts t WHERE t.id = d.attempt_id AND t.assignment_id IS NOT NULL;

SELECT append_user_storage_delta(user_id, -sum(board_bytes + image_bytes + picture_bytes)::bigint)
FROM drawings WHERE assignment GROUP BY user_id;

CREATE OR REPLACE FUNCTION account_drawing_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND NOT OLD.assignment THEN
    PERFORM append_user_storage_delta(OLD.user_id, -(OLD.board_bytes + OLD.image_bytes + OLD.picture_bytes));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NOT NEW.assignment THEN
    PERFORM append_user_storage_delta(NEW.user_id, NEW.board_bytes + NEW.image_bytes + NEW.picture_bytes);
  END IF;
  RETURN NULL;
END;
$$;
