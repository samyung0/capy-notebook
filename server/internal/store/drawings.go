package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// A drawing answer's stored objects (migration 0156): the board the member
// drew, always, and its marking image only while its part waits on the AI.

// DrawingObject is one object a handler put in the bucket for a drawing.
type DrawingObject struct {
	Key   string
	Bytes int64
	Type  string
}

// Drawing is a stored drawing answer.
type Drawing struct {
	ID         string
	UserID     string
	AttemptID  string
	PartID     string
	BoardKey   string
	BoardBytes int64
	ImageKey   string
	ImageType  string
	ImageBytes int64
	CreatedAt  time.Time
}

// ErrNotDrawingPart refuses a drawing for a part that is not a drawing part of
// the attempt's questions.
var ErrNotDrawingPart = errors.New("not a drawing part")

const drawingCols = `id, user_id, attempt_id, part_id, board_key, board_bytes,
	COALESCE(image_key, ''), COALESCE(image_type, ''), image_bytes, created_at`

func scanDrawing(row pgx.Row) (Drawing, error) {
	var d Drawing
	err := row.Scan(&d.ID, &d.UserID, &d.AttemptID, &d.PartID, &d.BoardKey, &d.BoardBytes,
		&d.ImageKey, &d.ImageType, &d.ImageBytes, &d.CreatedAt)
	return d, err
}

// drawingPartIn says whether questions (a JSON array of questions) hold partID
// as a drawing part.
func drawingPartIn(raw []byte, partID string) bool {
	var qs []map[string]any
	if json.Unmarshal(raw, &qs) != nil {
		return false
	}
	for _, q := range qs {
		parts, _ := q["parts"].([]any)
		for _, rp := range parts {
			p, _ := rp.(map[string]any)
			if p["id"] != partID {
				continue
			}
			a, _ := p["answer"].(map[string]any)
			return a["type"] == "drawing"
		}
	}
	return false
}

// drawingAttempt is a member's running assignment attempt as a drawing reads it.
type drawingAttempt struct {
	frozen  []byte
	marking string
}

// inDrawingAttempt runs fn on the caller's own running attempt in a class they
// still belong to, as save and delete both need: anyone else's is ErrNotFound,
// a submitted one ErrAttemptFinished, and one whose time ran out is submitted
// first. commit false rolls back what fn did (a check before the bucket).
func (s *Store) inDrawingAttempt(ctx context.Context, userID, attemptID string, now time.Time, commit bool, fn func(pgx.Tx, drawingAttempt) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var r attemptRow
	var d drawingAttempt
	err = tx.QueryRow(ctx, `SELECT a.workspace_id, t.submitted_at, t.deadline_at, a.closed_at, a.no_late, a.due_at, a.questions, a.marking
		FROM attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`, attemptID, userID).
		Scan(&r.wsID, &r.submitted, &r.deadline, &r.closedAt, &r.noLate, &r.dueAt, &d.frozen, &d.marking)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := s.assignmentStaff(ctx, tx, userID, r.wsID); err != nil {
		return err
	}
	if r.submitted != nil {
		return ErrAttemptFinished
	}
	if r.expired(now) {
		_ = tx.Rollback(ctx)
		if err := s.finishAttemptIfRunning(ctx, attemptID, now); err != nil {
			return err
		}
		return ErrAttemptFinished
	}
	if err := fn(tx, d); err != nil {
		return err
	}
	if !commit {
		return nil
	}
	return tx.Commit(ctx)
}

// CheckAssignmentDrawing refuses, before anything reaches the bucket, a drawing
// that SaveAssignmentDrawing would refuse: not the caller's running attempt, not
// a drawing part, or past the payer's storage (Epo 2026-11-07, Q693). Manual
// says the assignment is marked by hand, so no marking image is written or
// counted. Save checks all of it again.
func (s *Store) CheckAssignmentDrawing(ctx context.Context, userID, attemptID, partID string, boardBytes, imageBytes int64, now time.Time) (manual bool, err error) {
	err = s.inDrawingAttempt(ctx, userID, attemptID, now, false, func(tx pgx.Tx, d drawingAttempt) error {
		if !drawingPartIn(d.frozen, partID) {
			return ErrNotDrawingPart
		}
		manual = d.marking == MarkingManual
		adds := boardBytes
		if !manual {
			adds += imageBytes
		}
		var held int64
		err := tx.QueryRow(ctx, `SELECT board_bytes + image_bytes FROM drawings
			WHERE attempt_id=$1 AND part_id=$2`, attemptID, partID).Scan(&held)
		if err != nil && !isNoRows(err) {
			return err
		}
		if adds <= held {
			return nil
		}
		return s.gateStorageTx(ctx, tx, userID, adds-held)
	})
	return manual, err
}

