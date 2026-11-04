package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// Where a question was checked, answer_events.source.
const (
	answerSourceQuiz   = "quiz"   // a check in a quiz attempt
	answerSourceReview = "review" // a review session's or Quick review's check
	// answerSourceAssignment is a marked assignment's answer: its closed parts
	// at submit, its open parts when the owner marks them.
	answerSourceAssignment = "assignment"
)

// logAnswerTx appends one answer event per graded part of a checked question
// (openwiki/study-progress.md#answer-events), in the check's transaction. A
// question left wholly blank logs nothing, as it is not rated. key_seen is
// whether an earlier check returned the key to this user: a rating of the
// question, or an attempt other than attemptID holding it. So it runs before
// the check is rated; attemptID is the check's own attempt, empty for a
// review.
func logAnswerTx(ctx context.Context, tx pgx.Tx, userID string, mt Material, graded, given map[string]any, source, attemptID string, now time.Time) error {
	return logAnswerPartsTx(ctx, tx, userID, mt, graded, given, source, attemptID, now, nil)
}

// logAnswerPartsTx is logAnswerTx for the parts named in only, or all when nil;
// a part still waiting for the owner logs when it is marked. mt.ID is empty once
// an assignment's quiz is deleted.
func logAnswerPartsTx(ctx context.Context, tx pgx.Tx, userID string, mt Material, graded, given map[string]any, source, attemptID string, now time.Time, only map[string]bool) error {
	if questions.Blank(graded, given) {
		return nil
	}
	var ids, types, graders []string
	var awarded, marks []float64
	parts, _ := graded["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		m, _ := p["marks"].(float64)
		if m <= 0 {
			continue
		}
		id, _ := p["id"].(string)
		if pending, _ := p["pending"].(bool); pending || (only != nil && !only[id]) {
			continue
		}
		a, _ := p["awarded"].(float64)
		answer, _ := p["answer"].(map[string]any)
		kind, _ := answer["type"].(string)
		// Only answered open parts reach the model (planGrading); a blank one
		// scores 0 without it. An assignment's marks are the owner's.
		grader := "deterministic"
		if _, byOwner := p["markedBy"]; byOwner {
			grader = "owner"
		} else if text, _ := given[id].(string); kind == "open" && strings.TrimSpace(text) != "" {
			grader = "ai"
		}
		ids, types, graders = append(ids, id), append(types, kind), append(graders, grader)
		awarded, marks = append(awarded, a), append(marks, m)
	}
	if len(ids) == 0 {
		return nil
	}
	questionID, _ := graded["id"].(string)
	_, err := tx.Exec(ctx, `INSERT INTO answer_events (user_id, workspace_id, material_id, question_id, item_hash,
			source, attempt_id, key_seen, created_at, part_id, answer_type, awarded, marks, grader)
		SELECT $1::text, NULLIF($2::text, ''), NULLIF($3::text, ''), $4::text, $5::text, $6::text, NULLIF($7::text, ''),
			EXISTS (SELECT 1 FROM review_log WHERE user_id=$1 AND material_id=$3 AND item_id=$4)
				OR EXISTS (SELECT 1 FROM attempts WHERE user_id=$1 AND material_id=$3 AND kind='quiz' AND id <> $7
					AND questions @> jsonb_build_array(jsonb_build_object('id', $4::text))),
			$8::timestamptz, p.id, p.type, p.awarded, p.marks, p.grader
		FROM unnest($9::text[], $10::text[], $11::float8[], $12::float8[], $13::text[]) AS p(id, type, awarded, marks, grader)`,
		userID, mt.WorkspaceID, mt.ID, questionID, review.QuestionHash(graded), source, attemptID, now,
		ids, types, awarded, marks, graders)
	return err
}
