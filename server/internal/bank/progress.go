package bank

import (
	"context"

	"github.com/samyung0/capy-notebook/server/internal/review"
)

// TopicHashes maps each current (not retracted) question of a topic to
// review.QuestionHash of its content, which learners' progress rows in the app
// database are checked against. An unknown topic is ErrNotFound.
func (s *Store) TopicHashes(ctx context.Context, topic string) (map[string]string, error) {
	p, err := s.pool(ctx, false)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err = p.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM topics WHERE id=$1)`, topic).Scan(&exists); err != nil {
		return nil, dbError(err)
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := p.Query(ctx, `SELECT id,content FROM questions WHERE topic_id=$1 AND retracted_at IS NULL`, topic)
	if err != nil {
		return nil, dbError(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id string
		var q map[string]any
		if err := rows.Scan(&id, &q); err != nil {
			return nil, dbError(err)
		}
		out[id] = review.QuestionHash(q)
	}
	return out, dbError(rows.Err())
}
