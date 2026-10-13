-- The chat agent's build ledger is gone (Epo 2026-10-13): a turn takes the
-- build budget once its first write lands, so nothing carries between turns.
ALTER TABLE conversations DROP COLUMN ledger;
