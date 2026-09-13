package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

func sourceTestFile(t *testing.T, s *Store, owner, name, kind string) (Workspace, File) {
	t.Helper()
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, owner, "Source workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(ctx, ws.ID, owner, name, kind, nil, "", 100, "sources/"+uid("base"))
	if err != nil {
		t.Fatal(err)
	}
	return ws, file
}
func sourceTestBaseline(format, text string) []byte {
	if format == "text" {
		encoded, _ := json.Marshal(text)
		return []byte(`{"version":1,"format":"text","text":` + string(encoded) + `}`)
	}
	return []byte(`{"version":1,"format":"` + format + `","entries":[]}`)
}
func sourceTestSeed(t *testing.T, s *Store, actor, file string) SourceSession {
	t.Helper()
	ctx := context.Background()
	doc, err := s.SourceSession(ctx, actor, file)
	if err != nil {
		t.Fatal(err)
	}
	doc, err = s.SaveSourceCheckpoint(ctx, file, SourceCheckpoint{ActorIDs: []string{actor}, Epoch: doc.Epoch, Initialize: true, IndexedBaseline: sourceTestBaseline(doc.Format, "A"), State: []byte("initial-state"), PendingEffects: json.RawMessage(`[]`), BaseSourceSHA256: strings.Repeat("a", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return doc
}
func sourceTestEdit(t *testing.T, s *Store, actor string, doc SourceSession, state string) SourceSession {
	t.Helper()
	out, err := s.SaveSourceCheckpoint(context.Background(), doc.FileID, SourceCheckpoint{ActorIDs: []string{actor}, Epoch: doc.Epoch, ExpectedCheckpoint: doc.Checkpoint, State: []byte(state), PendingEffects: json.RawMessage(`[{"type":"text","before":"old","after":"new"}]`), NetTokens: 6000})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestSourceCheckpointAuthorizationAndCreditIndependence(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_owner")
	viewer := newBlobTestUser(t, s, "source_viewer")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'viewer')`, ws.ID, viewer); err != nil {
		t.Fatal(err)
	}
	// A viewer opening first may initialize the trusted seed, but cannot author.
	doc := sourceTestSeed(t, s, viewer, file.ID)
	if len(doc.IndexedBaseline) == 0 || doc.Checkpoint != 0 {
		t.Fatalf("bad seed: %+v", doc)
	}
	if err := s.CheckSourceAccess(ctx, viewer, file.ID, doc.Epoch, false); err != nil {
		t.Fatalf("viewer cannot read source: %v", err)
	}
	if err := s.CheckSourceAccess(ctx, viewer, file.ID, doc.Epoch, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("viewer edit admission: %v", err)
	}
	if err := s.CheckSourceAccess(ctx, owner, file.ID, doc.Epoch+1, true); !errors.Is(err, ErrConflict) {
		t.Fatalf("wrong epoch admission: %v", err)
	}
	if err := s.CheckSourceAccess(ctx, owner, file.ID, doc.Epoch, true); err != nil {
		t.Fatalf("owner edit admission: %v", err)
	}
	req := SourceCheckpoint{ActorIDs: []string{viewer}, Epoch: doc.Epoch, ExpectedCheckpoint: 0, State: []byte("new"), PendingEffects: json.RawMessage(`[]`)}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, req); err == nil {
		t.Fatal("viewer authored checkpoint")
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits(user_id,used_micros) VALUES($1,999999999999999) ON CONFLICT(user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros`, owner); err != nil {
		t.Fatal(err)
	}
	doc = sourceTestEdit(t, s, owner, doc, "new-state")
	if doc.Checkpoint != 1 || doc.IndexedCheckpoint != 0 {
		t.Fatalf("bad checkpoint: %+v", doc)
	}
	req.ActorIDs = []string{owner}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, req); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale save: %v", err)
	}
	persisted, err := s.GetFile(ctx, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Revision != 1 || persisted.Status != FileReady {
		t.Fatalf("save changed published file: %+v", persisted)
	}
}

func TestSourceRefreshManualIsOwnerOnly(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_refresh_owner_only")
	editor := newBlobTestUser(t, s, "source_refresh_editor")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	addWorkspaceEditor(t, s, ws.ID, editor)
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "candidate-state")
	if _, err := s.RequestSourceRefresh(ctx, editor, file.ID, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor manual refresh error = %v, want forbidden", err)
	}
}

