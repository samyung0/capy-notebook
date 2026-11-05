package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// Extraction is one Make a quiz run (todo-study-tracking.md §8): questions
// read from the selected pages of uploaded files into a new quiz. It keeps no
// link to the files or pages it read.
type Extraction struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Title       string `json:"title"`
	Status      string `json:"status" enum:"running,confirming,done,failed,cancelled"`
	// Recorded and Answered count the questions copied and answered so far.
	Recorded int `json:"recorded"`
	Answered int `json:"answered"`
	// Confirmed is how many questions the starter agreed to pay for.
	Confirmed *int `json:"confirmed,omitempty"`
	// Found is what a run waiting on its starter found; only while confirming.
	Found      *ExtractionFound  `json:"found,omitempty"`
	Report     *ExtractionReport `json:"report,omitempty"`
	QuizID     *string           `json:"quizId,omitempty"`
	ErrorCode  *string           `json:"errorCode,omitempty"`
	Error      *string           `json:"error,omitempty"`
	CreatedAt  time.Time         `json:"createdAt"`
	FinishedAt *time.Time        `json:"finishedAt,omitempty"`
	// SpendSessionID is the provider session the question charge settles against.
	SpendSessionID string `json:"-"`
}

// ExtractionFoundQuestion is one line of the map: a printed question, the pages it
// spans and its parts.
type ExtractionFoundQuestion struct {
	Label string   `json:"label"`
	First int      `json:"first"`
	Last  int      `json:"last"`
	Parts []string `json:"parts" nullable:"false"`
}

// ExtractionFound is what the confirm dialog shows: the questions, what finding them
// cost, what the starter has left, and the answer files left out unread.
type ExtractionFound struct {
	Questions        []ExtractionFoundQuestion `json:"questions" nullable:"false"`
	ChargedCredits   int64                     `json:"chargedCredits"`
	AvailableCredits int64                     `json:"availableCredits"`
	UnreadAnswers    []string                  `json:"unreadAnswers" nullable:"false"`
	PaperName        string                    `json:"paperName"`
	PaperPages       int                       `json:"paperPages"`
	AnswerFiles      int                       `json:"answerFiles"`
}

// ExtractionReport is a finished run's completeness check, by printed
// question label: the labels the map listed (Expected), those never copied
// (Missing), those copied (Recorded), parts saved as copied with no answer because
// their solve call failed or the run stopped first (AnswersMissing, "4(a)"),
// questions saved with figures cropped from the page
// (Figures), for the starter to check, and questions saved without their
// figures (FiguresLeftOut): the box call for their page failed twice, or the
// figures did not fit in the starter's storage (Epo 2026-11-04). Stopped says why a run ended early:
// quiz_full, credits, or output_limit (its calls wrote past the run's output
// budget). Windows is its copy batches: the name predates them, and the Make a
// quiz screens' API keeps it.
type ExtractionReport struct {
	Expected       []string `json:"expected" nullable:"false"`
	Missing        []string `json:"missing" nullable:"false"`
	Recorded       []string `json:"recorded" nullable:"false"`
	AnswersMissing []string `json:"answersMissing,omitempty" nullable:"false"`
	Figures        []string `json:"figures" nullable:"false"`
	FiguresLeftOut []string `json:"figuresLeftOut" nullable:"false"`
	Stopped        string   `json:"stopped" enum:",quiz_full,credits,output_limit"`
	Pages          int      `json:"pages"`
	Windows        int      `json:"windows"`
}

const (
	ExtractionRunning    = "running"
	ExtractionConfirming = "confirming"
	ExtractionDone       = "done"
	ExtractionFailed     = "failed"
	ExtractionCancelled  = "cancelled"
)

// ExtractionQuestionMicros is the price of a saved question (Epo 2026-11-05).
const ExtractionQuestionMicros = fieldlimits.ExtractionQuestionCredits * MicrosPerCredit

// extractionRunTTL bounds a confirmed run's hold: the longest bench run took 16 minutes.
const extractionRunTTL = time.Hour

// KindExtractionQuestion is the usage row of a run's saved questions.
const KindExtractionQuestion = "extraction_question"

const extractionCols = `id, workspace_id, title, status, copied, answered, confirmed,
	found, COALESCE(found_credit_micros, 0), unread_answers, paper_name, paper_pages, answer_files,
	report, quiz_id, error_code, error, created_at, finished_at, COALESCE(spend_session_id, '')`

