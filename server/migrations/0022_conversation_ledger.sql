-- Progress ledger of a curate conversation: the turn's requests, its todos and
-- the materials created, kept outside the message list so compaction never
-- touches it. Null until a curate turn writes one. The retrieval service owns
-- the JSON shape; Go stores it and hands it back on the next turn.
ALTER TABLE conversations ADD COLUMN ledger jsonb;
