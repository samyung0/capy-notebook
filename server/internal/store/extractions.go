package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Extraction is one Make a quiz run (todo-study-tracking.md §8): questions
// read from the selected pages of uploaded files into a new quiz. It keeps no
// link to the files or pages it read.
type Extraction struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Title       string `json:"title"`
	Status      string `json:"status" enum:"running,done,failed"`
	// Recorded counts the questions read so far, saved as each window ends.
	Recorded   int               `json:"recorded"`
	Report     *ExtractionReport `json:"report,omitempty"`
	QuizID     *string           `json:"quizId,omitempty"`
	ErrorCode  *string           `json:"errorCode,omitempty"`
	Error      *string           `json:"error,omitempty"`
	CreatedAt  time.Time         `json:"createdAt"`
	FinishedAt *time.Time        `json:"finishedAt,omitempty"`
}

// ExtractionReport is a finished run's completeness check, by printed
// question label: the labels the pages' text listed (Expected), those never
// read (Missing), those read (Recorded), questions with a part whose key the
// model worked out and no mark scheme replaced (KeysWorkedOut; their solutions
// carry the AI-written label), parts whose key differs from the mark scheme's
// (KeyDisagreements, "4(a)"), questions that keep the page's keys because the
// scheme's were refused (SchemeRefused), saved questions whose part marks
// differ from the printed total (MarksDiffer), mark scheme entries no question
// matched (Unpaired), and questions saved without their figures (Figures, not
// cropped yet). Stopped says why a run ended early: quiz_full, credits, or
// output_limit (its page windows wrote past the run's output budget).
type ExtractionReport struct {
	Expected         []string `json:"expected" nullable:"false"`
	Missing          []string `json:"missing" nullable:"false"`
	Recorded         []string `json:"recorded" nullable:"false"`
	KeysWorkedOut    []string `json:"keysWorkedOut" nullable:"false"`
	KeyDisagreements []string `json:"keyDisagreements" nullable:"false"`
	SchemeRefused    []string `json:"schemeRefused" nullable:"false"`
	MarksDiffer      []string `json:"marksDiffer" nullable:"false"`
	Unpaired         []string `json:"unpaired" nullable:"false"`
	Figures          []string `json:"figures" nullable:"false"`
	Stopped          string   `json:"stopped" enum:",quiz_full,credits,output_limit"`
	Pages            int      `json:"pages"`
	Windows          int      `json:"windows"`
}

const (
	ExtractionRunning = "running"
	ExtractionDone    = "done"
	ExtractionFailed  = "failed"
)

const extractionCols = `id, workspace_id, title, status, jsonb_array_length(questions),
	report, quiz_id, error_code, error, created_at, finished_at`

func scanExtraction(row pgx.Row) (Extraction, error) {
	var e Extraction
	var report []byte
	err := row.Scan(&e.ID, &e.WorkspaceID, &e.Title, &e.Status, &e.Recorded,
		&report, &e.QuizID, &e.ErrorCode, &e.Error, &e.CreatedAt, &e.FinishedAt)
	if err == nil && len(report) > 0 {
		e.Report = &ExtractionReport{}
		err = json.Unmarshal(report, e.Report)
	}
	return e, err
}

// CreateExtraction records a run as running.
func (s *Store) CreateExtraction(ctx context.Context, workspaceID, userID, title string) (Extraction, error) {
	return scanExtraction(s.pool.QueryRow(ctx, `
		INSERT INTO question_extractions (id, workspace_id, user_id, title)
		VALUES ($1, $2, $3, $4)
		RETURNING `+extractionCols, uuid.NewString(), workspaceID, userID, title))
}

// GetExtraction reads a run its starter may see.
func (s *Store) GetExtraction(ctx context.Context, userID, id string) (Extraction, error) {
	e, err := scanExtraction(s.pool.QueryRow(ctx, `
		SELECT `+extractionCols+` FROM question_extractions WHERE id=$1 AND user_id=$2`, id, userID))
	if isNoRows(err) {
		return e, ErrNotFound
	}
	return e, err
}

// SaveExtractionQuestions keeps the questions recorded so far on a running
// run, as each page window ends.
func (s *Store) SaveExtractionQuestions(ctx context.Context, id string, questions json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `UPDATE question_extractions SET questions=$2
		WHERE id=$1 AND status='running'`, id, questions)
	return err
}

// FinishExtraction ends a running run with its quiz and report.
func (s *Store) FinishExtraction(ctx context.Context, id, quizID string, report json.RawMessage) (Extraction, error) {
	e, err := scanExtraction(s.pool.QueryRow(ctx, `
		UPDATE question_extractions SET status='done', quiz_id=$2, report=$3, finished_at=now()
		WHERE id=$1 AND status='running'
		RETURNING `+extractionCols, id, quizID, report))
	if isNoRows(err) {
		return e, ErrNotFound
	}
	return e, err
}

// FailExtraction ends a running run with an error; report is nil when the run
// did not get as far as one.
func (s *Store) FailExtraction(ctx context.Context, id, code, message string, report json.RawMessage) (Extraction, error) {
	var stored []byte
	if len(report) > 0 {
		stored = report
	}
	e, err := scanExtraction(s.pool.QueryRow(ctx, `
		UPDATE question_extractions SET status='failed', error_code=$2, error=$3, report=$4, finished_at=now()
		WHERE id=$1 AND status='running'
		RETURNING `+extractionCols, id, code, message, stored))
	if isNoRows(err) {
		return e, ErrNotFound
	}
	return e, err
}

// FailOrphanedExtractions fails the runs left running by a process that
// stopped: a run lives in the API process that relays it, so at boot none is
// live. Like AbortOrphanedStreams, it must run on every API start.
func (s *Store) FailOrphanedExtractions(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `UPDATE question_extractions
		SET status='failed', error_code='interrupted',
		    error='The server restarted while the questions were being read.', finished_at=now()
		WHERE status='running'`)
	return err
}
