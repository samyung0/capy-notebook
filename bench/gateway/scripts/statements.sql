-- The statements that took Postgres the most time since the last reset, with
-- how much of it was planning. Run against a db started with
-- docker-compose.statements.yml after `SELECT pg_stat_statements_reset();`.
SELECT calls,
       round((total_exec_time + total_plan_time)::numeric, 0) AS total_ms,
       round((total_plan_time / nullif(total_exec_time + total_plan_time, 0) * 100)::numeric, 0) AS plan_pct,
       round(((total_exec_time + total_plan_time) / nullif(calls, 0))::numeric, 2) AS mean_ms,
       left(regexp_replace(query, '\s+', ' ', 'g'), 140) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'capy')
ORDER BY total_exec_time + total_plan_time DESC
LIMIT 20;
