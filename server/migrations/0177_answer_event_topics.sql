-- The topics an answer counted toward when it was given (Epo 2026-11-15,
-- todo-question-topics.md): the question's own that are its workspace's
-- topics, else its quiz's. Reads take a question's current topics while its
-- quiz exists and these only once the quiz is deleted (material_id null), so a
-- deleted quiz's answers still count to its topics. Reads keep only ids that
-- are topics of the answer's workspace, so a deleted topic drops out without
-- touching these rows (topic ids are never reused).
ALTER TABLE answer_events ADD COLUMN topic_ids text[] NOT NULL DEFAULT '{}';

-- Existing answers take their quiz's topic when it is one of the answer's
-- workspace's (a quiz moved since has another workspace's).
UPDATE answer_events ae SET topic_ids = ARRAY[t.id]
FROM materials m JOIN topics t ON t.id = COALESCE(m.topic_id, m.practice_topic_id)
WHERE m.id = ae.material_id AND t.workspace_id = ae.workspace_id;
