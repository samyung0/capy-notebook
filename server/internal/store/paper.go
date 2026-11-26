package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// Papers: an assignment attempt answered on paper (Epo 2026-11-08,
// todo-file-submissions.md 5a). Its files are the member's own standalone
// uploads through the normal upload, linked to the attempt by files.attempt_id.
// Submitted, its files are read only for good (Epo 2026-11-25): staff may mark
// at any time, so nothing of them changes, and they are charged to no one.

// ErrPaperClosed: the attempt no longer takes files (submitted, timed out, or
// not answered on paper).
var ErrPaperClosed = errors.New("this attempt no longer takes files")

// ErrPaperFull: one more file would pass a paper's or hand-in's bounds
// (fieldlimits.SubmissionFiles, SubmissionFileBytes and SubmissionBytes).
var ErrPaperFull = errors.New("you can submit at most 10 files, 10 MB each and 30 MB in all")

// submissionRoom admits one more file of size bytes beside files files of
// bytes bytes in a paper or hand-in.
func submissionRoom(files int, bytes, size int64) error {
	if files+1 > fieldlimits.SubmissionFiles || size > fieldlimits.SubmissionFileBytes ||
		bytes+size > fieldlimits.SubmissionBytes {
		return ErrPaperFull
	}
	return nil
}

// checkPaperUploadTx admits size more bytes into userID's running paper
// attempt: their own, answered on paper, before its time runs out, within the
// submission bounds across its files and pending uploads. It locks the
// attempt row so two uploads cannot both pass.
func (s *Store) checkPaperUploadTx(ctx context.Context, tx pgx.Tx, attemptID, userID string, size int64, now time.Time) error {
	r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
		FROM attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`, attemptID, userID))
	if err != nil {
		return err
	}
	if r.paper != PaperUpload || r.submitted != nil || r.expired(now) {
		return ErrPaperClosed
	}
	var files int
	var bytes int64
	if err := tx.QueryRow(ctx, `SELECT count(*), COALESCE(sum(b), 0) FROM (
			SELECT size_bytes AS b FROM files WHERE attempt_id=$1
			UNION ALL
			SELECT declared_size FROM upload_sessions WHERE attempt_id=$1 AND status='pending' AND expires_at > now()
		) held`, attemptID).Scan(&files, &bytes); err != nil {
		return err
	}
	return submissionRoom(files, bytes, size)
}

// AssertPaperUpload is an upload ticket's check of checkPaperUploadTx, with the
// account's lifecycle and no storage quota: a submission is charged to no one.
func (s *Store) AssertPaperUpload(ctx context.Context, attemptID, userID string, size int64, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.admitAccountTx(ctx, tx, userID); err != nil {
			return err
		}
		return s.checkPaperUploadTx(ctx, tx, attemptID, userID, size, now)
	})
}

// RemovePaperFile deletes a file from the member's running paper, before it is
// submitted. Its blob goes as any deleted file's does (the files triggers).
func (s *Store) RemovePaperFile(ctx context.Context, userID, attemptID, fileID string, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		if err := s.checkPaperUploadTx(ctx, tx, attemptID, userID, 0, now); err != nil && !errors.Is(err, ErrPaperFull) {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM files WHERE id=$1 AND attempt_id=$2 AND user_id=$3`, fileID, attemptID, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// PaperPart is one part of a paper as the read call lists it.
type PaperPart struct {
	// Label is how the paper numbers it: the question's number in the
	// attempt's order, and the part's letter when the question has several.
	Label      string
	QuestionID string
	PartID     string
	// Type is the read call's name for it: choice, true/false, short, gaps,
	// matching, ordering, open or drawing.
	Type string
	// Listing is the part as the read call lists it, its options lettered as
	// the member saw them; Question is its grading text, Items its marking
	// points, for the open and canvas parts the AI grades.
	Listing   string
	Question  string
	Items     []string
	ItemMarks []float64
	// Figures are the question's images, in the order Question numbers them,
	// a canvas part's own canvas among them; SampleImage is a canvas part's
	// drawn sample answer image, an editor asset (Epo 2026-11-23).
	Figures     []map[string]any
	SampleImage string
}

// Paper is a submitted paper with the parts its marking lists.
type Paper struct {
	// Read: its pages are read; else the read call is still to run.
	Read bool
	// Manual: staff mark its open parts, so the read grades none (Q716).
	Manual      bool
	AttemptID   string
	WorkspaceID string
	PayerID     string
	Files       []PaperFile
	Parts       []PaperPart
	// TextGap is why a file of it with no page images has no text to read
	// (AIErrorCredits or AIErrorFile), or "".
	TextGap string
}

// paperTypes names each answer type as the read call's prompt does (a canvas
// part is still "drawing" there).
var paperTypes = map[string]string{
	"mcq": "choice", "boolean": "true/false", "short": "short", "gaps": "gaps",
	"matching": "matching", "ordering": "ordering", "open": "open", "canvas": "drawing",
}

func letter(i int) string { return string(rune('A' + i)) }

// lettered lists values as "A. …" lines.
func lettered(values []any) string {
	lines := make([]string, len(values))
	for i, v := range values {
		text, _ := v.(string)
		lines[i] = letter(i) + ". " + text
	}
	return strings.Join(lines, "\n")
}

// paperQuestions is the copy a submitted paper holds (t.questions, not the
// assignment's, which a republish may have changed since) without what its
// submission and any earlier read wrote on its parts.
func paperQuestions(r attemptRow) ([]map[string]any, error) {
	held, err := decodeFrozen(r.graded)
	if err != nil {
		return nil, err
	}
	for _, q := range held {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			for _, key := range []string{"pending", "awarded", "itemAwards", "itemResults", "markedBy", "markedAt",
				"aiAwards", "aiComment", "aiFlag", "aiError", "pages"} {
				delete(p, key)
			}
		}
	}
	return held, nil
}

