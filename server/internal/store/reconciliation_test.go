package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func clearReconciliationTables(t *testing.T, s *Store) {
	t.Helper()
	clear := func() error {
		_, err := s.pool.Exec(context.Background(), `
			DELETE FROM reconciliation_report;
			DELETE FROM reconcile_runs`)
		return err
	}
	if err := clear(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := clear(); err != nil {
			t.Error(err)
		}
	})
}

func TestReconciliationRunEnqueueClaimAndFinish(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	clearReconciliationTables(t, s)

	slot := time.Date(2040, 1, 2, 0, 0, 0, 0, time.UTC)
	id, created, err := s.EnqueueScheduledReconciliation(
		ctx, ReconcileJobStorage, slot,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !created || id == 0 {
		t.Fatalf("enqueue returned id=%d created=%v", id, created)
	}
	if _, created, err := s.EnqueueScheduledReconciliation(
		ctx, ReconcileJobStorage, slot,
	); err != nil || created {
		t.Fatalf("duplicate enqueue created=%v err=%v", created, err)
	}

	run, err := s.ClaimReconciliationRun(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if run == nil || run.ID != id || run.Status != "running" ||
		run.LeaseToken == "" || run.AttemptCount != 1 {
		t.Fatalf("claimed run = %#v", run)
	}
	if next, err := s.ClaimReconciliationRun(ctx, time.Minute); err != nil || next != nil {
		t.Fatalf("second claim = %#v, err=%v", next, err)
	}
	if err := s.FinishReconciliationRun(ctx, *run, ReconcileResult{
		Status:        ReconcileStatusSucceeded,
		ScannedCount:  12,
		RepairedCount: 3,
	}); err != nil {
		t.Fatal(err)
	}

	var status string
	var scanned, repaired int64
	if err := s.pool.QueryRow(ctx, `
		SELECT status, scanned_count, repaired_count
		  FROM reconcile_runs WHERE id = $1`, id).
		Scan(&status, &scanned, &repaired); err != nil {
		t.Fatal(err)
	}
	if status != ReconcileStatusSucceeded || scanned != 12 || repaired != 3 {
		t.Fatalf(
			"finished status=%s scanned=%d repaired=%d",
			status, scanned, repaired,
		)
	}
}

func TestExpiredReconciliationLeaseFencesOldWorker(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	clearReconciliationTables(t, s)
	slot := time.Date(2040, 1, 4, 0, 0, 0, 0, time.UTC)
	if _, _, err := s.EnqueueScheduledReconciliation(
		ctx, ReconcileJobStorage, slot,
	); err != nil {
		t.Fatal(err)
	}
	oldRun, err := s.ClaimReconciliationRun(ctx, time.Minute)
	if err != nil || oldRun == nil {
		t.Fatalf("old claim=%#v err=%v", oldRun, err)
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE reconcile_runs SET lease_expires_at=now() - interval '1 second'
		 WHERE id=$1`, oldRun.ID); err != nil {
		t.Fatal(err)
	}
	newRun, err := s.ClaimReconciliationRun(ctx, time.Minute)
	if err != nil || newRun == nil {
		t.Fatalf("replacement claim=%#v err=%v", newRun, err)
	}
	if newRun.ID != oldRun.ID || newRun.LeaseToken == oldRun.LeaseToken ||
		newRun.AttemptCount != 2 {
		t.Fatalf("replacement run=%#v old=%#v", newRun, oldRun)
	}
	if err := s.InsertReconciliationReport(
		ctx,
		*oldRun,
		"storage_counter_drift",
		"user",
		"stale-worker",
		"",
		nil,
	); !errors.Is(err, ErrReconciliationLeaseLost) {
		t.Fatalf("stale report error=%v", err)
	}
	if err := s.FinishReconciliationRun(ctx, *oldRun, ReconcileResult{
		Status: ReconcileStatusSucceeded,
	}); !errors.Is(err, ErrReconciliationLeaseLost) {
		t.Fatalf("stale finish error=%v", err)
	}
	if err := s.RenewReconciliationLease(
		ctx, *newRun, time.Minute,
	); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertReconciliationReport(
		ctx,
		*newRun,
		"storage_counter_drift",
		"user",
		"repaired-user",
		"",
		map[string]any{"outcome": "repaired"},
	); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishReconciliationRun(ctx, *newRun, ReconcileResult{
		Status: ReconcileStatusSucceeded,
	}); err != nil {
		t.Fatal(err)
	}
	var repaired int64
	if err := s.pool.QueryRow(ctx, `
		SELECT repaired_count FROM reconcile_runs WHERE id=$1`, newRun.ID).
		Scan(&repaired); err != nil {
		t.Fatal(err)
	}
	if repaired != 1 {
		t.Fatalf("repaired count=%d, want report-derived 1", repaired)
	}
}

func TestReconcileStorageReportsOnlyActualDrift(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	clearReconciliationTables(t, s)
	userID := newCreditsTestUser(t, s)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO user_storage (user_id, used_bytes, reserved_bytes)
		VALUES ($1, 123, 456)
		ON CONFLICT (user_id) DO UPDATE
		  SET used_bytes = 123, reserved_bytes = 456`, userID); err != nil {
		t.Fatal(err)
	}

	slot := time.Date(2040, 1, 3, 0, 0, 0, 0, time.UTC)
	_, _, err := s.EnqueueScheduledReconciliation(
		ctx, ReconcileJobStorage, slot,
	)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.ClaimReconciliationRun(ctx, time.Minute)
	if err != nil || run == nil {
		t.Fatalf("claim run=%#v err=%v", run, err)
	}
	scanned, repaired, errorCount, err := s.ReconcileStorage(ctx, *run)
	if err != nil {
		t.Fatal(err)
	}
	if errorCount != 0 {
		t.Fatalf("error count=%d", errorCount)
	}
	if scanned == 0 || repaired == 0 {
		t.Fatalf("scanned=%d repaired=%d", scanned, repaired)
	}
	var used, reserved int64
	if err := s.pool.QueryRow(ctx, `
		SELECT used_bytes, reserved_bytes FROM user_storage WHERE user_id=$1`,
		userID,
	).Scan(&used, &reserved); err != nil {
		t.Fatal(err)
	}
	if used != 0 || reserved != 0 {
		t.Fatalf("repaired storage used=%d reserved=%d", used, reserved)
	}
	var reports int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM reconciliation_report
		 WHERE run_id=$1 AND event_type='storage_counter_drift'
		   AND subject_id=$2`, run.ID, userID).Scan(&reports); err != nil {
		t.Fatal(err)
	}
	if reports != 1 {
		t.Fatalf("storage drift reports=%d", reports)
	}
}
