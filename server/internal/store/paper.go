package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// Papers: an assignment attempt answered on paper (Epo 2026-11-08,
// todo-file-submissions.md 5a). Its files are the member's own standalone
// uploads through the normal upload, linked to the attempt by files.attempt_id.

// PaperMaxFiles bounds a paper's files; the pipeline bounds its pages.
const PaperMaxFiles = 15

// ErrPaperClosed: the attempt no longer takes files (submitted, timed out, or
// not answered on paper).
var ErrPaperClosed = errors.New("this attempt no longer takes files")

// ErrPaperFull: one more file would pass a paper's or hand-in's file count or the
// member's source file cap across its files (O1, Epo 2026-11-08).
var ErrPaperFull = errors.New("you can hand in at most 15 files, within your file size limit")

// checkPaperUploadTx admits size more bytes into userID's running paper
// attempt: their own, answered on paper, before its time runs out, within
// PaperMaxFiles and maxBytes across its files and pending uploads. It locks
// the attempt row so two uploads cannot both pass.
func (s *Store) checkPaperUploadTx(ctx context.Context, tx pgx.Tx, attemptID, userID string, size, maxBytes int64, now time.Time) error {
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
	if files+1 > PaperMaxFiles || bytes+size > maxBytes {
		return ErrPaperFull
	}
	return nil
}

// AssertPaperUpload is an upload ticket's check of checkPaperUploadTx, with the
// account's lifecycle and no storage quota: a paper saves past the limit, its
// attempt having started while storage was not full (S6).
func (s *Store) AssertPaperUpload(ctx context.Context, attemptID, userID string, size, maxBytes int64, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.admitAccountTx(ctx, tx, userID); err != nil {
			return err
		}
		return s.checkPaperUploadTx(ctx, tx, attemptID, userID, size, maxBytes, now)
	})
}

