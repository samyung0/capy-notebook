package store

import (
	"context"
	"encoding/json"
	"errors"
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
	AttemptID string
	// PayerID is who made the attempt, who pays for its marking (Epo 2026-11-08).
	PayerID    string
	QuestionID string
	PartID     string
	Question   string
	// Figures are the question's images, in the order Question numbers them.
	Figures   []map[string]any
	Items     []string
	ItemMarks []float64
	Answer    string
	// A canvas part: DrawingPart is the part its drawing is stored under, its
	// marking image the attempt's stored one for it (PartID itself, or, answered
	// in the canvas above, questions.DrawingParts' first part there), else "";
	// SampleImage is its drawn sample answer's image asset, or "".
	DrawingPart string
	SampleImage string
	// Pages: a paper's open or drawn part, graded on these pages of its paper.
	Pages []int
}

// AnswersToMark lists what the AI has yet to mark in an assignment, or in one of
// its attempts (attemptID). Each answer's PayerID is who attempted it: all AI
// marking of an assignment is theirs (Epo 2026-11-08, superseding the owner's).
func (s *Store) AnswersToMark(ctx context.Context, assignmentID, attemptID string) (workspaceID string, answers []AnswerToMark, err error) {
	var marking string
	if err = s.pool.QueryRow(ctx, `SELECT workspace_id, marking FROM assignments WHERE id=$1`, assignmentID).Scan(&workspaceID, &marking); err != nil {
		if isNoRows(err) {
			err = ErrNotFound
		}
		return "", nil, err
	}
	// Marked by hand: nothing goes to the AI (Epo 2026-11-06).
	if marking == MarkingManual {
		return workspaceID, nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT t.id, t.user_id, t.answers, t.questions FROM attempts t
		WHERE t.assignment_id=$1 AND ($2='' OR t.id=$2) AND t.submitted_at IS NOT NULL AND t.waiting_answers > 0
		ORDER BY t.submitted_at`, assignmentID, attemptID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	var listed []AnswerToMark
	var drawnIn []string
	for rows.Next() {
		var id, payer string
		var rawAnswers, rawGraded []byte
		if err := rows.Scan(&id, &payer, &rawAnswers, &rawGraded); err != nil {
			return "", nil, err
		}
		found, err := attemptAnswersToMark(id, rawAnswers, rawGraded)
		for i := range found {
			found[i].PayerID = payer
		}
		if err != nil {
			return "", nil, err
		}
		for _, answer := range found {
			if answer.DrawingPart != "" {
				drawnIn = append(drawnIn, id)
				break
			}
		}
		listed = append(listed, found...)
	}
	if err := rows.Err(); err != nil {
		return "", nil, err
	}
	rows.Close()
	// A drawing with no marking image (saved under manual grading) is staff's to
	// mark by hand (Q695): the report says so, and the AI is not asked.
	kept, err := keptDrawingImageParts(ctx, s.pool, drawnIn)
	if err != nil {
		return "", nil, err
	}
	for _, answer := range listed {
		if answer.DrawingPart == "" || kept[answer.AttemptID+"/"+answer.DrawingPart] {
			answers = append(answers, answer)
		}
	}
	return workspaceID, answers, nil
}

// keptDrawingImageParts are the attempts' drawings that keep a marking image,
// as attempt/part.
func keptDrawingImageParts(ctx context.Context, q rowsQueryer, attemptIDs []string) (map[string]bool, error) {
	kept := map[string]bool{}
	if len(attemptIDs) == 0 {
		return kept, nil
	}
	rows, err := q.Query(ctx, `SELECT attempt_id, part_id FROM drawings
		WHERE attempt_id = ANY($1) AND image_key IS NOT NULL`, attemptIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var attemptID, partID string
		if err := rows.Scan(&attemptID, &partID); err != nil {
			return nil, err
		}
		kept[attemptID+"/"+partID] = true
	}
	return kept, rows.Err()
}

// needsHandMarking: a waiting drawing the AI has not marked and has no marking
// image for (saved under manual grading), which only staff can mark (Q695).
func needsHandMarking(q, answers map[string]any, attemptID string, kept map[string]bool) bool {
	owners := questions.DrawingParts(q)
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		id, _ := p["id"].(string)
		owner, drawn := owners[id]
		if drawn && waitsOnAI(p) && isDrawingAnswer(answers[owner]) && !kept[attemptID+"/"+owner] {
			return true
		}
	}
	return false
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
		// Read by drawing: the parts answering in one canvas are each marked
		// on the one drawing stored under the first of them.
		owners := questions.DrawingParts(q)
		parts, _ := q["parts"].([]any)
		for i, raw := range parts {
			p, _ := raw.(map[string]any)
			partID, _ := p["id"].(string)
			text, _ := given[partID].(string)
			drawing := ""
			if owner, ok := owners[partID]; ok && isDrawingAnswer(given[owner]) {
				drawing = owner
			}
			pages := paperPages(given[partID])
			if !waitsOnAI(p) || (strings.TrimSpace(text) == "" && drawing == "" && len(pages) == 0) {
				continue
			}
			items, marks := questions.MarkItems(p)
			question, figures := questions.GradingTextAndFigures(q, i)
			out = append(out, AnswerToMark{
				AttemptID: attemptID, QuestionID: questionID, PartID: partID,
				Question: question, Figures: figures, Items: items, ItemMarks: marks, Answer: text,
				DrawingPart: drawing, SampleImage: questions.DrawnSampleImage(p), Pages: pages,
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
	Flag       string
}

// Why the AI left an open part unmarked, shown on the owner's row (mock T3):
// no credits, a grading failure, or a file of its paper that can't be read
// (Q730).
const (
	AIErrorCredits = "credits"
	AIErrorGrade   = "error"
	AIErrorFile    = "file"
)

// AIFailure is an open part the AI could not mark, and why.
type AIFailure struct {
	QuestionID string
	PartID     string
	Reason     string
}

// SaveAIFailures notes on each part still waiting with no AI mark why it has none.
// A mark that lands later takes the note off.
func (s *Store) SaveAIFailures(ctx context.Context, attemptID string, failures []AIFailure) error {
	if len(failures) == 0 {
		return nil
	}
	reasons := make(map[string]string, len(failures))
	for _, f := range failures {
		reasons[f.QuestionID+"/"+f.PartID] = f.Reason
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT questions FROM attempts WHERE id=$1 FOR UPDATE`, attemptID).Scan(&raw); err != nil {
			return err
		}
		graded, err := decodeFrozen(raw)
		if err != nil {
			return err
		}
		for _, q := range graded {
			qid, _ := q["id"].(string)
			parts, _ := q["parts"].([]any)
			for _, rawPart := range parts {
				p, _ := rawPart.(map[string]any)
				pid, _ := p["id"].(string)
				pending, _ := p["pending"].(bool)
				_, marked := p["aiAwards"]
				if reason, ok := reasons[qid+"/"+pid]; ok && pending && !marked {
					p["aiError"] = reason
				}
			}
		}
		out, err := json.Marshal(graded)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE attempts SET questions=$2 WHERE id=$1`, attemptID, out)
		return err
	})
}

// questionAIError is why the AI left a waiting part of q unmarked, or "".
func questionAIError(q map[string]any) string {
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		pending, _ := p["pending"].(bool)
		_, marked := p["aiAwards"]
		if reason, _ := p["aiError"].(string); pending && !marked && reason != "" {
			return reason
		}
	}
	return ""
}

// SaveAIMarks stores marks the AI gave an attempt. With approval on they wait
// beside the answer for the owner, and a member sees none of it; with it off
// they are the marks at once. A part someone marked meanwhile keeps that mark.
func (s *Store) SaveAIMarks(ctx context.Context, attemptID string, marks []AIMark, now time.Time) ([]Notification, error) {
	if len(marks) == 0 {
		return nil, nil
	}
	var sent []Notification
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1 FOR UPDATE OF t`, attemptID))
		if err != nil {
			return err
		}
		var marking string
		if err := tx.QueryRow(ctx, `SELECT marking FROM assignments WHERE id=$1`, r.assignmentID).Scan(&marking); err != nil {
			return err
		}
		approval := marking == MarkingAIApprove
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
			note, err := s.takeAIMarksTx(ctx, tx, r, graded, question, given, byQuestion[id], approval, now)
			if err != nil {
				return err
			}
			if note != nil {
				sent = append(sent, *note)
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
	return sent, err
}

