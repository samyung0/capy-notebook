-- A published assignment's frozen question JSON is charged to whoever published
-- it, as its images are (Epo 2026-11-05), and released when it goes, by hand or
-- with its workspace. The deltas take no counter lock, and the publishing gate
-- reads them, so a cascade has no lock order to keep.
ALTER TABLE assignments
  ADD COLUMN frozen_by    text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN frozen_bytes bigint NOT NULL DEFAULT 0 CHECK (frozen_bytes >= 0);
CREATE INDEX assignments_frozen_by_idx ON assignments(frozen_by) WHERE frozen_by IS NOT NULL;

CREATE FUNCTION account_assignment_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.frozen_by IS NOT NULL THEN
    PERFORM append_user_storage_delta(OLD.frozen_by, -OLD.frozen_bytes);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.frozen_by IS NOT NULL THEN
    PERFORM append_user_storage_delta(NEW.frozen_by, NEW.frozen_bytes);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION account_assignment_storage() FROM PUBLIC;

-- A row starts with no copy: only an update or its deletion moves the charge.
CREATE TRIGGER assignments_storage_after
AFTER UPDATE OF frozen_by, frozen_bytes OR DELETE ON assignments
FOR EACH ROW EXECUTE FUNCTION account_assignment_storage();