// reservePaperStorageTx reserves a paper upload's bytes past the storage
// limit, as an assignment drawing saves (admitAccountTx).
func (s *Store) reservePaperStorageTx(ctx context.Context, tx pgx.Tx, userID string, requested int64) error {
	if err := s.admitAccountTx(ctx, tx, userID); err != nil {
		return err
	}
	if err := s.ensureStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE user_storage
		SET reserved_bytes=reserved_bytes+$2, updated_at=now()
		WHERE user_id=$1`, userID, requested)
	return err
}

// RemovePaperFile deletes a file from the member's running paper. Its bytes
// and blob go as any deleted file's do (the files triggers).
func (s *Store) RemovePaperFile(ctx context.Context, userID, attemptID, fileID string, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		if err := s.checkPaperUploadTx(ctx, tx, attemptID, userID, 0, 1<<62, now); err != nil && !errors.Is(err, ErrPaperFull) {
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

// OrderPaperFiles puts the running paper's files in the order given, which
// must name each of them once.
func (s *Store) OrderPaperFiles(ctx context.Context, userID, attemptID string, fileIDs []string, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		if err := s.checkPaperUploadTx(ctx, tx, attemptID, userID, 0, 1<<62, now); err != nil && !errors.Is(err, ErrPaperFull) {
			return err
		}
		var held []string
		rows, err := tx.Query(ctx, `SELECT id FROM files WHERE attempt_id=$1`, attemptID)
		if err != nil {
			return err
		}
		held, err = pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if len(held) != len(fileIDs) || len(uniqueStrings(fileIDs)) != len(fileIDs) {
			return assignmentInput("name each of the paper's files once")
		}
		for i, id := range fileIDs {
			tag, err := tx.Exec(ctx, `UPDATE files SET submission_position=$3 WHERE id=$1 AND attempt_id=$2`, id, attemptID, i+1)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return assignmentInput("name each of the paper's files once")
			}
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
	// points, for the open and drawing parts the AI grades.
	Listing   string
	Question  string
	Items     []string
	ItemMarks []float64
}

// Paper is a submitted paper with the parts its marking lists.
type Paper struct {
	// Read: its pages are read; else the read call is still to run.
	Read        bool
	AttemptID   string
	WorkspaceID string
	PayerID     string
	Files       []PaperFile
	Parts       []PaperPart
}

// paperTypes names each answer type as the read call's prompt does.
var paperTypes = map[string]string{
	"mcq": "choice", "boolean": "true/false", "short": "short", "gaps": "gaps",
	"matching": "matching", "ordering": "ordering", "open": "open", "drawing": "drawing",
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
	frozen, err := decodeFrozen(r.frozen)
	if err != nil {
		return Paper{}, err
	}
	if r.shuffle {
		frozen = shuffledQuestions(r.id, frozen)
	}
	views := questions.LearnerViewsSeeded(frozen, r.id)
	out := Paper{Read: r.paper == PaperRead, AttemptID: r.id, WorkspaceID: r.wsID, PayerID: r.userID, Files: files}
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
				options, _ := shown["options"].([]any)
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
				part.Question = questions.GradingText(q, i)
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
		list, _ := raw.([]any)
		options, _ := shown["options"].([]any)
		picked, ok := letters(list, len(options))
		if !ok || len(picked) == 0 {
			return nil, false
		}
		out := make([]any, len(picked))
		for i, n := range picked {
			out[i] = float64(n)
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
		frozen, err := decodeFrozen(r.frozen)
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
		mt := Material{ID: r.sourceID, WorkspaceID: r.wsID}
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
// every part waits for the read (paper 'reading').
func (s *Store) handInPaperTx(ctx context.Context, tx pgx.Tx, r attemptRow, auto bool, now time.Time) error {
	frozen, err := decodeFrozen(r.frozen)
	if err != nil {
		return err
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
			submitted_at=$5, auto_submitted=$6, waiting_marks=$7, waiting_answers=$8, paper='reading' WHERE id=$1`,
		r.id, rawGraded, correct, total, now, auto, waitingMarks, waitingAnswers)
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
// attempt's (attemptID).
func (s *Store) PapersToRead(ctx context.Context, assignmentID, attemptID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT t.id FROM attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE t.assignment_id=$1 AND ($2='' OR t.id=$2) AND t.paper='reading' AND a.marking <> 'manual'
		ORDER BY t.submitted_at`, assignmentID, attemptID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// PaperFileBlob is a paper file's stored object for its member, or for staff
// of its assignment's class once submitted; anyone else gets ErrNotFound. kind
// tells a PDF, shown page by page, from other files.
func (s *Store) PaperFileBlob(ctx context.Context, userID, attemptID, fileID string) (blobPath, kind string, err error) {
	var owner, wsID string
	var submitted bool
	err = s.pool.QueryRow(ctx, `SELECT t.user_id, a.workspace_id, t.submitted_at IS NOT NULL, COALESCE(f.blob_path, ''), f.kind
		FROM files f JOIN attempts t ON t.id=f.attempt_id JOIN assignments a ON a.id=t.assignment_id
		WHERE f.id=$1 AND f.attempt_id=$2`, fileID, attemptID).Scan(&owner, &wsID, &submitted, &blobPath, &kind)
	if isNoRows(err) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if owner == userID {
		return blobPath, kind, nil
	}
	staff, err := s.assignmentStaff(ctx, s.pool, userID, wsID)
	if err != nil || !staff || !submitted {
		return "", "", ErrNotFound
	}
	return blobPath, kind, nil
}

// paperDeletableSQL holds for a paper file f of attempt t that its member may
// delete (Files › Submissions): submitted and read, every part marked, and the
// assignment closed with its grades out, so staff can still revise marks
// while it runs (Epo 2026-11-08, "Yes, both tabs").
const paperDeletableSQL = `t.submitted_at IS NOT NULL AND t.paper = 'read' AND t.waiting_answers = 0
	AND EXISTS (SELECT 1 FROM assignments a WHERE a.id = t.assignment_id
		AND (a.closed_at IS NOT NULL OR (a.no_late AND a.due_at <= now()))
		AND (a.grades_shown = 'automatic' OR a.grades_released_at IS NOT NULL))`

// submittedDeletableSQL holds for a file f, a paper's or a hand-in's, that its
// member may delete. A hand-in's goes once its assignment closes, by its
// owner, or at its due date under NoLate.
const submittedDeletableSQL = `(EXISTS (SELECT 1 FROM attempts t WHERE t.id = f.attempt_id AND ` + paperDeletableSQL + `)
	OR EXISTS (SELECT 1 FROM assignments h WHERE h.id = f.hand_in_assignment_id
		AND (h.closed_at IS NOT NULL OR (h.no_late AND h.due_at <= now()))))`

// SubmittedPaper is one file of a paper or a hand-in its member may delete;
// a hand-in's has no AttemptID.
type SubmittedPaper struct {
	ID            string    `json:"id"`
	AttemptID     string    `json:"attemptId,omitempty"`
	Name          string    `json:"name"`
	Kind          string    `json:"kind"`
	AssignmentID  string    `json:"assignmentId"`
	QuizName      string    `json:"quizName"`
	WorkspaceID   string    `json:"workspaceId,omitempty"`
	WorkspaceName string    `json:"workspaceName"`
	Bytes         int64     `json:"bytes"`
	CreatedAt     time.Time `json:"createdAt"`
}

// SubmittedPapers is a page of the caller's deletable paper files, newest
// first, with how many they have and what those hold in all.
type SubmittedPapers struct {
	Items      []SubmittedPaper `json:"items" nullable:"false"`
	Count      int              `json:"count"`
	TotalBytes int64            `json:"totalBytes"`
	NextCursor string           `json:"nextCursor,omitempty"`
}

// ListSubmittedPapers lists the paper and hand-in files userID handed in and
// may delete.
func (s *Store) ListSubmittedPapers(ctx context.Context, userID, cursor string, limit int) (SubmittedPapers, error) {
	out := SubmittedPapers{Items: []SubmittedPaper{}}
	if err := s.pool.QueryRow(ctx, `SELECT count(*), COALESCE(sum(f.size_bytes), 0)
		FROM files f WHERE f.user_id = $1 AND f.submission_position IS NOT NULL AND `+submittedDeletableSQL,
		userID).Scan(&out.Count, &out.TotalBytes); err != nil {
		return out, err
	}
	after, afterID, err := decodeTimeCursor(cursor)
	if err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT f.id, COALESCE(t.id, ''), f.name, f.kind, COALESCE(t.assignment_id, h.id),
			COALESCE(t.quiz_name, h.title, ''), COALESCE(t.workspace_id, h.workspace_id, ''),
			COALESCE(t.workspace_name, w.name, ''), f.size_bytes, f.added_at
		FROM files f LEFT JOIN attempts t ON t.id = f.attempt_id
			LEFT JOIN assignments h ON h.id = f.hand_in_assignment_id LEFT JOIN workspaces w ON w.id = h.workspace_id
		WHERE f.user_id = $1 AND f.submission_position IS NOT NULL AND `+submittedDeletableSQL+`
			AND ($2::timestamptz IS NULL OR (f.added_at, f.id) < ($2, $3))
		ORDER BY f.added_at DESC, f.id DESC LIMIT $4`, userID, after, afterID, limit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var p SubmittedPaper
		if err := rows.Scan(&p.ID, &p.AttemptID, &p.Name, &p.Kind, &p.AssignmentID, &p.QuizName,
			&p.WorkspaceID, &p.WorkspaceName, &p.Bytes, &p.CreatedAt); err != nil {
			return out, err
		}
		out.Items = append(out.Items, p)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
		last := out.Items[limit-1]
		out.NextCursor = encodeTimeCursor(last.CreatedAt, last.ID)
	}
	return out, nil
}

// DeleteSubmittedPapers deletes the caller's deletable paper and hand-in
// files: the ids given, or every one when ids is nil. A paper's marks stay;
// staff then read that the member deleted the file (mock F2). It returns how
// many went.
func (s *Store) DeleteSubmittedPapers(ctx context.Context, userID string, ids []string) (int, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM files f
		WHERE f.user_id = $1 AND f.submission_position IS NOT NULL
			AND ($2::text[] IS NULL OR f.id = ANY($2)) AND `+submittedDeletableSQL, userID, ids)
	return int(tag.RowsAffected()), err
}

// MarkPaperBatch makes an upload batch a paper's, which settles with no
// notification: the member watches it land on the page.
func (s *Store) MarkPaperBatch(ctx context.Context, batchID, userID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE source_batches SET paper=true WHERE id=$1 AND user_id=$2`, batchID, userID)
	return err
}