func (s *Store) takeAIMarksTx(ctx context.Context, tx pgx.Tx, r attemptRow, graded []map[string]any, question, given map[string]any, marks []AIMark, approval bool, now time.Time) (*Notification, error) {
	parts, _ := question["parts"].([]any)
	waited := questionWaiting(question)
	var apply []AssignmentPartMark
	for _, mark := range marks {
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			pending, _ := p["pending"].(bool)
			if p["id"] != mark.PartID || !pending {
				continue
			}
			p["aiAwards"] = mark.Items
			delete(p, "aiError")
			if mark.Comment != "" {
				p["aiComment"] = mark.Comment
				if mark.Flag != "" {
					p["aiFlag"] = mark.Flag
				}
			}
			apply = append(apply, AssignmentPartMark{PartID: mark.PartID, Items: mark.Items})
		}
	}
	if approval || len(apply) == 0 {
		return nil, nil
	}
	changed, err := applyPartMarks(question, apply, MarkedByAI, now)
	if err != nil {
		return nil, fmt.Errorf("apply AI marks: %w", err)
	}
	return s.storeQuestionMarksTx(ctx, tx, r, graded, question, given, changed, waited, now)
}

// ApproveAIMarks approves every waiting answer to a question that the AI marked,
// as the owner approving each one would. Answers it has not marked keep waiting.
// It returns how many it approved.
func (s *Store) ApproveAIMarks(ctx context.Context, actorID, assignmentID, questionID string, now time.Time) (int, []Notification, error) {
	wsID, err := assignmentWorkspace(ctx, s.pool, assignmentID)
	if err != nil {
		return 0, nil, err
	}
	approved := 0
	var sent []Notification
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
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
			done, note, err := s.approveAttemptQuestionTx(ctx, tx, r, questionID, actorID, now)
			if err != nil {
				return err
			}
			if done {
				approved++
			}
			if note != nil {
				sent = append(sent, *note)
			}
		}
		return nil
	})
	return approved, sent, err
}

