package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// legacyTestUpload finalizes owner's upload of a legacy Office file into a
// new workspace and returns the file.
func legacyTestUpload(t *testing.T, s *Store, owner, name, kind, mode string) File {
	t.Helper()
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Legacy", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	upload, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: owner,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: name, Kind: kind, ContentType: "application/octet-stream",
		DeclaredSize: 100, ParseMode: mode, ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.FinalizeUploadSession(ctx, owner, upload.ID, "etag", strings.Repeat("a", 64), "test")
	if err != nil {
		t.Fatal(err)
	}
	return file
}

// A legacy Office upload stays pending behind a parse-type conversion job in
// either parse mode: the job carries the conversion plan and the uploader's
// Office picture cap, on the ordinary ingest reservation with parsing on and
// on a system session (no ingest lease) with parsing off (Epo 2026-11-11).
func TestFinalizeQueuesTheLegacyConversion(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for _, tc := range []struct {
		mode          string
		system        bool
		wantSlotsUsed int
	}{
		{mode: "fast", wantSlotsUsed: 1},
		{mode: "none", system: true},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			owner := newBlobTestUser(t, s, "legacy_finalize")
			file := legacyTestUpload(t, s, owner, "old report.doc", "doc", tc.mode)
			if file.Status != FilePending {
				t.Fatalf("file status = %q, want pending", file.Status)
			}
			var jobType, route, convertTo, payloadPaidBy, sessionPaidBy string
			var imageMaxBytes int64
			if err := s.pool.QueryRow(ctx, `SELECT j.type, j.payload->'processingPlan'->>'route',
					j.payload->'processingPlan'->>'convertTo', (j.payload->>'imageMaxBytes')::bigint,
					COALESCE(j.payload->>'paidBy',''), ps.paid_by
				FROM jobs j JOIN provider_sessions ps ON ps.id=j.payload->>'reservationId'
				WHERE j.payload->>'fileId'=$1 AND j.status='pending'`, file.ID).
				Scan(&jobType, &route, &convertTo, &imageMaxBytes, &payloadPaidBy, &sessionPaidBy); err != nil {
				t.Fatal(err)
			}
			limits, err := s.PayerPlanLimits(ctx, owner)
			if err != nil {
				t.Fatal(err)
			}
			if jobType != "parse" || route != "legacy_convert" || convertTo != "docx" || imageMaxBytes != limits.ImageBytes {
				t.Fatalf("job: type %q route %q convertTo %q imageMaxBytes %d", jobType, route, convertTo, imageMaxBytes)
			}
			if (sessionPaidBy == models.PaidBySystem) != tc.system || (payloadPaidBy == models.PaidBySystem) != tc.system {
				t.Fatalf("paid by: session %q payload %q, system %t", sessionPaidBy, payloadPaidBy, tc.system)
			}
			slots, err := s.IngestSlots(ctx, owner)
			if err != nil || slots.SlotsUsed != tc.wantSlotsUsed {
				t.Fatalf("ingest slots used = %d (%v), want %d", slots.SlotsUsed, err, tc.wantSlotsUsed)
			}
		})
	}
}

// Retry processing of a legacy file whose conversion failed converts it
// again in its stored parse mode, not the mode asked: on the owner's
// reservation with parsing on, on a system session with parsing off.
func TestRetryConvertsAFailedLegacyFile(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for stored, asked := range map[string]string{"fast": "none", "none": "fast"} {
		t.Run(stored, func(t *testing.T) {
			owner := newBlobTestUser(t, s, "legacy_retry")
			file := legacyTestUpload(t, s, owner, "old deck.ppt", "slides", stored)
			if _, err := s.pool.Exec(ctx, `UPDATE jobs SET status='failed' WHERE payload->>'fileId'=$1`, file.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `UPDATE files SET status='failed' WHERE id=$1`, file.ID); err != nil {
				t.Fatal(err)
			}
			if err := s.RetryFileProcessing(ctx, owner, file.ID, asked, "test"); err != nil {
				t.Fatal(err)
			}
			assertLegacyConversionQueued(t, s, file.ID, stored)
		})
	}
}

// assertLegacyConversionQueued checks a Retry left the file pending in mode
// behind the conversion job a fresh upload gets: the picture cap, and a
// system session exactly when nothing parses afterwards.
func assertLegacyConversionQueued(t *testing.T, s *Store, fileID, mode string) {
	t.Helper()
	system := mode == "none"
	var status, stored, jobType, route, payloadPaidBy, sessionPaidBy string
	var hasCap bool
	if err := s.pool.QueryRow(context.Background(), `SELECT f.status, f.parse_mode, j.type, j.payload->'processingPlan'->>'route',
			j.payload ? 'imageMaxBytes', COALESCE(j.payload->>'paidBy',''), ps.paid_by
		FROM files f JOIN jobs j ON j.payload->>'fileId'=f.id AND j.status='pending'
		JOIN provider_sessions ps ON ps.id=j.payload->>'reservationId' WHERE f.id=$1`, fileID).
		Scan(&status, &stored, &jobType, &route, &hasCap, &payloadPaidBy, &sessionPaidBy); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || stored != mode || jobType != "parse" || route != "legacy_convert" || !hasCap ||
		(payloadPaidBy == models.PaidBySystem) != system || (sessionPaidBy == models.PaidBySystem) != system {
		t.Fatalf("after retry: status %q mode %q job %q route %q cap %t paid by %q/%q",
			status, stored, jobType, route, hasCap, payloadPaidBy, sessionPaidBy)
	}
}