func TestSourceRefreshRebasesNewerSavedOfficeState(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_refresh_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "candidate-state")
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ClaimSourceRefresh(ctx, file.ID, job.JobID); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate export claim: %v", err)
	}
	baseline := sourceTestBaseline(doc.Format, "B")
	finalize := SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-b", Seed: []byte("fresh-seed"), Baseline: baseline}
	if err = s.FinalizeSourceRefresh(ctx, file.ID, finalize); err != nil {
		t.Fatal(err)
	}
	doc = sourceTestEdit(t, s, owner, doc, "newer-state")
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, job.JobID); err != nil {
		t.Fatal(err)
	}
	contentID := uid("rc")
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'hash-b','ready')`, contentID, ws.ID); err != nil {
		t.Fatal(err)
	}
	indexedImage, pendingImage := strings.Repeat("c", 64), strings.Repeat("d", 64)
	if _, err = s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash='hash-b',preview_blob_path='previews/b',image_sha256s=ARRAY[$3::text] WHERE file_id=$1`, file.ID, contentID, indexedImage); err != nil {
		t.Fatal(err)
	}
	for _, digest := range []string{indexedImage, pendingImage, strings.Repeat("e", 64)} {
		if _, err = s.pool.Exec(ctx, `INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes,published) VALUES($1,$2,$3,$4,10,false)`, uid("ica"), file.ID, digest, "caption/"+digest); err != nil {
			t.Fatal(err)
		}
	}
	residual := json.RawMessage(`[{"id":"image-new","kind":"image","operation":"add","imageSHA256":"` + pendingImage + `","after":"new image"}]`)
	publish := SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, job.JobID), JobID: job.JobID, Epoch: 1, Checkpoint: 1, LeaseToken: candidate.LeaseToken, SourceETag: "etag-b", ContentID: contentID, ContentHash: "hash-b", PreviewBlobPath: "previews/b", ExpectedLatestCheckpoint: doc.Checkpoint, IndexedBaseline: baseline, RebasedState: []byte("rebased-newer-state"), PendingEffects: residual, NetTokens: 3}
	// Another save wins while the native rebase is being calculated.
	doc = sourceTestEdit(t, s, owner, doc, "newest-state")
	if _, err = s.PublishSourceRefresh(ctx, file.ID, publish); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale rebase published: %v", err)
	}
	retained, err := s.SourceSession(ctx, owner, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if string(retained.State) != "newest-state" || retained.Checkpoint != doc.Checkpoint || retained.Epoch != 1 {
		t.Fatalf("stale rebase lost saved edits: %+v", retained)
	}
	old, err := s.GetFile(ctx, file.ID)
	if err != nil || old.Revision != 1 {
		t.Fatalf("stale result changed source: %+v %v", old, err)
	}
	// Retry only rebasing against the latest save; the same parsed candidate publishes.
	publish.ExpectedLatestCheckpoint = doc.Checkpoint
	publish.RebasedState = []byte("rebased-newest-state")
	published, err := s.PublishSourceRefresh(ctx, file.ID, publish)
	if err != nil {
		t.Fatal(err)
	}
	var normalizedResidual []byte
	if err = s.pool.QueryRow(ctx, `SELECT $1::jsonb`, residual).Scan(&normalizedResidual); err != nil {
		t.Fatal(err)
	}
	if published.Epoch != 2 || published.Checkpoint != doc.Checkpoint || published.IndexedCheckpoint != 1 || published.NetTokens != 3 || string(published.State) != "rebased-newest-state" || published.BaseRevision != 2 || string(published.IndexedBaseline) != string(baseline) || string(published.PendingEffects) != string(normalizedResidual) {
		t.Fatalf("bad base promotion: %+v", published)
	}
	var publishedCaptions, totalCaptions, candidates, receipt int
	if err = s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM image_caption_associations WHERE file_id=$1 AND published),(SELECT count(*) FROM image_caption_associations WHERE file_id=$1),(SELECT count(*) FROM source_refresh_candidates WHERE file_id=$1),(SELECT (payload->>'sourcePublishedCheckpoint')::int FROM jobs WHERE id=$2)`, file.ID, job.JobID).Scan(&publishedCaptions, &totalCaptions, &candidates, &receipt); err != nil {
		t.Fatal(err)
	}
	if publishedCaptions != 1 || totalCaptions != 2 || candidates != 0 || receipt != 1 {
		t.Fatalf("candidate/caption publication: %d %d %d %d", publishedCaptions, totalCaptions, candidates, receipt)
	}
	if repeat, err := s.PublishSourceRefresh(ctx, file.ID, publish); err != nil || repeat.BaseRevision != 2 {
		t.Fatalf("idempotent publication: %+v %v", repeat, err)
	}
	if _, err = s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{ActorIDs: []string{owner}, Epoch: 1, ExpectedCheckpoint: doc.Checkpoint, State: []byte("late"), PendingEffects: json.RawMessage(`[]`)}); !errors.Is(err, ErrConflict) {
		t.Fatalf("old epoch accepted: %v", err)
	}
}
func TestPDFAnnotationsArePrivateAndBoundToSource(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "pdf_owner")
	viewer := newBlobTestUser(t, s, "pdf_viewer")
	outsider := newBlobTestUser(t, s, "pdf_outsider")
	ws, file := sourceTestFile(t, s, owner, "lesson.pdf", "pdf")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'viewer')`, ws.ID, viewer); err != nil {
		t.Fatal(err)
	}
	body := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "highlight", Rects: []PDFRect{{X: 10, Y: 20, Width: 100, Height: 30}, {X: 10, Y: 60, Width: 80, Height: 30}}, Color: "#ffcc00"}
	row, err := s.SavePDFAnnotation(ctx, viewer, file.ID, "", body)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.ListPDFAnnotations(ctx, owner, file.ID)
	if err != nil || len(rows) != 0 {
		t.Fatalf("owner read viewer private marks: %v %+v", err, rows)
	}
	if err = s.DeletePDFAnnotation(ctx, owner, file.ID, row.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owner erased private mark: %v", err)
	}
	if _, err = s.ListPDFAnnotations(ctx, outsider, file.ID); err == nil {
		t.Fatal("private source disclosed")
	}
	body.Rects[0].Width = 1001
	if _, err = s.SavePDFAnnotation(ctx, viewer, file.ID, row.ID, body); !errors.Is(err, ErrConflict) {
		t.Fatalf("invalid geometry accepted: %v", err)
	}
	body.Rects[0].Width = 100
	body.SourceIdentity = "revision:2"
	if _, err = s.SavePDFAnnotation(ctx, viewer, file.ID, row.ID, body); !errors.Is(err, ErrConflict) {
		t.Fatalf("wrong source accepted: %v", err)
	}
	if err = s.DeletePDFAnnotation(ctx, viewer, file.ID, row.ID); err != nil {
		t.Fatal(err)
	}
}