// SaveAssignmentDrawing stores the board (and the marking image, when the
// assignment's marking uses the AI) a member sent with Done for one part of
// their running attempt, replacing what that part held. The person attempting
// pays (Epo 2026-11-06): the growth passes their storage gate. The objects are
// already in the bucket, after CheckAssignmentDrawing; a refusal here (a race)
// leaves them to the orphan sweep.
func (s *Store) SaveAssignmentDrawing(ctx context.Context, userID, attemptID, partID string, board DrawingObject, image *DrawingObject, now time.Time) (Drawing, error) {
	var saved Drawing
	err := s.inDrawingAttempt(ctx, userID, attemptID, now, true, func(tx pgx.Tx, d drawingAttempt) error {
		if !drawingPartIn(d.frozen, partID) {
			return ErrNotDrawingPart
		}
		// Marked by hand, nothing reads a marking image: none is kept.
		if d.marking == MarkingManual {
			image = nil
		}
		var err error
		saved, err = s.putDrawingTx(ctx, tx, userID, attemptID, partID, board, image)
		return err
	})
	return saved, err
}

// DeleteAssignmentDrawing forgets the drawing of one part of the member's
// running attempt, as Done on an emptied board leaves the part unanswered: it is
// neither submitted nor charged any longer. A part holding none is no error.
func (s *Store) DeleteAssignmentDrawing(ctx context.Context, userID, attemptID, partID string, now time.Time) error {
	return s.inDrawingAttempt(ctx, userID, attemptID, now, true, func(tx pgx.Tx, _ drawingAttempt) error {
		_, err := tx.Exec(ctx, `DELETE FROM drawings WHERE attempt_id=$1 AND part_id=$2`, attemptID, partID)
		return err
	})
}

// AssertStorageRoom checks, and rolls back, that userID's storage takes
// requested more bytes: a practice check of a drawing asks before it pays for
// marking (Epo 2026-11-07, Q694). The write's own gate still decides.
func (s *Store) AssertStorageRoom(ctx context.Context, userID string, requested int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	return s.gateStorageTx(ctx, tx, userID, requested)
}

// putDrawingTx upserts the part's drawing after the payer's gate passes for
// what it adds over what the part held.
func (s *Store) putDrawingTx(ctx context.Context, tx pgx.Tx, userID, attemptID, partID string, board DrawingObject, image *DrawingObject) (Drawing, error) {
	var held int64
	err := tx.QueryRow(ctx, `SELECT board_bytes + image_bytes FROM drawings
		WHERE attempt_id=$1 AND part_id=$2 FOR UPDATE`, attemptID, partID).Scan(&held)
	if err != nil && !isNoRows(err) {
		return Drawing{}, err
	}
	adds := board.Bytes
	imageKey, imageType, imageBytes := (*string)(nil), (*string)(nil), int64(0)
	if image != nil {
		adds += image.Bytes
		imageKey, imageType, imageBytes = &image.Key, &image.Type, image.Bytes
	}
	if adds > held {
		if err := s.gateStorageTx(ctx, tx, userID, adds-held); err != nil {
			return Drawing{}, err
		}
	}
	return scanDrawing(tx.QueryRow(ctx, `INSERT INTO drawings
		(id, user_id, attempt_id, part_id, board_key, board_bytes, image_key, image_type, image_bytes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (attempt_id, part_id) DO UPDATE SET
			board_key=EXCLUDED.board_key, board_bytes=EXCLUDED.board_bytes,
			image_key=EXCLUDED.image_key, image_type=EXCLUDED.image_type,
			image_bytes=EXCLUDED.image_bytes, updated_at=now()
		RETURNING `+drawingCols,
		uid("dr"), userID, attemptID, partID, board.Key, board.Bytes, imageKey, imageType, imageBytes))
}

// AttemptDrawings are an attempt's drawings by part id.
func (s *Store) AttemptDrawings(ctx context.Context, attemptID string) (map[string]Drawing, error) {
	return attemptDrawingsTx(ctx, s.pool, attemptID)
}