// paperTextGap is why one of an attempt's files that the read takes as text
// (not a PDF or an image) has none: No credits when its ingest was skipped for
// them (queueIngestTx), else Can't read file (its ingest failed or hit a
// limit, or no ingest reads its kind; Q730).
func paperTextGap(ctx context.Context, q rowsQueryer, attemptID string) (string, error) {
	rows, err := q.Query(ctx, `SELECT name, kind, COALESCE(parse_mode, ''), status = 'ready' AND index_limit IS NULL
		FROM files WHERE attempt_id=$1 AND kind NOT IN ('pdf', 'image') AND NOT indexed`, attemptID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	gap := ""
	for rows.Next() {
		var name, kind, mode string
		var skipped bool
		if err := rows.Scan(&name, &kind, &mode, &skipped); err != nil {
			return "", err
		}
		plan, err := sourceupload.BuildProcessingPlan(name, kind, mode)
		if !skipped || err != nil || plan.Route == sourceupload.RouteStoreOnly {
			return AIErrorFile, rows.Err()
		}
		gap = AIErrorCredits
	}
	return gap, rows.Err()
}

// GetPaper is a submitted attempt's paper, or ErrNotFound. Its parts follow the attempt's own question order with the options as the
// member's seeded view shows them (questions.LearnerViewsSeeded).
func (s *Store) GetPaper(ctx context.Context, attemptID string) (Paper, error) {
	r, err := s.readAttempt(ctx, attemptID)
	if err != nil {
		return Paper{}, err
	}
	if r.paper != PaperReading && r.paper != PaperRead {
		return Paper{}, ErrNotFound
	}
	files, err := paperFiles(ctx, s.pool, attemptID)
	if err != nil {
		return Paper{}, err
	}
	gap, err := paperTextGap(ctx, s.pool, attemptID)
	if err != nil {
		return Paper{}, err
	}
	frozen, err := paperQuestions(r)
	if err != nil {
		return Paper{}, err
	}
	if r.shuffle {
		frozen = shuffledQuestions(r.id, frozen)
	}
	views := questions.LearnerViewsSeeded(frozen, r.id)
	out := Paper{Read: r.paper == PaperRead, Manual: r.marking == MarkingManual, AttemptID: r.id, WorkspaceID: r.wsID,
		PayerID: r.userID, Files: files, TextGap: gap}
	for n, q := range frozen {
		qid, _ := q["id"].(string)
		parts, _ := q["parts"].([]any)
		viewParts, _ := views[n]["parts"].([]any)
		for i, raw := range parts {
			p, _ := raw.(map[string]any)
			pid, _ := p["id"].(string)
			a, _ := p["answer"].(map[string]any)
			kind, _ := a["type"].(string)
			view, _ := viewParts[i].(map[string]any)
			shown, _ := view["answer"].(map[string]any)
			label := strconv.Itoa(n + 1)
			if len(parts) > 1 {
				label += string(rune('a' + i))
			}
			listing := label + " (" + paperTypes[kind] + "): " + questions.PartText(q, i)
			switch kind {
			case "mcq":
				options, _ := questions.ShownChoices(shown)
				listing += "\n" + lettered(options)
			case "ordering":
				items, _ := shown["items"].([]any)
				listing += "\n" + lettered(items)
			case "matching":
				left, _ := shown["left"].([]any)
				options, _ := shown["options"].([]any)
				items := make([]string, len(left))
				for j, v := range left {
					text, _ := v.(string)
					items[j] = strconv.Itoa(j+1) + ". " + text
				}
				listing += "\nItems:\n" + strings.Join(items, "\n") + "\nOptions:\n" + lettered(options)
			}
			part := PaperPart{Label: label, QuestionID: qid, PartID: pid, Type: paperTypes[kind], Listing: listing}
			if questions.ModelMarked(kind) {
				part.Question, part.Figures = questions.PaperTextAndFigures(q, i)
				part.SampleImage = questions.DrawnSampleImage(p)
				part.Items, part.ItemMarks = questions.MarkItems(p)
			}
			out.Parts = append(out.Parts, part)
		}
	}
	return out, nil
}

// PaperFinding is what the read call found for one part: the pages its answer
// is on and, for a closed part, the answer as the prompt's shape gives it.
type PaperFinding struct {
	Pages  []int
	Answer any
}

// paperAnswer turns a closed part's read answer into the answer the app stores
// for it, the letters taken from the member's seeded view (shown). ok is false
// when the reply does not fit the part, which then reads as unanswered.
func paperAnswer(kind string, a, shown map[string]any, raw any) (any, bool) {
	letters := func(list []any, n int) ([]int, bool) {
		out := make([]int, 0, len(list))
		for _, v := range list {
			text, _ := v.(string)
			text = strings.ToUpper(strings.TrimSpace(text))
			if len(text) != 1 || text[0] < 'A' || int(text[0]-'A') >= n {
				return nil, false
			}
			out = append(out, int(text[0]-'A'))
		}
		return out, true
	}
	switch kind {
	case "mcq":
		// Letters name options as shown; answers are authored indices.
		list, _ := raw.([]any)
		_, authored := questions.ShownChoices(shown)
		picked, ok := letters(list, len(authored))
		if !ok || len(picked) == 0 {
			return nil, false
		}
		out := make([]any, len(picked))
		for i, n := range picked {
			out[i] = float64(authored[n])
		}
		return out, true
	case "boolean":
		b, ok := raw.(bool)
		return b, ok
	case "short":
		text, ok := raw.(string)
		return text, ok && strings.TrimSpace(text) != ""
	case "gaps":
		list, ok := raw.([]any)
		accepted, _ := a["accepted"].([]any)
		if !ok {
			return nil, false
		}
		out := make([]any, len(accepted))
		for i := range out {
			out[i] = ""
			if i < len(list) {
				if text, isText := list[i].(string); isText {
					out[i] = text
				}
			}
		}
		return out, true
	case "matching":
		chosen, ok := raw.(map[string]any)
		options, _ := shown["options"].([]any)
		left, _ := shown["left"].([]any)
		if !ok {
			return nil, false
		}
		out := map[string]any{}
		for item, v := range chosen {
			n, err := strconv.Atoi(item)
			picked, fits := letters([]any{v}, len(options))
			if err != nil || n < 1 || n > len(left) || !fits {
				continue
			}
			out[strconv.Itoa(n-1)] = options[picked[0]]
		}
		return out, len(out) > 0
	case "ordering":
		list, _ := raw.([]any)
		items, _ := shown["items"].([]any)
		order, ok := letters(list, len(items))
		if !ok || len(order) != len(items) {
			return nil, false
		}
		out := make([]any, len(order))
		for i, n := range order {
			out[i] = items[n]
		}
		return out, true
	}
	return nil, false
}

// SavePaperRead stores what the read call found, by part id: closed answers
// are marked against the key as typed ones are, an open or drawn part with
// pages waits for the AI with those pages, and a part on no page is
// unanswered. Every part keeps its pages for staff. The answers are logged,
// and the quiz rated once it shows as practice, as at any submission. A
// paper already read is left alone.
func (s *Store) SavePaperRead(ctx context.Context, attemptID string, reads map[string]PaperFinding, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1 FOR UPDATE OF t`, attemptID))
		if err != nil {
			return err
		}
		if r.paper != PaperReading {
			return nil
		}
		frozen, err := paperQuestions(r)
		if err != nil {
			return err
		}
		views := questions.LearnerViewsSeeded(frozen, r.id)
		given := map[string]any{}
		for n, q := range frozen {
			parts, _ := q["parts"].([]any)
			viewParts, _ := views[n]["parts"].([]any)
			for i, raw := range parts {
				p, _ := raw.(map[string]any)
				pid, _ := p["id"].(string)
				read := reads[pid]
				if len(read.Pages) == 0 {
					continue
				}
				a, _ := p["answer"].(map[string]any)
				kind, _ := a["type"].(string)
				if questions.ModelMarked(kind) {
					given[pid] = map[string]any{"pages": read.Pages}
					continue
				}
				view, _ := viewParts[i].(map[string]any)
				shown, _ := view["answer"].(map[string]any)
				if value, ok := paperAnswer(kind, a, shown, read.Answer); ok {
					given[pid] = value
				}
			}
		}
		graded := make([]map[string]any, len(frozen))
		for i, q := range frozen {
			out, _, _ := questions.Graded(q, given, nil)
			parts, _ := out["parts"].([]any)
			for _, raw := range parts {
				p, _ := raw.(map[string]any)
				pid, _ := p["id"].(string)
				if pages := reads[pid].Pages; len(pages) > 0 {
					p["pages"] = pages
				}
				a, _ := p["answer"].(map[string]any)
				if questions.ModelMarked(a["type"]) && given[pid] != nil {
					p["pending"] = true
					delete(p, "itemAwards")
				}
			}
			graded[i] = out
		}
		correct, total, waitingMarks, waitingAnswers := attemptTotals(graded)
		pct := 0
		if total > 0 {
			pct = int(correct / total * 100)
		}
		rawAnswers, err := json.Marshal(given)
		if err != nil {
			return err
		}
		rawGraded, err := json.Marshal(graded)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE attempts SET answers=$2, questions=$3, correct=$4, total=$5, pct=$6,
				waiting_marks=$7, waiting_answers=$8, paper='read' WHERE id=$1`,
			r.id, rawAnswers, rawGraded, correct, total, pct, waitingMarks, waitingAnswers); err != nil {
			return err
		}
		mt := r.quiz()
		for _, q := range graded {
			if err := logAnswerTx(ctx, tx, r.userID, mt, q, given, answerSourceAssignment, r.id, now); err != nil {
				return err
			}
		}
		if r.released != nil {
			return s.rateAttemptTx(ctx, tx, r.userID, r.sourceID, graded, given, now)
		}
		return nil
	})
}