func sourceTestAttempt(t *testing.T, s *Store, job string) int64 {
	t.Helper()
	var id int64
	err := s.pool.QueryRow(context.Background(), `INSERT INTO ingest_job_attempts(job_id,operation_id,attempt,job_type,environment,host_id,worker_instance_id,trace_id,queued_at,claimed_at) VALUES($1,$1,1,'ingest','test','test','test','test',now(),now()) RETURNING id`, job).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSourceTextPublishesCapturedStateWithExactRemainingEffects(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_text_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.txt", "txt")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "state-b")
	// Text admission is periodic even while the last edit is recent.
	if _, err = s.pool.Exec(ctx, `UPDATE source_documents SET last_refresh_requested_at=now()-interval '16 seconds' WHERE file_id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.FinalizeSourceRefresh(ctx, file.ID, SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-text", Baseline: sourceTestBaseline("text", "B")}); err != nil {
		t.Fatal(err)
	}
	latest := sourceTestEdit(t, s, owner, doc, "state-a-again")
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, job.JobID); err != nil {
		t.Fatal(err)
	}
	contentID := uid("rc")
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'text-b','ready')`, contentID, ws.ID); err != nil {
		t.Fatal(err)
	}
	residual := json.RawMessage(`[{"before":"B","after":"A"}]`)
	if _, err = s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash='text-b' WHERE file_id=$1`, file.ID, contentID); err != nil {
		t.Fatal(err)
	}
	published, err := s.PublishSourceRefresh(ctx, file.ID, SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, job.JobID), JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-text", ContentID: contentID, ContentHash: "text-b", IndexedBaseline: sourceTestBaseline("text", "B"), PendingEffects: residual, NetTokens: 2, ExpectedLatestCheckpoint: latest.Checkpoint})
	if err != nil {
		t.Fatal(err)
	}
	if published.Epoch != 1 || published.Checkpoint != 2 || published.IndexedCheckpoint != 1 || string(published.State) != "state-a-again" || string(published.IndexedBaseline) != string(sourceTestBaseline("text", "B")) || published.NetTokens != 2 {
		t.Fatalf("text residual or lineage lost: %+v", published)
	}
}

func TestSourceCloneCopiesPublishedSnapshotAndCaptionReferences(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_clone_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "unpublished-state")
	if _, err := s.pool.Exec(ctx, `INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes) VALUES($1,$2,$3,'captions/shared-caption',30)`, uid("ica"), file.ID, strings.Repeat("c", 64)); err != nil {
		t.Fatal(err)
	}
	clone, err := s.CloneWorkspace(ctx, owner, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	var clonedFile, clonedBlob string
	if err = s.pool.QueryRow(ctx, `SELECT id,blob_path FROM files WHERE workspace_id=$1`, clone.ID).Scan(&clonedFile, &clonedBlob); err != nil {
		t.Fatal(err)
	}
	var originalBlob string
	if err = s.pool.QueryRow(ctx, `SELECT blob_path FROM files WHERE id=$1`, file.ID).Scan(&originalBlob); err != nil {
		t.Fatal(err)
	}
	if clonedBlob != originalBlob {
		t.Fatal("clone did not use published bytes")
	}
	var docs, captions, refs int
	if err = s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM source_documents WHERE file_id=$1),(SELECT count(*) FROM image_caption_associations WHERE file_id=$1),(SELECT ref_count FROM blobs WHERE object_path='captions/shared-caption')`, clonedFile).Scan(&docs, &captions, &refs); err != nil {
		t.Fatal(err)
	}
	if docs != 0 || captions != 1 || refs != 2 {
		t.Fatalf("clone copied live history or lost captions: docs=%d captions=%d refs=%d", docs, captions, refs)
	}
	if err = trashAndPurgeFile(ctx, s, owner, file.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.pool.QueryRow(ctx, `SELECT ref_count FROM blobs WHERE object_path='captions/shared-caption'`).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("clone caption reclaimed: refs=%d err=%v", refs, err)
	}
}

