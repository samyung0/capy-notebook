package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// MarkedByAI is markedBy on a part the AI's mark decided: an assignment with
// approval off takes it at once.
const MarkedByAI = "ai"

// AnswerToMark is one submitted open answer waiting, with no AI mark yet.
type AnswerToMark struct {
	AttemptID  string
	QuestionID string
	PartID     string
	Question   string
	Items      []string
	ItemMarks  []float64
	Answer     string
}

// AnswersToMark lists what the AI has yet to mark in an assignment, or in one of
// its attempts (attemptID), and who pays: AI marking of an assignment's answers is
// its workspace owner's (Epo 2026-11-03).
func (s *Store) AnswersToMark(ctx context.Context, assignmentID, attemptID string) (payerID, workspaceID string, answers []AnswerToMark, err error) {
	if err = s.pool.QueryRow(ctx, `SELECT w.owner_user_id, a.workspace_id FROM assignments a
		JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=$1`, assignmentID).Scan(&payerID, &workspaceID); err != nil {
		if isNoRows(err) {
			err = ErrNotFound
		}
		return "", "", nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT t.id, t.answers, t.questions FROM attempts t
		WHERE t.assignment_id=$1 AND ($2='' OR t.id=$2) AND t.submitted_at IS NOT NULL AND t.waiting_answers > 0
		ORDER BY t.submitted_at`, assignmentID, attemptID)
	if err != nil {
		return "", "", nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var rawAnswers, rawGraded []byte
		if err := rows.Scan(&id, &rawAnswers, &rawGraded); err != nil {
			return "", "", nil, err
		}
		found, err := attemptAnswersToMark(id, rawAnswers, rawGraded)
		if err != nil {
			return "", "", nil, err
		}
		answers = append(answers, found...)
	}
	return payerID, workspaceID, answers, rows.Err()
}

func attemptAnswersToMark(attemptID string, rawAnswers, rawGraded []byte) ([]AnswerToMark, error) {
	given := map[string]any{}
	if err := json.Unmarshal(rawAnswers, &given); err != nil {
		return nil, err
	}
	graded, err := decodeFrozen(rawGraded)
	if err != nil {
		return nil, err
	}
	var out []AnswerToMark
	for _, q := range graded {
		questionID, _ := q["id"].(string)
		parts, _ := q["parts"].([]any)
		for i, raw := range parts {
			p, _ := raw.(map[string]any)
			partID, _ := p["id"].(string)
			text, _ := given[partID].(string)
			pending, _ := p["pending"].(bool)
			if _, marked := p["aiAwards"]; !pending || marked || strings.TrimSpace(text) == "" {
				continue
			}
			items, marks := questions.MarkItems(p)
			out = append(out, AnswerToMark{
				AttemptID: attemptID, QuestionID: questionID, PartID: partID,
				Question: questions.GradingText(q, i), Items: items, ItemMarks: marks, Answer: text,
			})
		}
	}
	return out, nil
}

// AIMark is the AI's mark on one open part, in marks per marking point.
type AIMark struct {
	QuestionID string
	PartID     string
	Items      []float64
	Comment    string
}

// SaveAIMarks stores marks the AI gave an attempt. With approval on they wait
// beside the answer for the owner, and a member sees none of it; with it off
// they are the marks at once. A part someone marked meanwhile keeps that mark.
func (s *Store) SaveAIMarks(ctx context.Context, attemptID string, marks []AIMark, now time.Time) error {
	if len(marks) == 0 {
		return nil
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1 FOR UPDATE OF t`, attemptID))
		if err != nil {
			return err
		}
		var approval bool
		if err := tx.QueryRow(ctx, `SELECT approve_ai_marks FROM assignments WHERE id=$1`, r.assignmentID).Scan(&approval); err != nil {
			return err
		}
		graded, err := decodeFrozen(r.graded)
		if err != nil {
			return err
		}
		given := map[string]any{}
		if err := json.Unmarshal(r.answers, &given); err != nil {
			return err
		}
		byQuestion := map[string][]AIMark{}
		for _, mark := range marks {
			byQuestion[mark.QuestionID] = append(byQuestion[mark.QuestionID], mark)
		}
		for _, question := range graded {
			id, _ := question["id"].(string)
			if len(byQuestion[id]) == 0 {
				continue
			}
			if err := s.takeAIMarksTx(ctx, tx, r, graded, question, given, byQuestion[id], approval, now); err != nil {
				return err
			}
		}
		// Waiting marks change no total; stored here, they outlive the transaction.
		raw, err := json.Marshal(graded)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE attempts SET questions=$2 WHERE id=$1`, attemptID, raw)
		return err
	})
}

func (s *Store) takeAIMarksTx(ctx context.Context, tx pgx.Tx, r attemptRow, graded []map[string]any, question, given map[string]any, marks []AIMark, approval bool, now time.Time) error {
	parts, _ := question["parts"].([]any)
	waited := questionWaiting(question)
	var apply []AssignmentPartMark
	var comments []string
	for _, mark := range marks {
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			pending, _ := p["pending"].(bool)
			if p["id"] != mark.PartID || !pending {
				continue
			}
			p["aiAwards"] = mark.Items
			if mark.Comment != "" {
				p["aiComment"] = mark.Comment
				comments = append(comments, mark.Comment)
			}
			apply = append(apply, AssignmentPartMark{PartID: mark.PartID, Items: mark.Items})
		}
	}
	if approval || len(apply) == 0 {
		return nil
	}
	changed, err := applyPartMarks(question, apply, MarkedByAI, now)
	if err != nil {
		return fmt.Errorf("apply AI marks: %w", err)
	}
	if _, commented := question["comment"]; !commented && len(comments) > 0 {
		question["comment"] = strings.Join(comments, " ")
	}
	return s.storeQuestionMarksTx(ctx, tx, r, graded, question, given, changed, waited, now)
}

// ApproveAIMarks approves every waiting answer to a question that the AI marked,
// as the owner approving each one would. Answers it has not marked keep waiting.
// It returns how many it approved.
func (s *Store) ApproveAIMarks(ctx context.Context, actorID, assignmentID, questionID string, now time.Time) (int, error) {
	var workspaceID string
	if err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM assignments WHERE id=$1`, assignmentID).Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	approved := 0
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE t.assignment_id=$1 AND t.submitted_at IS NOT NULL AND t.waiting_answers > 0 FOR UPDATE OF t`, assignmentID)
		if err != nil {
			return err
		}
		var attempts []attemptRow
		for rows.Next() {
			r, err := scanAttemptRow(rows)
			if err != nil {
				rows.Close()
				return err
			}
			attempts = append(attempts, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range attempts {
			done, err := s.approveAttemptQuestionTx(ctx, tx, r, questionID, actorID, now)
			if err != nil {
				return err
			}
			if done {
				approved++
			}
		}
		return nil
	})
	return approved, err
}

func (s *Store) approveAttemptQuestionTx(ctx context.Context, tx pgx.Tx, r attemptRow, questionID, actorID string, now time.Time) (bool, error) {
	graded, err := decodeFrozen(r.graded)
	if err != nil {
		return false, err
	}
	given := map[string]any{}
	if err := json.Unmarshal(r.answers, &given); err != nil {
		return false, err
	}
	for _, question := range graded {
		if question["id"] != questionID {
			continue
		}
		waited := questionWaiting(question)
		parts, _ := question["parts"].([]any)
		var apply []AssignmentPartMark
		var comments []string
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			pending, _ := p["pending"].(bool)
			if !pending {
				continue
			}
			items, marked := aiAwards(p)
			if !marked {
				return false, nil
			}
			id, _ := p["id"].(string)
			apply = append(apply, AssignmentPartMark{PartID: id, Items: items})
			if comment, _ := p["aiComment"].(string); comment != "" {
				comments = append(comments, comment)
			}
		}
		if len(apply) == 0 {
			return false, nil
		}
		changed, err := applyPartMarks(question, apply, actorID, now)
		if err != nil {
			return false, err
		}
		if _, commented := question["comment"]; !commented && len(comments) > 0 {
			question["comment"], question["commentBy"] = strings.Join(comments, " "), actorID
		}
		return true, s.storeQuestionMarksTx(ctx, tx, r, graded, question, given, changed, waited, now)
	}
	return false, nil
}

func aiAwards(p map[string]any) ([]float64, bool) {
	raw, ok := p["aiAwards"].([]any)
	if !ok {
		return nil, false
	}
	items := make([]float64, len(raw))
	for i, value := range raw {
		number, ok := value.(float64)
		if !ok {
			return nil, false
		}
		items[i] = number
	}
	return items, true
}

// withoutAIMarks takes the AI's waiting marks out of what a member reads.
func withoutAIMarks(graded []map[string]any) {
	for _, q := range graded {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			delete(p, "aiAwards")
			delete(p, "aiComment")
		}
	}
}