func (s *Store) approveAttemptQuestionTx(ctx context.Context, tx pgx.Tx, r attemptRow, questionID, actorID string, now time.Time) (bool, *Notification, error) {
	graded, err := decodeFrozen(r.graded)
	if err != nil {
		return false, nil, err
	}
	given := map[string]any{}
	if err := json.Unmarshal(r.answers, &given); err != nil {
		return false, nil, err
	}
	for _, question := range graded {
		if question["id"] != questionID {
			continue
		}
		waited := questionWaiting(question)
		parts, _ := question["parts"].([]any)
		var apply []AssignmentPartMark
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			pending, _ := p["pending"].(bool)
			if !pending {
				continue
			}
			items, marked := aiAwards(p)
			if !marked {
				return false, nil, nil
			}
			id, _ := p["id"].(string)
			apply = append(apply, AssignmentPartMark{PartID: id, Items: items})
		}
		if len(apply) == 0 {
			return false, nil, nil
		}
		changed, err := applyPartMarks(question, apply, actorID, now)
		if err != nil {
			return false, nil, err
		}
		note, err := s.storeQuestionMarksTx(ctx, tx, r, graded, question, given, changed, waited, now)
		return true, note, err
	}
	return false, nil, nil
}

// ErrNothingToRegrade refuses a regrade of a question with no written, drawn or
// paper answer the AI can mark again.
var ErrNothingToRegrade = errors.New("this answer has nothing for the AI to grade again")

// ErrRegradeManual refuses a regrade on an assignment marked by hand.
var ErrRegradeManual = errors.New("this assignment is graded by hand")