func scanExtraction(row pgx.Row) (Extraction, error) {
	var e Extraction
	var report, found, unread []byte
	var foundMicros int64
	var paperName string
	var paperPages, answerFiles int
	err := row.Scan(&e.ID, &e.WorkspaceID, &e.Title, &e.Status, &e.Recorded, &e.Answered, &e.Confirmed,
		&found, &foundMicros, &unread, &paperName, &paperPages, &answerFiles,
		&report, &e.QuizID, &e.ErrorCode, &e.Error, &e.CreatedAt, &e.FinishedAt, &e.SpendSessionID)
	if err != nil {
		return e, err
	}
	if len(report) > 0 {
		e.Report = &ExtractionReport{}
		if err := json.Unmarshal(report, e.Report); err != nil {
			return e, err
		}
	}
	if e.Status == ExtractionConfirming && len(found) > 0 {
		// A cost under one credit still shows as one.
		e.Found = &ExtractionFound{
			ChargedCredits: (foundMicros + MicrosPerCredit - 1) / MicrosPerCredit,
			PaperName:      paperName, PaperPages: paperPages, AnswerFiles: answerFiles,
		}
		if err := json.Unmarshal(found, &e.Found.Questions); err != nil {
			return e, err
		}
		if err := json.Unmarshal(unread, &e.Found.UnreadAnswers); err != nil {
			return e, err
		}
	}
	return e, nil
}

// ExtractionStart is a new run: the id the retrieval service was told, the session
// it spends on, and the answer files left out because they failed to read.
type ExtractionStart struct {
	ID             string
	WorkspaceID    string
	UserID         string
	Title          string
	SpendSessionID string
	UnreadAnswers  []string
	PaperName      string
	PaperPages     int
	AnswerFiles    int
}

// CreateExtraction records a run as running.
func (s *Store) CreateExtraction(ctx context.Context, run ExtractionStart) (Extraction, error) {
	unread, err := json.Marshal(append([]string{}, run.UnreadAnswers...))
	if err != nil {
		return Extraction{}, err
	}
	return scanExtraction(s.pool.QueryRow(ctx, `
		INSERT INTO question_extractions (id, workspace_id, user_id, title, spend_session_id, unread_answers,
			paper_name, paper_pages, answer_files)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING `+extractionCols, run.ID, run.WorkspaceID, run.UserID, run.Title, nullString(run.SpendSessionID), unread,
		run.PaperName, run.PaperPages, run.AnswerFiles))
}

// GetExtraction reads a run its starter may see; one waiting on them says what they
// have left to spend.
func (s *Store) GetExtraction(ctx context.Context, userID, id string) (Extraction, error) {
	e, err := scanExtraction(s.pool.QueryRow(ctx, `
		SELECT `+extractionCols+` FROM question_extractions WHERE id=$1 AND user_id=$2`, id, userID))
	if isNoRows(err) {
		return e, ErrNotFound
	}
	if err != nil || e.Found == nil {
		return e, err
	}
	usage, err := s.CreditBalance(ctx, userID)
	if err != nil {
		return e, err
	}
	e.Found.AvailableCredits = max(usage.AvailableMicros(), 0) / MicrosPerCredit
	return e, nil
}

// SaveExtractionQuestions keeps the questions copied so far on a running run,
// with no answers yet, as each copy batch ends.
func (s *Store) SaveExtractionQuestions(ctx context.Context, id string, questions json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `UPDATE question_extractions SET questions=$2
		WHERE id=$1 AND status='running'`, id, questions)
	return err
}

// SaveExtractionProgress keeps how far a running run has got, for its panel.
func (s *Store) SaveExtractionProgress(ctx context.Context, id string, copied, answered int) error {
	_, err := s.pool.Exec(ctx, `UPDATE question_extractions SET copied=$2, answered=$3
		WHERE id=$1 AND status='running'`, id, copied, answered)
	return err
}

// AwaitExtractionConfirm pauses a run on its starter with the map's questions and
// what the map call cost, which is all its session has spent so far.
func (s *Store) AwaitExtractionConfirm(ctx context.Context, id string, found json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `UPDATE question_extractions e SET status='confirming', found=$2,
		found_credit_micros=(SELECT COALESCE(sum(credit_micros), 0) FROM usage_events
			WHERE reservation_id = e.spend_session_id)
		WHERE id=$1 AND status='running'`, id, found)
	return err
}

