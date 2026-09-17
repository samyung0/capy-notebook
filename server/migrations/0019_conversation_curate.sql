-- Curate mode is fixed per chat at creation: a curate turn carries no
-- citations and drops its library evidence after the turn, so a mixed history
-- would not replay. The stream rejects a request whose flag disagrees.
ALTER TABLE conversations ADD COLUMN curate boolean NOT NULL DEFAULT false;