func TestWorkspaceSourceIndexCountsAndSettings(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "index_counts_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	if !ws.AutoReparse || !ws.AutoReindex {
		t.Fatalf("auto settings not enabled: %+v", ws)
	}
	disabled := false
	updated, err := s.UpdateWorkspace(ctx, owner, ws.ID, WorkspacePatch{AutoReparse: &disabled, AutoReindex: &disabled})
	if err != nil {
		t.Fatal(err)
	}
	if updated.AutoReparse || updated.AutoReindex {
		t.Fatal("settings not saved")
	}
	for _, src := range []struct{ name, kind string }{{"not-indexed.txt", "txt"}, {"archive.zip", "unknown"}} {
		if _, err = s.CreateSourceReady(ctx, ws.ID, owner, src.name, src.kind, nil, "", 10, "sources/"+uid("count")); err != nil {
			t.Fatal(err)
		}
	}
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "below-threshold")
	if _, err = s.pool.Exec(ctx, `UPDATE source_documents SET net_tokens=1 WHERE file_id=$1`, doc.FileID); err != nil {
		t.Fatal(err)
	}
	contentID := uid("rc")
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'published','ready')`, contentID, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES($1,$2,$3)`, file.ID, ws.ID, contentID); err != nil {
		t.Fatal(err)
	}
	stats, err := s.WorkspaceStats(ctx, owner, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Indexed != 1 || stats.NotIndexed != 1 || stats.NotIndexable != 1 || stats.PendingReparse != 1 || stats.PendingReindex != 0 {
		t.Fatalf("wrong partition: %+v", stats)
	}
}

