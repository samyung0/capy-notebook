-- Rate-limit audit (2026-10-24). Signed-out grading also counts per shared
-- link (the verified share token's item), so one link cannot take the global
-- daily pool. Signed-in grading counts open parts per user and UTC day before
-- any Jev call. Both keep 30 days (PruneGradingUsage).
ALTER TABLE anonymous_grading_usage ADD COLUMN link_id text NOT NULL DEFAULT '';
ALTER TABLE anonymous_grading_usage DROP CONSTRAINT anonymous_grading_usage_pkey;
ALTER TABLE anonymous_grading_usage ADD PRIMARY KEY (day, ip_hash, local_id, link_id);

CREATE TABLE grading_usage (
  day     date NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parts   integer NOT NULL CHECK (parts >= 0),
  PRIMARY KEY (day, user_id)
);