// Retry converts a ready legacy file that was stored as uploaded (Convert to
// new Office format): its stored parse mode decides, not the mode asked.
func TestRetryConvertsAReadyLegacyFile(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for stored, asked := range map[string]string{"fast": "none", "none": "fast"} {
		t.Run(stored, func(t *testing.T) {
			owner := newBlobTestUser(t, s, "legacy_convert_ready")
			file := legacyTestUpload(t, s, owner, "old report.doc", "doc", stored)
			if _, err := s.pool.Exec(ctx, `DELETE FROM jobs WHERE payload->>'fileId'=$1`, file.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `UPDATE files SET status='ready' WHERE id=$1`, file.ID); err != nil {
				t.Fatal(err)
			}
			if err := s.RetryFileProcessing(ctx, owner, file.ID, asked, "test"); err != nil {
				t.Fatal(err)
			}
			assertLegacyConversionQueued(t, s, file.ID, stored)
		})
	}
}

// A hand-in's legacy file is stored as handed in, and a paper's the uploader
// has no credits for is kept ready: neither is converted at finalize. Retry
// then converts the paper's once its member has credits, never the hand-in's.
func TestSubmissionLegacyFilesStayUnconverted(t *testing.T) {
	f := newAssignmentFixture(t, "legacy-submission")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros, reserved_micros, purchased_micros, period_start)
		VALUES ($1, $2, 0, 0, date_trunc('month', timezone('utc', now()))::date)
		ON CONFLICT (user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros, reserved_micros=0, purchased_micros=0,
			period_start=EXCLUDED.period_start`, f.viewer, mustPlanLimits(t, f.s, PlanFree).CreditMicros); err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for name, in := range map[string]NewUploadSession{
		"hand-in": {HandInID: unmarkedHandIn(t, f, now).ID, ParseMode: "none"},
		"paper":   {AttemptID: startPaper(t, f, now, nil).attemptID, ParseMode: "fast"},
	} {
		in.ID, in.CreatedBy = uid("up"), f.viewer
		in.ObjectPath, in.FinalPath = "sources/"+uid("blob"), "sources/"+uid("blob")
		in.Name, in.Kind, in.ContentType = "answers.doc", "doc", "application/msword"
		in.DeclaredSize, in.PaperMaxBytes, in.ExpiresAt = 2048, 10<<20, now.Add(time.Hour)
		upload, err := f.s.CreateUploadSession(ctx, in)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		file, err := f.s.FinalizeUploadSession(ctx, f.viewer, upload.ID, "etag", "", "")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var jobs int
		if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE payload->>'fileId'=$1`, file.ID).Scan(&jobs); err != nil {
			t.Fatal(err)
		}
		if file.Status != FileReady || file.Name != "answers.doc" || jobs != 0 {
			t.Fatalf("%s: status %q name %q jobs %d", name, file.Status, file.Name, jobs)
		}
		ids[name] = file.ID
	}
	if err := f.s.RetryFileProcessing(ctx, f.viewer, ids["hand-in"], "none", "test"); !errors.Is(err, ErrConflict) {
		t.Fatalf("retry of a hand-in: %v, want conflict", err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE user_credits SET used_micros=0 WHERE user_id=$1`, f.viewer); err != nil {
		t.Fatal(err)
	}
	reg, err := models.New(ctx, f.s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	f.s.SetModelRegistry(reg)
	if err := f.s.RetryFileProcessing(ctx, f.viewer, ids["paper"], "fast", "test"); err != nil {
		t.Fatal(err)
	}
	assertLegacyConversionQueued(t, f.s, ids["paper"], "fast")
}

// The converted file's name swaps the ending and stays within 120 characters.
func TestLegacyConvertedName(t *testing.T) {
	long := strings.Repeat("é", 116)
	for name, want := range map[string]string{
		"report.doc":  "report.docx",
		"Budget.XLS":  "Budget.xlsx",
		"v1.2 .ppt":   "v1.2 .pptx",
		long + ".doc": strings.Repeat("é", 115) + ".docx",
	} {
		got := legacyConvertedName(name, strings.ToLower(name[len(name)-3:])+"x")
		if got != want || utf8.RuneCountInString(got) > 120 {
			t.Errorf("legacyConvertedName(%q) = %q, want %q", name, got, want)
		}
	}
}