func TestSourceExportLeaseExhaustionPreservesEdits(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_export_owner")
	_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "pending-state")
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err = s.ClaimSourceRefresh(ctx, file.ID, job.JobID); err != nil {
			t.Fatal(err)
		}
		if _, err = s.pool.Exec(ctx, `UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, job.JobID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.ClaimSourceRefresh(ctx, file.ID, job.JobID); !errors.Is(err, ErrConflict) {
		t.Fatalf("exhausted claim: %v", err)
	}
	var status, state string
	var count int
	if err = s.pool.QueryRow(ctx, `SELECT j.status,convert_from(d.state,'UTF8'),(SELECT count(*) FROM source_refresh_candidates WHERE file_id=$1) FROM jobs j JOIN source_documents d ON d.file_id=$1 WHERE j.id=$2`, file.ID, job.JobID).Scan(&status, &state, &count); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || state != "pending-state" || count != 0 {
		t.Fatalf("exhausted export lost edits: %s %s %d", status, state, count)
	}
	if retry, err := s.RequestSourceRefresh(ctx, owner, doc.FileID, false); err != nil || retry.JobID == job.JobID {
		t.Fatalf("manual retry: %+v %v", retry, err)
	}
}

func TestSourceSeedQuotaChargesCompactBaseline(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_baseline_quota")
	_, file := sourceTestFile(t, s, owner, "lesson.pptx", "presentation")
	state := []byte(strings.Repeat("s", 4096))
	baseline := sourceTestBaseline("pptx", "")
	usage, err := s.StorageUsage(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	// Fill the account so exactly one state plus the compact baseline can fit.
	remaining := int64(len(state) + len(baseline) + 2)
	if _, err = s.pool.Exec(ctx, `UPDATE files SET size_bytes=$2 WHERE id=$1`, file.ID, usage.LimitBytes-remaining); err != nil {
		t.Fatal(err)
	}
	session, err := s.SourceSession(ctx, owner, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: session.Epoch, Initialize: true,
		State: state, IndexedBaseline: baseline, PendingEffects: json.RawMessage(`[]`), BaseSourceSHA256: strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatalf("compact baseline should fit exact quota: %v", err)
	}
	usage, err = s.StorageUsage(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if usage.UsedBytes != usage.LimitBytes || string(saved.IndexedBaseline) != string(baseline) {
		t.Fatalf("wrong baseline charge: %+v baseline=%q", usage, saved.IndexedBaseline)
	}
}