// RegradeQuestion grades one question of a submitted attempt again (Epo
// 2026-11-23), whatever its marks were: the assignment's latest copy of the
// question (the attempt's own when republishing removed it) on the member's
// answers, closed parts by rule and each answered written, drawn or paper part
// waiting for the AI, as a submit leaves them. A drawing whose marking image
// is gone keeps its mark, since the AI has nothing to read. The staff comment
// stays. It returns the parts the AI marks next, and refuses a question with
// none.
func (s *Store) RegradeQuestion(ctx context.Context, actorID, attemptID, questionID string, now time.Time) ([]string, error) {
	first, err := s.readAttempt(ctx, attemptID)
	if err != nil {
		return nil, err
	}
	var regrade []string
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, first.wsID, actorID); err != nil {
			return err
		}
		r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1 FOR UPDATE OF t`, attemptID))
		if err != nil {
			return err
		}
		if r.submitted == nil {
			return assignmentInput("this attempt has not been submitted")
		}
		if r.marking == MarkingManual {
			return ErrRegradeManual
		}
		graded, err := decodeFrozen(r.graded)
		if err != nil {
			return err
		}
		frozen, err := decodeFrozen(r.frozen)
		if err != nil {
			return err
		}
		given := map[string]any{}
		if err := json.Unmarshal(r.answers, &given); err != nil {
			return err
		}
		at := -1
		for i, q := range graded {
			if q["id"] == questionID {
				at = i
			}
		}
		if at < 0 {
			return ErrNotFound
		}
		old := graded[at]
		source := withoutMarks(old)
		for _, q := range frozen {
			if q["id"] == questionID {
				source = q
			}
		}
		rows, err := tx.Query(ctx, `SELECT part_id FROM drawings WHERE attempt_id=$1 AND image_key IS NOT NULL`, attemptID)
		if err != nil {
			return err
		}
		drawn, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		imaged := map[string]bool{}
		for _, id := range drawn {
			imaged[id] = true
		}
		oldParts := map[string]map[string]any{}
		list, _ := old["parts"].([]any)
		for _, raw := range list {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			oldParts[id] = p
		}
		question, _, _ := questions.Graded(source, given, nil)
		owners := questions.DrawingParts(source)
		parts, _ := question["parts"].([]any)
		for i, raw := range parts {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			a, _ := p["answer"].(map[string]any)
			if !questions.ModelMarked(a["type"]) {
				continue
			}
			// A part answered in the canvas above is read by its drawing.
			drawing, drawn := owners[id]
			if !drawn {
				drawing = id
			}
			value := given[drawing]
			text, typed := value.(string)
			pages := paperPages(given[id])
			switch {
			case len(pages) > 0:
				p["pages"] = pages
			case isDrawingAnswer(value) && !imaged[drawing]:
				// Nothing to read: its mark as it was, or hand marking.
				if kept, ok := oldParts[id]; ok {
					parts[i] = kept
				} else {
					p["pending"] = true
					delete(p, "itemAwards")
				}
				continue
			case isDrawingAnswer(value), typed && strings.TrimSpace(text) != "":
			default:
				continue
			}
			p["pending"] = true
			delete(p, "itemAwards")
			regrade = append(regrade, id)
		}
		if len(regrade) == 0 {
			return ErrNothingToRegrade
		}
		for _, key := range []string{"comment", "commentBy"} {
			if value, ok := old[key]; ok {
				question[key] = value
			}
		}
		// A mark the member had: its next decided mark rings them if it moved
		// (storeQuestionMarksTx).
		if !questionWaiting(old) {
			question["regraded"], _ = questionMarks(old)
		}
		graded[at] = question
		// The answer log gains only marks that moved; a waiting part logs once marked.
		changed := map[string]bool{}
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			if before := oldParts[id]; before == nil || before["awarded"] != p["awarded"] {
				changed[id] = true
			}
		}
		_, err = s.storeQuestionMarksTx(ctx, tx, r, graded, question, given, changed, questionWaiting(old), now)
		return err
	})
	return regrade, err
}

// withoutMarks is a graded question as its frozen copy held it: no marks,
// AI marks, pages or staff comment.
func withoutMarks(q map[string]any) map[string]any {
	out := make(map[string]any, len(q))
	for key, value := range q {
		out[key] = value
	}
	for _, key := range []string{"comment", "commentBy", "regraded"} {
		delete(out, key)
	}
	list, _ := q["parts"].([]any)
	parts := make([]any, len(list))
	for i, raw := range list {
		p, _ := raw.(map[string]any)
		part := make(map[string]any, len(p))
		for key, value := range p {
			part[key] = value
		}
		for _, key := range []string{"awarded", "itemAwards", "itemResults", "pending", "aiAwards", "aiComment", "aiFlag", "aiError", "markedBy", "markedAt", "pages"} {
			delete(part, key)
		}
		parts[i] = part
	}
	out["parts"] = parts
	return out
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

// withoutAIMarks takes out of what a member reads the AI's marks, and its warning
// while its mark waits for the owner. With Show answers off gradedWithoutKeys
// also holds the warning back until the assignment has closed.
func withoutAIMarks(graded []map[string]any) {
	for _, q := range graded {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			delete(p, "aiAwards")
			delete(p, "aiError")
			if pending, _ := p["pending"].(bool); pending {
				delete(p, "aiComment")
				delete(p, "aiFlag")
			}
		}
	}
}

// clearAIWarning takes the AI's warning off a question's parts (Epo 2026-11-05).
func clearAIWarning(q map[string]any) {
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		delete(p, "aiComment")
		delete(p, "aiFlag")
	}
}

// questionAIWarning is the report row's warning: "error" where code told what
// happened (copying, instructions to the marker), "warning" for any other.
func questionAIWarning(q map[string]any) string {
	warning := ""
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		if _, flagged := p["aiFlag"]; flagged {
			return "error"
		}
		if _, commented := p["aiComment"]; commented {
			warning = "warning"
		}
	}
	return warning
}