// handInPaperTx submits a paper attempt: nothing is marked or logged yet, and
// every part waits for the read (paper 'reading'), or a file's graded quiz's
// one part for staff's mark.
func (s *Store) handInPaperTx(ctx context.Context, tx pgx.Tx, r attemptRow, auto bool, now time.Time) error {
	frozen, err := decodeFrozen(r.frozen)
	if err != nil {
		return err
	}
	// No read maps a file's graded quiz to pages (Epo 2026-11-20, no AI).
	var paperFile bool
	if err := tx.QueryRow(ctx, `SELECT paper_file FROM assignments WHERE id=$1`, r.assignmentID).Scan(&paperFile); err != nil {
		return err
	}
	read := "reading"
	if paperFile {
		read = "read"
	}
	graded, _ := gradeAttempt(frozen, map[string]any{})
	for _, q := range graded {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			p["pending"] = true
			delete(p, "itemAwards")
			delete(p, "itemResults")
		}
	}
	correct, total, waitingMarks, waitingAnswers := attemptTotals(graded)
	rawGraded, err := json.Marshal(graded)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE attempts SET answers='{}', questions=$2, correct=$3, total=$4, pct=0, taken_at=$5,
			submitted_at=$5, auto_submitted=$6, waiting_marks=$7, waiting_answers=$8, paper=$9 WHERE id=$1`,
		r.id, rawGraded, correct, total, now, auto, waitingMarks, waitingAnswers, read)
	return err
}

// paperPages are the pages a paper's open or drawn part is answered on, as its
// stored answer {"pages": [...]} holds them.
func paperPages(value any) []int {
	m, _ := value.(map[string]any)
	list, _ := m["pages"].([]any)
	var out []int
	for _, v := range list {
		if n, ok := v.(float64); ok {
			out = append(out, int(n))
		}
	}
	return out
}

// PapersToRead are an assignment's submitted papers not read yet, or one
// attempt's (attemptID), a failed read's included. Under manual marking too:
// the read maps parts to pages and marks closed parts (Q716).
func (s *Store) PapersToRead(ctx context.Context, assignmentID, attemptID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT t.id FROM attempts t
		WHERE t.assignment_id=$1 AND ($2='' OR t.id=$2) AND t.paper='reading'
		ORDER BY t.submitted_at`, assignmentID, attemptID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// SubmissionBlob is a submission file's stored object and kind, with a
