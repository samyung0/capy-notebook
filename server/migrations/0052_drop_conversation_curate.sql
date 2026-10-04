-- Library is a per-turn switch, not a thread mode (todo-learning.md, 2.1): any
-- conversation can read the shared library and keep a ledger.
ALTER TABLE conversations DROP COLUMN curate;
