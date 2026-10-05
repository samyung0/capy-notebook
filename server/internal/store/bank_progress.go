package store

import (
	"context"
	"time"
)

// Question-bank progress: each user's latest result per bank question, nothing
// more. Questions live in the bank database, so callers compare a row's hash
// with what the bank says now; a row whose hash no longer matches, or whose
// question is retracted, is not answered.

// BankResult is a user's latest checked answer to one bank question.
type BankResult struct {
	QuestionID string
	TopicID    string
	Hash       string
	Score      float64
	AnsweredAt time.Time
}

// RecordBankAnswer keeps a checked answer's score (awarded / marks, 0 to 1)
// as the user's latest result for the question.
func (s *Store) RecordBankAnswer(ctx context.Context, userID, questionID, topicID, hash string, score float64, now time.Time) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO bank_progress (user_id, question_id, topic_id, item_hash, last_score, answered_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (user_id, question_id) DO UPDATE SET topic_id=EXCLUDED.topic_id, item_hash=EXCLUDED.item_hash,
			last_score=EXCLUDED.last_score, answered_at=EXCLUDED.answered_at`,
		userID, questionID, topicID, hash, score, now)
	return err
}

// BankMarks is the topic list's marks: the latest score of each current
// question the user has answered, by id.
func (s *Store) BankMarks(ctx context.Context, userID, topicID string, hashes map[string]string) (map[string]float64, error) {
	results, err := s.bankResults(ctx, `WHERE user_id=$1 AND topic_id=$2`, userID, topicID)
	if err != nil {
		return nil, err
	}
	out := map[string]float64{}
	for _, r := range results {
		if hashes[r.QuestionID] == r.Hash {
			out[r.QuestionID] = r.Score
		}
	}
	return out, nil
}

// BankResults is every result the user has recorded, current or not.
func (s *Store) BankResults(ctx context.Context, userID string) ([]BankResult, error) {
	return s.bankResults(ctx, `WHERE user_id=$1`, userID)
}

func (s *Store) bankResults(ctx context.Context, where string, args ...any) ([]BankResult, error) {
	rows, err := s.pool.Query(ctx, `SELECT question_id, topic_id, item_hash, last_score, answered_at FROM bank_progress `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BankResult{}
	for rows.Next() {
		var r BankResult
		if err := rows.Scan(&r.QuestionID, &r.TopicID, &r.Hash, &r.Score, &r.AnsweredAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