func attemptDrawingsTx(ctx context.Context, q rowsQueryer, attemptID string) (map[string]Drawing, error) {
	rows, err := q.Query(ctx, `SELECT `+drawingCols+` FROM drawings WHERE attempt_id=$1`, attemptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Drawing{}
	for rows.Next() {
		d, err := scanDrawing(rows)
		if err != nil {
			return nil, err
		}
		out[d.PartID] = d
	}
	return out, rows.Err()
}

// DropDrawingImages forgets the marking images of an attempt's parts once
// their AI marking has landed (Epo 2026-11-06): nothing marks them again, and
// the board stays.
func (s *Store) DropDrawingImages(ctx context.Context, attemptID string, partIDs []string) error {
	return dropDrawingImagesTx(ctx, s.pool, attemptID, partIDs)
}

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func dropDrawingImagesTx(ctx context.Context, q execer, attemptID string, partIDs []string) error {
	if len(partIDs) == 0 {
		return nil
	}
	_, err := q.Exec(ctx, `UPDATE drawings SET image_key=NULL, image_type=NULL, image_bytes=0, updated_at=now()
		WHERE attempt_id=$1 AND part_id = ANY($2) AND image_key IS NOT NULL`, attemptID, partIDs)
	return err
}

// dropAssignmentDrawingImagesTx forgets every marking image of an assignment's
// attempts once it is marked by hand: nothing marks from them (Epo 2026-11-06).
func dropAssignmentDrawingImagesTx(ctx context.Context, tx pgx.Tx, assignmentID string) error {
	_, err := tx.Exec(ctx, `UPDATE drawings d SET image_key=NULL, image_type=NULL, image_bytes=0, updated_at=now()
		FROM attempts t WHERE t.id=d.attempt_id AND t.assignment_id=$1 AND d.image_key IS NOT NULL`, assignmentID)
	return err
}

// withDrawingAnswers sets each drawing part's answer from the attempt's stored
// drawings, {"drawing": id}, and drops a drawing value the attempt doesn't hold:
// the browser never names a drawing the server didn't store for that part.
func withDrawingAnswers(answers map[string]any, drawings map[string]Drawing) map[string]any {
	out := make(map[string]any, len(answers)+len(drawings))
	for part, value := range answers {
		if m, ok := value.(map[string]any); ok {
			if _, named := m["drawing"]; named {
				continue
			}
		}
		out[part] = value
	}
	for part, d := range drawings {
		out[part] = map[string]any{"drawing": d.ID}
	}
	return out
}

// isDrawingAnswer says whether an answer value names a stored drawing.
func isDrawingAnswer(value any) bool {
	m, ok := value.(map[string]any)
	if !ok {
		return false
	}
	id, ok := m["drawing"].(string)
	return ok && id != ""
}

// keepQuizDrawingsTx stores a practice check's drawings with its attempt, once
// the attempt row exists, and names them in the attempt's answers.
func keepQuizDrawingsTx(ctx context.Context, s *Store, tx pgx.Tx, userID string, d AttemptDetail, answers map[string]any, drawings map[string]QuizDrawing) (AttemptDetail, error) {
	for partID, drawing := range drawings {
		if _, err := s.putDrawingTx(ctx, tx, userID, d.ID, partID, drawing.Board, drawing.Image); err != nil {
			return d, err
		}
	}
	held, err := attemptDrawingsTx(ctx, tx, d.ID)
	if err != nil {
		return d, err
	}
	raw, err := json.Marshal(withDrawingAnswers(answers, held))
	if err != nil {
		return d, err
	}
	d.Answers = raw
	_, err = tx.Exec(ctx, `UPDATE attempts SET answers=$2 WHERE id=$1`, d.ID, raw)
	return d, err
}

// ReadableDrawing is a drawing its reader may open: the person who drew it, or
// an owner, editor or teaching assistant of the assignment's workspace. Nobody
// reads one through a shared page. Anything else is ErrNotFound.
func (s *Store) ReadableDrawing(ctx context.Context, userID, drawingID string) (Drawing, error) {
	d, err := scanDrawing(s.pool.QueryRow(ctx, `SELECT `+drawingCols+` FROM drawings WHERE id=$1`, drawingID))
	if isNoRows(err) {
		return Drawing{}, ErrNotFound
	}
	if err != nil {
		return Drawing{}, err
	}
	if d.UserID == userID {
		return d, nil
	}
	var wsID *string
	if err := s.pool.QueryRow(ctx, `SELECT a.workspace_id FROM attempts t
		JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1`, d.AttemptID).Scan(&wsID); err != nil && !isNoRows(err) {
		return Drawing{}, err
	}
	if wsID == nil {
		return Drawing{}, ErrNotFound
	}
	staff, err := s.assignmentStaff(ctx, s.pool, userID, *wsID)
	if err != nil || !staff {
		return Drawing{}, ErrNotFound
	}
	return d, nil
}

// dropLeaverMarkedDrawingsTx deletes, as a member leaves or is removed, their
// drawings in the workspace's assignments whose parts are marked; the ones
// still waiting stay so staff can mark them (Epo 2026-11-06). The marks stay.
func dropLeaverMarkedDrawingsTx(ctx context.Context, tx pgx.Tx, wsID, userID string) error {
	_, err := tx.Exec(ctx, `DELETE FROM drawings d
		USING attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE d.attempt_id=t.id AND a.workspace_id=$1 AND t.user_id=$2
			AND t.submitted_at IS NOT NULL
			AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.questions) q,
				jsonb_array_elements(q->'parts') p
				WHERE p->>'id' = d.part_id AND p ? 'awarded'
					AND COALESCE((p->>'pending')::boolean, false) = false)`, wsID, userID)
	return err
}

// markedDrawingSQL finds, for a drawing d of attempt t, the question and part
// it answers, only once that part is marked (graded, not waiting on anyone).
const markedDrawingSQL = `SELECT q.n AS question, p.n AS part, jsonb_array_length(q.v->'parts') AS parts
	FROM jsonb_array_elements(COALESCE(t.questions, '[]'::jsonb)) WITH ORDINALITY q(v, n),
		jsonb_array_elements(q.v->'parts') WITH ORDINALITY p(v, n)
	WHERE p.v->>'id' = d.part_id AND p.v ? 'awarded'
		AND COALESCE((p.v->>'pending')::boolean, false) = false
	LIMIT 1`

// MarkedDrawing is one of a payer's marked drawings, for Files › Canvas.
type MarkedDrawing struct {
	ID            string    `json:"id"`
	AttemptID     string    `json:"attemptId"`
	Assignment    bool      `json:"assignment" doc:"An assignment's answer; otherwise practice"`
	QuizName      string    `json:"quizName"`
	WorkspaceID   string    `json:"workspaceId,omitempty"`
	WorkspaceName string    `json:"workspaceName"`
	Question      int       `json:"question" doc:"The question's number, from 1"`
	Part          int       `json:"part,omitempty" doc:"The part's number from 1, when the question has more than one"`
	Bytes         int64     `json:"bytes"`
	CreatedAt     time.Time `json:"createdAt"`
}

// MarkedDrawings is a page of the caller's marked drawings, newest first, with
// how many they have and what those hold in all.
type MarkedDrawings struct {
	Items      []MarkedDrawing `json:"items" nullable:"false"`
	Count      int             `json:"count"`
	TotalBytes int64           `json:"totalBytes"`
	NextCursor string          `json:"nextCursor,omitempty"`
}

// ListMarkedDrawings lists the drawings userID pays for whose parts are marked
// (Epo 2026-11-06): only those may be deleted, so only those show. A drawing
// still waiting on marking never lists.
func (s *Store) ListMarkedDrawings(ctx context.Context, userID, cursor string, limit int) (MarkedDrawings, error) {
	out := MarkedDrawings{Items: []MarkedDrawing{}}
	if err := s.pool.QueryRow(ctx, `SELECT count(*), COALESCE(sum(d.board_bytes + d.image_bytes), 0)
		FROM drawings d JOIN attempts t ON t.id = d.attempt_id
		WHERE d.user_id = $1 AND EXISTS (`+markedDrawingSQL+`)`, userID).
		Scan(&out.Count, &out.TotalBytes); err != nil {
		return out, err
	}
	after, afterID, err := decodeTimeCursor(cursor)
	if err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT d.id, d.attempt_id, t.assignment_id IS NOT NULL,
			COALESCE(t.quiz_name, ''), COALESCE(t.workspace_id, ''), COALESCE(t.workspace_name, ''), m.question, CASE WHEN m.parts > 1 THEN m.part ELSE 0 END,
			d.board_bytes + d.image_bytes, d.created_at
		FROM drawings d JOIN attempts t ON t.id = d.attempt_id
		CROSS JOIN LATERAL (`+markedDrawingSQL+`) m
		WHERE d.user_id = $1 AND ($2::timestamptz IS NULL OR (d.created_at, d.id) < ($2, $3))
		ORDER BY d.created_at DESC, d.id DESC
		LIMIT $4`, userID, after, afterID, limit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var d MarkedDrawing
		if err := rows.Scan(&d.ID, &d.AttemptID, &d.Assignment, &d.QuizName, &d.WorkspaceID, &d.WorkspaceName,
			&d.Question, &d.Part, &d.Bytes, &d.CreatedAt); err != nil {
			return out, err
		}
		out.Items = append(out.Items, d)
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

// DeleteMarkedDrawings deletes the payer's marked drawings: the ids given, or
// every one when ids is nil. Their marks stay; results then say the drawing
// was deleted. It returns how many went.
func (s *Store) DeleteMarkedDrawings(ctx context.Context, userID string, ids []string) (int, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM drawings d USING attempts t
		WHERE t.id = d.attempt_id AND d.user_id = $1
			AND ($2::text[] IS NULL OR d.id = ANY($2))
			AND EXISTS (`+markedDrawingSQL+`)`, userID, ids)
	return int(tag.RowsAffected()), err
}