// ConfirmExtraction sets a paused run going with the first questions questions. It
// holds their price and takes the session's token rates to zero: from here the calls
// are recorded and cost no credits, and the run pays per question saved (Epo
// 2026-11-05). A map that used the last credits marked the session exhausted, which a
// top-up since has answered, so the mark goes too. ErrConflict when the run isn't
// waiting, as when its wait ran out.
func (s *Store) ConfirmExtraction(ctx context.Context, userID, id string, questions int) (Extraction, error) {
	var out Extraction
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status, sessionID string
	var found int
	err = tx.QueryRow(ctx, `SELECT status, COALESCE(jsonb_array_length(found), 0), COALESCE(spend_session_id, '')
		FROM question_extractions WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID).Scan(&status, &found, &sessionID)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if status != ExtractionConfirming || questions < 1 || questions > found {
		return out, ErrConflict
	}
	usage, err := s.lockedCreditUsageTx(ctx, tx, userID)
	if err != nil {
		return out, err
	}
	hold := int64(questions) * ExtractionQuestionMicros
	if usage.AvailableMicros() < hold {
		return out, exhaustedError(usage)
	}
	session, err := tx.Exec(ctx, `UPDATE provider_sessions SET reserved_micros = reserved_micros + $2,
		llm_micros_per_input_token = 0, llm_micros_per_output_token = 0, llm_micros_per_cached_input_token = 0,
		credits_exhausted_at = NULL,
		expires_at = now() + ($3 * interval '1 millisecond')
		WHERE id = $1 AND status = 'open'`, sessionID, hold, extractionRunTTL.Milliseconds())
	if err != nil {
		return out, err
	}
	if session.RowsAffected() != 1 {
		return out, ErrConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE user_credits SET reserved_micros = reserved_micros + $2, updated_at = now()
		WHERE user_id = $1`, userID, hold); err != nil {
		return out, err
	}
	out, err = scanExtraction(tx.QueryRow(ctx, `UPDATE question_extractions SET status='running', confirmed=$2
		WHERE id=$1 RETURNING `+extractionCols, id, questions))
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

// CancelExtraction ends a paused run: the starter has paid for the map and nothing
// more. ErrConflict when the run isn't waiting.
func (s *Store) CancelExtraction(ctx context.Context, userID, id string) (Extraction, error) {
	e, err := scanExtraction(s.pool.QueryRow(ctx, `
		UPDATE question_extractions SET status='cancelled', finished_at=now()
		WHERE id=$1 AND user_id=$2 AND status='confirming'
		RETURNING `+extractionCols, id, userID))
	if !isNoRows(err) {
		return e, err
	}
	if _, err := s.GetExtraction(ctx, userID, id); err != nil {
		return e, err
	}
	return e, ErrConflict
}

// ChargeExtractionQuestions charges a finished run's saved questions, up to the number
// its starter confirmed. Keyed by the run, so a retry charges once.
func (s *Store) ChargeExtractionQuestions(ctx context.Context, run Extraction, userID string, saved int) error {
	if run.Confirmed == nil {
		return nil
	}
	questions := min(saved, *run.Confirmed)
	if questions <= 0 {
		return nil
	}
	return s.RecordUsage(ctx, UsageEvent{
		ActorUserID: userID, WorkspaceID: run.WorkspaceID, Kind: KindExtractionQuestion, Surface: SurfaceGenerate,
		Units: int64(questions), Unit: "question", CreditMicros: int64(questions) * ExtractionQuestionMicros,
		ReservationID: run.SpendSessionID, IdempotencyKey: "extraction:" + run.ID,
	})
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

// FailExtraction ends a run with an error, one still waiting on its starter too;
// report is nil when the run did not get as far as one.
func (s *Store) FailExtraction(ctx context.Context, id, code, message string, report json.RawMessage) (Extraction, error) {
	var stored []byte
	if len(report) > 0 {
		stored = report
	}
	e, err := scanExtraction(s.pool.QueryRow(ctx, `
		UPDATE question_extractions SET status='failed', error_code=$2, error=$3, report=$4, finished_at=now()
		WHERE id=$1 AND status IN ('running', 'confirming')
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
		WHERE status IN ('running', 'confirming')`)
	return err
}
