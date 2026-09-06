package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

func testRefreshRequest(t *testing.T, s *Store, owner, actor string) (Workspace, File, SourceSession, SourceProcessResult) {
	t.Helper()
	ctx := context.Background()
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	if actor != owner {
		if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'editor')`, ws.ID, actor); err != nil {
			t.Fatal(err)
		}
	}
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	doc := sourceTestEdit(t, s, actor, sourceTestSeed(t, s, owner, file.ID), "new-state")
	job, err := s.RequestSourceRefresh(ctx, actor, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	return ws, file, doc, job
}
func testRefreshFinalize(t *testing.T, s *Store, doc SourceSession, job SourceProcessResult) SourceRefreshCandidate {
	t.Helper()
	ctx := context.Background()
	candidate, err := s.ClaimSourceRefresh(ctx, doc.FileID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	err = s.FinalizeSourceRefresh(ctx, doc.FileID, SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-b", Seed: []byte("fresh-seed")})
	if err != nil {
		t.Fatal(err)
	}
	return candidate
}

func TestSourceExportAndPublicationRecheckRequestingActor(t *testing.T) {
	for _, stage := range []string{"claim", "finalize", "publish"} {
		t.Run(stage, func(t *testing.T) {
			s := openAccessTestStore(t)
			ctx := context.Background()
			owner := newBlobTestUser(t, s, "lifecycle_owner")
			actor := newBlobTestUser(t, s, "lifecycle_actor")
			ws, file, doc, job := testRefreshRequest(t, s, owner, actor)
			var candidate SourceRefreshCandidate
			var err error
			if stage != "claim" {
				candidate, err = s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
				if err != nil {
					t.Fatal(err)
				}
			}
			finalize := SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-b", Seed: []byte("fresh-seed")}
			publish := SourceRefreshPublish{}
			if stage == "publish" {
				if err = s.FinalizeSourceRefresh(ctx, file.ID, finalize); err != nil {
					t.Fatal(err)
				}
				if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, job.JobID); err != nil {
					t.Fatal(err)
				}
				content := uid("rc")
				if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'actor-b','ready')`, content, ws.ID); err != nil {
					t.Fatal(err)
				}
				if _, err = s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash='actor-b',preview_blob_path='previews/actor-b' WHERE file_id=$1`, file.ID, content); err != nil {
					t.Fatal(err)
				}
				publish = SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, job.JobID), JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-b", ContentID: content, ContentHash: "actor-b", PreviewBlobPath: "previews/actor-b", ExpectedLatestCheckpoint: doc.Checkpoint}
			}
			if err = s.SetWorkspaceMemberRole(ctx, owner, ws.ID, actor, RoleViewer); err != nil {
				t.Fatal(err)
			}
			switch stage {
			case "claim":
				_, err = s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
			case "finalize":
				err = s.FinalizeSourceRefresh(ctx, file.ID, finalize)
			case "publish":
				_, err = s.PublishSourceRefresh(ctx, file.ID, publish)
			}
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("demoted requester accepted at %s: %v", stage, err)
			}
			if stage == "claim" {
				retry, retryErr := s.RequestSourceRefresh(ctx, owner, file.ID, false)
				if retryErr != nil || retry.JobID == job.JobID {
					t.Fatalf("revoked claim stranded manual retry: %+v %v", retry, retryErr)
				}
			}
			if stage == "publish" {
				if err = s.SetWorkspaceMemberRole(ctx, owner, ws.ID, actor, RoleEditor); err != nil {
					t.Fatal(err)
				}
				if _, err = s.PublishSourceRefresh(ctx, file.ID, publish); err != nil {
					t.Fatal(err)
				}
				if err = s.SetWorkspaceMemberRole(ctx, owner, ws.ID, actor, RoleViewer); err != nil {
					t.Fatal(err)
				}
				if _, err = s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),suspended_reason='test' WHERE id=$1`, actor); err != nil {
					t.Fatal(err)
				}
				if replay, err := s.PublishSourceRefresh(ctx, file.ID, publish); err != nil || replay.BaseRevision != 2 {
					t.Fatalf("committed receipt rejected after actor change: %+v %v", replay, err)
				}
			}
		})
	}
}

