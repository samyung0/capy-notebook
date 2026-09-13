-- A read-time projection of existing activity, not another tool history store.
-- Keep message bodies, full metadata, errors and resource effects inaccessible.
CREATE OR REPLACE VIEW ops_assistant_turns AS
SELECT m.id,
       c.user_id,
       m.status,
       NULLIF(m.metadata->>'traceId', '') AS trace_id,
       m.created_at,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'name', left(COALESCE(a.block->>'name', ''), 80),
           'detail', left(COALESCE(a.block->>'detail', ''), 240),
           'outcome', left(COALESCE(NULLIF(a.block->>'outcome', ''),
             CASE a.block->>'status'
               WHEN 'success' THEN 'succeeded'
               WHEN 'refused' THEN 'refused'
               WHEN 'error' THEN 'failed'
               WHEN 'failed' THEN 'failed'
               ELSE 'outcome_unknown'
             END), 40)
         ) ORDER BY a.ordinality)
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(m.metadata->'activity') = 'array'
                THEN m.metadata->'activity' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS a(block, ordinality)
         WHERE a.block->>'kind' = 'tool'
       ), '[]'::jsonb) AS tool_calls
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE m.role = 'assistant';
