package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// rowExecer runs one statement on the pool or a caller's transaction.
type rowExecer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

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

// SaveAssignmentDrawing stores the board (and the marking image, when the
// assignment's marking uses the AI) a member sent with Done for one part of
// their running attempt, replacing what that part held. The person attempting
// pays (Epo 2026-11-06): the growth passes their storage gate. The objects are
// already in the bucket; a refusal leaves them to the orphan sweep.
func (s *Store) SaveAssignmentDrawing(ctx context.Context, userID, attemptID, partID string, board DrawingObject, image *DrawingObject, now time.Time) (Drawing, error) {
	var saved Drawing
	expired := false
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var r attemptRow
		err := tx.QueryRow(ctx, `SELECT a.workspace_id, t.submitted_at, t.deadline_at, a.closed_at, a.no_late, a.due_at, a.questions
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`, attemptID, userID).
			Scan(&r.wsID, &r.submitted, &r.deadline, &r.closedAt, &r.noLate, &r.dueAt, &r.frozen)
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
			expired = true
			return nil
		}
		if !drawingPartIn(r.frozen, partID) {
			return ErrNotDrawingPart
		}
		saved, err = s.putDrawingTx(ctx, tx, userID, attemptID, partID, board, image)
		return err
	})
	if err == nil && expired {
		if err := s.finishAttemptIfRunning(ctx, attemptID, now); err != nil {
			return Drawing{}, err
		}
		return Drawing{}, ErrAttemptFinished
	}
	return saved, err
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

// DropDrawingImage forgets a part's marking image once the part is marked, or
// when marking by hand needs none; the board stays.
func (s *Store) DropDrawingImage(ctx context.Context, q rowExecer, attemptID, partID string) error {
	_, err := q.Exec(ctx, `UPDATE drawings SET image_key=NULL, image_type=NULL, image_bytes=0, updated_at=now()
		WHERE attempt_id=$1 AND part_id=$2 AND image_key IS NOT NULL`, attemptID, partID)
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