func TestSourceLostFinalizeAcknowledgmentPreservesAcceptedWork(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "finalize_owner")
	_, file, doc, job := testRefreshRequest(t, s, owner, owner)
	candidate := testRefreshFinalize(t, s, doc, job)
	if err := s.FailSourceRefresh(ctx, file.ID, job.JobID, candidate.LeaseToken, "lost acknowledgment", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("exporter cancelled accepted work: %v", err)
	}
	var kind, status string
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT j.type,j.status,(SELECT count(*) FROM source_refresh_candidates WHERE file_id=$2) FROM jobs j WHERE j.id=$1`, job.JobID, file.ID).Scan(&kind, &status, &count); err != nil {
		t.Fatal(err)
	}
	if kind != "parse" || status != "pending" || count != 1 {
		t.Fatalf("accepted work changed: %s %s %d", kind, status, count)
	}
}

func TestSourceCaptionAdmissionAndDerivedTokens(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "caption_owner")
	reader := newBlobTestUser(t, s, "caption_reader")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'viewer')`, ws.ID, reader); err != nil {
		t.Fatal(err)
	}
	doc := sourceTestSeed(t, s, owner, file.ID)
	effects := json.RawMessage(`[{"id":"image-1","kind":"image","before":"abc","after":"汉😀"},{"id":"text-1","kind":"text","after":"かな"}]`)
	doc, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{ActorIDs: []string{owner}, Epoch: doc.Epoch, ExpectedCheckpoint: doc.Checkpoint, State: []byte("authored"), PendingEffects: effects, NetTokens: 5})
	if err != nil {
		t.Fatal(err)
	}
	var edited time.Time
	if err = s.pool.QueryRow(ctx, `SELECT last_edited_at FROM source_documents WHERE file_id=$1`, file.ID).Scan(&edited); err != nil {
		t.Fatal(err)
	}
	input := SourceCaption{WorkspaceID: ws.ID, UserID: reader, FileID: file.ID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, ChangeID: "image-1", Caption: "描述", ImageSHA256: strings.Repeat("a", 64)}
	if err = s.SaveSourceCaption(ctx, input); err != nil {
		t.Fatal(err)
	}
	var tokens, checkpoint int64
	var afterEdit time.Time
	var caption string
	if err = s.pool.QueryRow(ctx, `SELECT net_tokens,checkpoint,last_edited_at,pending_effects->0->>'caption' FROM source_documents WHERE file_id=$1`, file.ID).Scan(&tokens, &checkpoint, &afterEdit, &caption); err != nil {
		t.Fatal(err)
	}
	if tokens != 8 || checkpoint != doc.Checkpoint || !edited.Equal(afterEdit) || caption != "描述" {
		t.Fatalf("caption authored a checkpoint or changed token formula: %d %d %v %s", tokens, checkpoint, afterEdit, caption)
	}
	input.ImageSHA256 = strings.Repeat("b", 64)
	if err = s.SaveSourceCaption(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("mismatched image accepted: %v", err)
	}
	input.ImageSHA256 = strings.Repeat("a", 64)
	input.Checkpoint++
	if err = s.SaveSourceCaption(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale caption accepted: %v", err)
	}
	input.Checkpoint--
	input.ChangeID = "text-1"
	if err = s.SaveSourceCaption(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("caption attached to text effect: %v", err)
	}
	input.ChangeID = "image-1"
	if _, err = s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, reader); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveSourceCaption(ctx, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked reader persisted caption: %v", err)
	}
	input.UserID = owner
	usage, err := s.StorageUsage(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE user_storage SET used_bytes=$2 WHERE user_id=$1`, owner, usage.LimitBytes); err != nil {
		t.Fatal(err)
	}
	input.Caption = strings.Repeat("large caption", 1000)
	var quota *QuotaExceededError
	if err = s.SaveSourceCaption(ctx, input); !errors.As(err, &quota) {
		t.Fatalf("caption exceeded quota: %v", err)
	}
	if err = s.pool.QueryRow(ctx, `SELECT pending_effects->0->>'caption' FROM source_documents WHERE file_id=$1`, file.ID).Scan(&caption); err != nil || caption != "描述" {
		t.Fatalf("quota failure changed placeholder: %s %v", caption, err)
	}
}

func TestSourceAccountCancellationAllowsManualRetry(t *testing.T) {
	for _, cancelOwner := range []bool{false, true} {
		t.Run(map[bool]string{false: "requester", true: "owner"}[cancelOwner], func(t *testing.T) {
			s := openAccessTestStore(t)
			ctx := context.Background()
			owner := newBlobTestUser(t, s, "cancel_owner")
			actor := newBlobTestUser(t, s, "cancel_actor")
			_, file, _, job := testRefreshRequest(t, s, owner, actor)
			target := actor
			if cancelOwner {
				target = owner
			}
			if _, err := s.pool.Exec(ctx, `SELECT cancel_user_async_work($1)`, target); err != nil {
				t.Fatal(err)
			}
			var running *string
			var candidates int
			var state string
			if err := s.pool.QueryRow(ctx, `SELECT running_job_id,convert_from(state,'UTF8'),(SELECT count(*) FROM source_refresh_candidates WHERE file_id=$1) FROM source_documents WHERE file_id=$1`, file.ID).Scan(&running, &state, &candidates); err != nil {
				t.Fatal(err)
			}
			if running != nil || candidates != 0 || state != "new-state" {
				t.Fatalf("cancellation stranded state: %v %d %s", running, candidates, state)
			}
			retry, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
			if err != nil || retry.JobID == job.JobID {
				t.Fatalf("manual retry remained blocked: %+v %v", retry, err)
			}
		})
	}
}
