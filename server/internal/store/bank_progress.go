package store

import (
	"context"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// Question-bank progress: one FSRS state per user and bank question, rated
// like workspace review. Questions live in the bank database, so callers pass
// what the bank says now: the question's topic and hash, or a topic's current
// question hashes. A row whose hash no longer matches is a new question.

const bankReviewSize = 20

// RecordBankAnswer rates a checked answer to a bank question from its score
// (awarded / marks, 0 to 1).
func (s *Store) RecordBankAnswer(ctx context.Context, userID, questionID, topicID, hash string, score float64, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "bank-rating:"+userID+":"+questionID); err != nil {
			return err
		}
		var prev storedState
		err := tx.QueryRow(ctx, `SELECT item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review
			FROM bank_review_states WHERE user_id=$1 AND question_id=$2`, userID, questionID).
			Scan(&prev.hash, &prev.Stability, &prev.Difficulty, &prev.Reps, &prev.Lapses, &prev.FSRSState, &prev.LastReview)
		if err != nil && !isNoRows(err) {
			return err
		}
		var last *review.State
		if err == nil && prev.hash == hash {
			last = &prev.State
		}
		next := review.Rate(last, review.ScoreRating(score), now)
		_, err = tx.Exec(ctx, `INSERT INTO bank_review_states
			(user_id, question_id, topic_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review, last_score)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT (user_id, question_id) DO UPDATE SET topic_id=EXCLUDED.topic_id, item_hash=EXCLUDED.item_hash,
				stability=EXCLUDED.stability, difficulty=EXCLUDED.difficulty, reps=EXCLUDED.reps, lapses=EXCLUDED.lapses,
				fsrs_state=EXCLUDED.fsrs_state, last_review=EXCLUDED.last_review, last_score=EXCLUDED.last_score`,
			userID, questionID, topicID, hash, next.Stability, next.Difficulty, next.Reps, next.Lapses, next.FSRSState, next.LastReview, score)
		return err
	})
}

// BankMarks is the topic list's marks: for each current question the user
// has answered, whether the last answer earned full marks.
func (s *Store) BankMarks(ctx context.Context, userID, topicID string, hashes map[string]string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT question_id, item_hash, last_score FROM bank_review_states
		WHERE user_id=$1 AND topic_id=$2`, userID, topicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id, hash string
		var score float64
		if err := rows.Scan(&id, &hash, &score); err != nil {
			return nil, err
		}
		if hashes[id] == hash {
			out[id] = score >= 1
		}
	}
	return out, rows.Err()
}

// BankReview is a topic's next mistake review batch: current questions missed
// at least once, the one most likely forgotten first, at most 20.
func (s *Store) BankReview(ctx context.Context, userID, topicID string, hashes map[string]string, now time.Time) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT question_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review
		FROM bank_review_states WHERE user_id=$1 AND topic_id=$2 AND lapses > 0`, userID, topicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type rankedQuestion struct {
		id string
		r  float64
	}
	var all []rankedQuestion
	for rows.Next() {
		var id string
		var st storedState
		if err := rows.Scan(&id, &st.hash, &st.Stability, &st.Difficulty, &st.Reps, &st.Lapses, &st.FSRSState, &st.LastReview); err != nil {
			return nil, err
		}
		if hashes[id] == st.hash {
			all = append(all, rankedQuestion{id, review.Retrievability(st.State, now)})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].r != all[j].r {
			return all[i].r < all[j].r
		}
		return all[i].id < all[j].id
	})
	out := []string{}
	for i, q := range all {
		if i == bankReviewSize {
			break
		}
		out = append(out, q.id)
	}
	return out, nil
}
