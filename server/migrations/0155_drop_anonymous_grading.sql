-- Shared pages no longer send open answers to a model (Epo 2026-11-05, Q640 B),
-- so the signed-out grading caps and the table that counted them go.
DROP TABLE anonymous_grading_usage;
