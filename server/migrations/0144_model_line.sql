-- One line per model (Epo 2026-11-04): a model's whole capacity is shared by
-- every use, with no interactive reserve, and every caller waits its turn in
-- the model's one line, served round-robin by requester (the user, or the
-- ingest job). The line lives here so the app and ingest hosts share it.
ALTER TABLE model_capacities DROP COLUMN interactive_reserve;

-- Whom a lease counts for in the round-robin: 'user:<id>' or 'job:<session>'.
ALTER TABLE provider_capacity_leases ADD COLUMN requester text NOT NULL DEFAULT '';

-- A call waiting at a gate. Its process renews the row while it waits, so a
-- dead process's calls drop out once they expire; a granted call's row
-- becomes its lease (same id) in one statement.
CREATE TABLE provider_capacity_waiters (
  id            text PRIMARY KEY,
  provider      text NOT NULL,
  requester     text NOT NULL,
  lease_seconds int NOT NULL CHECK (lease_seconds > 0),
  enqueued_at   timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL
);
CREATE INDEX provider_capacity_waiters_provider_expiry_idx
  ON provider_capacity_waiters(provider, expires_at);
