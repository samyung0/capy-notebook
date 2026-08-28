package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	ReconcileJobStorage = "storage"
	ReconcileJobStripe  = "stripe"

	ReconcileStatusSucceeded = "succeeded"
	ReconcileStatusPartial   = "partial"
	ReconcileStatusFailed    = "failed"
)

var ErrReconciliationLeaseLost = errors.New("reconciliation run lease lost")

type ReconcileRun struct {
	ID              int64
	JobType         string
	Trigger         string
	Status          string
	RequestedByID   string
	RequestedByName string
	RequestedAt     time.Time
	StartedAt       *time.Time
	LeaseToken      string
	AttemptCount    int
}

type ReconcileResult struct {
	Status        string
	ScannedCount  int64
	RepairedCount int64
	ErrorCount    int64
	Error         string
	Metadata      map[string]any
}

func validReconcileJob(jobType string) bool {
	return jobType == ReconcileJobStorage || jobType == ReconcileJobStripe
}

// EnqueueScheduledReconciliation creates at most one run for a job and UTC
// schedule slot. It may wait behind a running or manually queued run.
func (s *Store) EnqueueScheduledReconciliation(
	ctx context.Context,
	jobType string,
	scheduleSlot time.Time,
) (int64, bool, error) {
	if !validReconcileJob(jobType) {
		return 0, false, fmt.Errorf("unsupported reconciliation job %q", jobType)
	}
	scheduleSlot = scheduleSlot.UTC()
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO reconcile_runs (
		  job_type, trigger, status, schedule_slot
		)
		VALUES ($1, 'scheduled', 'pending', $2)
		ON CONFLICT DO NOTHING
		RETURNING id`, jobType, scheduleSlot).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return id, true, nil
}

// ClaimReconciliationRun leases the oldest pending run. Expired leases return
// to pending first; every reconciliation implementation is idempotent.
func (s *Store) ClaimReconciliationRun(
	ctx context.Context,
	leaseDuration time.Duration,
) (*ReconcileRun, error) {
	if leaseDuration <= 0 {
		return nil, errors.New("reconciliation lease duration must be positive")
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE reconcile_runs
		   SET status = 'pending',
		       lease_token = NULL,
		       lease_expires_at = NULL,
		       updated_at = now()
		 WHERE status = 'running' AND lease_expires_at <= now()`); err != nil {
		return nil, err
	}

	token := uid("rrl")
	var run ReconcileRun
	err := s.pool.QueryRow(ctx, `
		WITH candidate AS (
		  SELECT pending.id
		    FROM reconcile_runs pending
		   WHERE pending.status = 'pending'
		     AND NOT EXISTS (
		       SELECT 1 FROM reconcile_runs running
		        WHERE running.job_type = pending.job_type
		          AND running.status = 'running'
		     )
		   ORDER BY pending.requested_at, pending.id
		   FOR UPDATE SKIP LOCKED
		   LIMIT 1
		)
		UPDATE reconcile_runs r
		   SET status = 'running',
		       lease_token = $1,
		       lease_expires_at = now() + ($2 * interval '1 millisecond'),
		       started_at = COALESCE(r.started_at, now()),
		       attempt_count = r.attempt_count + 1,
		       updated_at = now()
		  FROM candidate c
		 WHERE r.id = c.id
		RETURNING r.id, r.job_type, r.trigger, r.status,
		          COALESCE(r.requested_by_id, ''), r.requested_by_name,
		          r.requested_at, r.started_at, r.lease_token, r.attempt_count`,
		token, leaseDuration.Milliseconds(),
	).Scan(
		&run.ID, &run.JobType, &run.Trigger, &run.Status,
		&run.RequestedByID, &run.RequestedByName,
		&run.RequestedAt, &run.StartedAt, &run.LeaseToken, &run.AttemptCount,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &run, nil
}

func assertReconciliationLeaseTx(
	ctx context.Context,
	tx pgx.Tx,
	run ReconcileRun,
) error {
	var valid bool
	err := tx.QueryRow(ctx, `
		SELECT true FROM reconcile_runs
		 WHERE id=$1 AND status='running' AND lease_token=$2
		   AND lease_expires_at > now()
		 FOR UPDATE`, run.ID, run.LeaseToken).Scan(&valid)
	if isNoRows(err) {
		return ErrReconciliationLeaseLost
	}
	if err != nil {
		return err
	}
	return nil
}

func (s *Store) RenewReconciliationLease(
	ctx context.Context,
	run ReconcileRun,
	leaseDuration time.Duration,
) error {
	if leaseDuration <= 0 {
		return errors.New("reconciliation lease duration must be positive")
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE reconcile_runs
		   SET lease_expires_at = now() + ($3 * interval '1 millisecond'),
		       updated_at = now()
		 WHERE id=$1 AND status='running' AND lease_token=$2
		   AND lease_expires_at > now()`,
		run.ID, run.LeaseToken, leaseDuration.Milliseconds())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrReconciliationLeaseLost
	}
	return nil
}

func (s *Store) FinishReconciliationRun(
	ctx context.Context,
	run ReconcileRun,
	result ReconcileResult,
) error {
	if result.Status != ReconcileStatusSucceeded &&
		result.Status != ReconcileStatusPartial &&
		result.Status != ReconcileStatusFailed {
		return fmt.Errorf("invalid reconciliation result status %q", result.Status)
	}
	if result.ScannedCount < 0 || result.RepairedCount < 0 || result.ErrorCount < 0 {
		return errors.New("reconciliation counts cannot be negative")
	}
	if result.Metadata == nil {
		result.Metadata = map[string]any{}
	}
	metadata, err := json.Marshal(result.Metadata)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE reconcile_runs
		   SET status = $3,
		       finished_at = now(),
		       lease_token = NULL,
		       lease_expires_at = NULL,
		       scanned_count = $4,
		       repaired_count = GREATEST($5, (
		         SELECT count(*) FROM reconciliation_report report
		          WHERE report.run_id = reconcile_runs.id
		            AND report.metadata->>'outcome' = 'repaired'
		       )),
		       error_count = GREATEST($6, (
		         SELECT count(*) FROM reconciliation_report report
		          WHERE report.run_id = reconcile_runs.id
		            AND report.metadata->>'outcome' = 'error'
		       )),
		       error = $7,
		       metadata = $8,
		       updated_at = now()
		 WHERE id = $1 AND status = 'running' AND lease_token = $2
		   AND lease_expires_at > now()`,
		run.ID, run.LeaseToken, result.Status,
		result.ScannedCount, result.RepairedCount, result.ErrorCount,
		result.Error, metadata,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrReconciliationLeaseLost
	}
	return nil
}

func insertReconciliationReportTx(
	ctx context.Context,
	tx pgx.Tx,
	run ReconcileRun,
	eventType, subjectType, subjectID, actorUserID string,
	metadata map[string]any,
) error {
	if err := assertReconciliationLeaseTx(ctx, tx, run); err != nil {
		return err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO reconciliation_report (
		  run_id, event_type, subject_type, subject_id, actor_user_id, metadata
		)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (run_id, event_type, subject_type, subject_id) DO NOTHING`,
		run.ID, eventType, subjectType, subjectID, nullString(actorUserID), metadata,
	)
	return err
}

func (s *Store) InsertReconciliationReport(
	ctx context.Context,
	run ReconcileRun,
	eventType, subjectType, subjectID, actorUserID string,
	metadata map[string]any,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := insertReconciliationReportTx(
		ctx, tx, run, eventType, subjectType, subjectID, actorUserID, metadata,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