// .docx's marked copy once staff stored one (marked_copies.go).
type SubmissionBlob struct {
	Path, Kind, Copy string
}

// PaperFileBlob is a paper file's stored object, and a .docx's marked copy
// (to its member once its marks show), for its member, or for staff of the class once submitted; anyone else gets
// ErrNotFound.
func (s *Store) PaperFileBlob(ctx context.Context, userID, attemptID, fileID string) (SubmissionBlob, error) {
	var owner, wsID string
	var submitted bool
	var blob SubmissionBlob
	var shown bool
	err := s.pool.QueryRow(ctx, `SELECT t.user_id, a.workspace_id, t.submitted_at IS NOT NULL, COALESCE(f.blob_path, ''), f.kind,
			COALESCE(f.marked_copy_path, ''), `+submissionMarksShownSQL+`
		FROM files f JOIN attempts t ON t.id=f.attempt_id JOIN assignments a ON a.id=t.assignment_id
		WHERE f.id=$1 AND f.attempt_id=$2`, fileID, attemptID).Scan(&owner, &wsID, &submitted, &blob.Path, &blob.Kind, &blob.Copy, &shown)
	if isNoRows(err) {
		return SubmissionBlob{}, ErrNotFound
	}
	if err != nil {
		return SubmissionBlob{}, err
	}
	if owner == userID {
		// Nothing of staff's marking shows before the grade (S1).
		if !shown {
			blob.Copy = ""
		}
		return blob, nil
	}
	staff, err := s.assignmentStaff(ctx, s.pool, userID, wsID)
	if err != nil || !staff || !submitted {
		return SubmissionBlob{}, ErrNotFound
	}
	return blob, nil
}

