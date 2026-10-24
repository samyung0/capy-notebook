-- Learning progress reads a user's progress rows by workspace on every page
-- and after every rating (LearningProgress). The table's user indexes are
-- partial, by file or by material, so that read scanned every user's rows;
-- it was most of Postgres's time in the 2026-10-24 gateway load test
-- (bench/gateway/reports/2026-10-24-gateway-capacity.md).
CREATE INDEX study_progress_user_idx ON study_progress (user_id, workspace_id);