// leftHandInSQL holds for a hand-in file f its member added but never handed
// in before the assignment closed, by hand or at its due date under NoLate.
// Staff never saw it, so its member may delete it, and it is the one kind of
// submission file the Files page lists: handed-in work stays as handed in for
// good, on its assignment's page (Epo 2026-11-25).
const leftHandInSQL = `EXISTS (SELECT 1 FROM assignments h WHERE h.id = f.hand_in_assignment_id
	AND (h.closed_at IS NOT NULL OR (h.no_late AND h.due_at <= now()))
	AND NOT EXISTS (SELECT 1 FROM assignment_done d WHERE d.assignment_id = h.id AND d.user_id = f.user_id))`

// SubmittedPaper is a hand-in file left unhanded at the close, on its member's
// Files page, where they may delete it (leftHandInSQL).
type SubmittedPaper struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Kind          string    `json:"kind"`
	AssignmentID  string    `json:"assignmentId"`
	QuizName      string    `json:"quizName"`
	WorkspaceID   string    `json:"workspaceId"`
	WorkspaceName string    `json:"workspaceName"`
	Bytes         int64     `json:"bytes"`
	CreatedAt     time.Time `json:"createdAt"`
}

// SubmittedPapers reads userID's hand-in files left unhanded at the close, by
// id, newest first: the Files page's submissions (ListItems).
func (s *Store) SubmittedPapers(ctx context.Context, userID string, ids []string) ([]SubmittedPaper, error) {
	rows, err := s.pool.Query(ctx, `SELECT f.id, f.name, f.kind, h.id, h.title, h.workspace_id, w.name, f.size_bytes, f.added_at
		FROM files f JOIN assignments h ON h.id = f.hand_in_assignment_id JOIN workspaces w ON w.id = h.workspace_id
		WHERE f.user_id = $1 AND f.id = ANY($2) AND `+leftHandInSQL+`
		ORDER BY f.added_at DESC, f.id DESC`, userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubmittedPaper{}
	for rows.Next() {
		var p SubmittedPaper
		if err := rows.Scan(&p.ID, &p.Name, &p.Kind, &p.AssignmentID, &p.QuizName,
			&p.WorkspaceID, &p.WorkspaceName, &p.Bytes, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeleteLeftHandIn deletes one of the caller's hand-in files left unhanded at
// the close (leftHandInSQL). Handed-in files take no delete.
func (s *Store) DeleteLeftHandIn(ctx context.Context, userID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM files f
		WHERE f.id = $2 AND f.user_id = $1 AND f.submission_position IS NOT NULL AND `+leftHandInSQL, userID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// dropLeaverSubmissionsTx deletes, as a member leaves or is removed, the files
// of their papers in the workspace's assignments that are read with nothing
// waiting, and of their hand-ins there, as their marked drawings go
// (dropLeaverMarkedDrawingsTx); a paper still waiting stays for staff to mark.
// The marks stay.
func dropLeaverSubmissionsTx(ctx context.Context, tx pgx.Tx, wsID, userID string) error {
	_, err := tx.Exec(ctx, `DELETE FROM files f WHERE f.user_id=$2 AND (
		EXISTS (SELECT 1 FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE t.id=f.attempt_id AND a.workspace_id=$1 AND t.submitted_at IS NOT NULL
				AND t.paper='read' AND t.waiting_answers=0)
		OR EXISTS (SELECT 1 FROM assignments h WHERE h.id=f.hand_in_assignment_id AND h.workspace_id=$1))`, wsID, userID)
	return err
}

// MarkPaperBatch makes an upload batch a paper's, which settles with no
// notification: the member watches it land on the page.
func (s *Store) MarkPaperBatch(ctx context.Context, batchID, userID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE source_batches SET paper=true WHERE id=$1 AND user_id=$2`, batchID, userID)
	return err
}
