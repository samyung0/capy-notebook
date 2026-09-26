package store

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

func maintenanceTestStore(t *testing.T) *Store {
	t.Helper()
	s := openAccessTestStore(t)
	reg, err := models.New(context.Background(), s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	return s
}

// maintenanceTestEdited is an Office file with unpublished edits, parsed
// before unless storeOnly.
func maintenanceTestEdited(t *testing.T, s *Store, owner, name string, storeOnly bool) string {
	t.Helper()
	_, file := sourceTestFile(t, s, owner, name, "doc")
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "edited-state")
	if _, err := s.pool.Exec(context.Background(), `UPDATE files SET ever_parsed_successfully=$2,parse_mode=CASE WHEN $2 THEN 'fast' ELSE 'none' END WHERE id=$1`, file.ID, !storeOnly); err != nil {
		t.Fatal(err)
	}
	return file.ID
}

// maintenanceTestPause turns the pause on until the test ends.
func maintenanceTestPause(t *testing.T, s *Store) {
	t.Helper()
	if err := s.SetOfficeEditingPaused(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.SetOfficeEditingPaused(context.Background(), false) })
}

func TestOfficeEditingPause(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "office_pause")
	_, open := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	doc := sourceTestSeed(t, s, owner, open.ID) // a room opened before the pause
	_, text := sourceTestFile(t, s, owner, "notes.txt", "txt")
	if err := s.SetOfficeEditingPaused(ctx, true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.SetOfficeEditingPaused(context.Background(), false) })

	// Edit sessions (source-session, collaboration token) refuse Office files.
	if err := s.AssertOfficeEditable(ctx, open.ID); !errors.Is(err, ErrOfficeEditingPaused) {
		t.Fatalf("Office edit session: %v", err)
	}
	if err := s.AssertOfficeEditable(ctx, text.ID); err != nil {
		t.Fatalf("text edit session: %v", err)
	}
	// The open room's flush still saves, its first save included.
	sourceTestEdit(t, s, owner, doc, "flushed-state")
	// An agent edit that passed the gateway's check just before the pause is
	// refused where it commits.
	_, err := s.SaveSourceCheckpoint(ctx, open.ID, SourceCheckpoint{ActorIDs: []string{owner}, Epoch: doc.Epoch, ExpectedCheckpoint: doc.Checkpoint + 1, State: []byte("agent-state"), PendingEffects: json.RawMessage(`[]`), Operation: &SourceCheckpointOperation{Receipt: SourceCheckpointReceipt{ID: uid("op"), RequestHash: "hash", ActorUserID: owner, ToolVersion: 1}, Inverse: json.RawMessage(`{"commands":[]}`)}})
	if !errors.Is(err, ErrOfficeEditingPaused) {
		t.Fatalf("agent edit commit during the pause: %v", err)
	}
	// Agent edits and their Undo refuse with the tool code, before the authority.
	var refusal *EditRefusal
	_, err = s.EditDocument(ctx, owner, DocumentTarget{Kind: agenttools.KindSourceFile, ID: open.ID}, nil, nil, DocumentOperation{ID: "op"})
	if !errors.As(err, &refusal) || refusal.Code != agenttools.ErrOfficeEditingPaused {
		t.Fatalf("agent edit: %v", err)
	}
	_, err = s.UndoDocumentEdit(ctx, owner, EditInverse{ResourceKind: agenttools.KindSourceFile, ResourceID: open.ID, Inverse: json.RawMessage(`{"commands":[{}]}`)}, DocumentOperation{ID: "undo"})
	if !errors.As(err, &refusal) || refusal.Code != agenttools.ErrOfficeEditingPaused {
		t.Fatalf("agent undo: %v", err)
	}
	if err = s.SetOfficeEditingPaused(ctx, false); err != nil {
		t.Fatal(err)
	}
	if err = s.AssertOfficeEditable(ctx, open.ID); err != nil {
		t.Fatalf("after resume: %v", err)
	}
}

func TestPublishAllOfficeSourcesRoutesSpecialGroupsExportOnly(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "publish_all_owner")
	suspended := newBlobTestUser(t, s, "publish_all_suspended")
	republish := maintenanceTestEdited(t, s, owner, "a.docx", false)
	storeOnly := maintenanceTestEdited(t, s, owner, "b.docx", true)
	trashed := maintenanceTestEdited(t, s, owner, "c.docx", false)
	failed := maintenanceTestEdited(t, s, owner, "d.docx", false)
	locked := maintenanceTestEdited(t, s, suspended, "e.docx", false)
	running := maintenanceTestEdited(t, s, owner, "f.docx", false)
	// A failed first parse: never parsed successfully, so no first parse here.
	unparsed := maintenanceTestEdited(t, s, owner, "g.docx", false)
	_, textFile := sourceTestFile(t, s, owner, "notes.txt", "txt")
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, textFile.ID), "text-edit")
	for _, step := range []struct {
		q   string
		arg string
	}{
		// Blocked owners publish at platform cost: out of credits here.
		{`INSERT INTO user_credits(user_id,used_micros) VALUES($1,999999999999999) ON CONFLICT(user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros`, owner},
		{`UPDATE users SET suspended_at=now(),suspended_reason='test' WHERE id=$1`, suspended},
		{`UPDATE files SET trashed_at=now(),trash_episode_id='episode',purge_after=now()+interval '30 days' WHERE id=$1`, trashed},
		// This checkpoint's system republish already failed for good.
		{`INSERT INTO jobs(id,type,status,payload) SELECT 'failed_'||file_id,'parse','failed',jsonb_build_object('fileId',file_id,'sourceRefresh',true,'paidBy','system','sourceCheckpoint',checkpoint) FROM source_documents WHERE file_id=$1`, failed},
		{`INSERT INTO jobs(id,type) VALUES('running_'||$1,'source_refresh')`, running},
		{`UPDATE source_documents SET running_job_id='running_'||$1,refresh_error='stale' WHERE file_id=$1`, running},
		{`UPDATE source_documents SET refresh_error='owner out of credits' WHERE file_id=$1`, republish},
		{`UPDATE files SET ever_parsed_successfully=false,status='failed' WHERE id=$1`, unparsed},
	} {
		if _, err := s.pool.Exec(ctx, step.q, step.arg); err != nil {
			t.Fatal(err)
		}
	}
	// Its export-only publications evict rooms unflushed: the pause comes first.
	if _, err := s.PublishAllOfficeSources(ctx); !errors.Is(err, ErrOfficeEditingNotPaused) {
		t.Fatalf("publish-all without the pause: %v", err)
	}
	maintenanceTestPause(t, s)

	published, err := s.PublishAllOfficeSources(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]OfficePublication{}
	for _, p := range published {
		got[p.FileID] = p
	}
	for file, exportOnly := range map[string]bool{republish: false, storeOnly: true, unparsed: true, trashed: true, failed: true, locked: true} {
		p, ok := got[file]
		if !ok || p.Err != nil || p.ExportOnly != exportOnly || p.JobID == "" {
			t.Fatalf("%s: %+v (listed %v), want exportOnly=%v", file, p, ok, exportOnly)
		}
		var paidBy, reservation, refreshError string
		var jobExportOnly bool
		if err = s.pool.QueryRow(ctx, `SELECT j.payload->>'paidBy',j.payload->>'reservationId',(j.payload->>'exportOnly')::boolean,COALESCE(d.refresh_error,'') FROM jobs j JOIN source_documents d ON d.running_job_id=j.id WHERE j.id=$1`, p.JobID).Scan(&paidBy, &reservation, &jobExportOnly, &refreshError); err != nil {
			t.Fatal(err)
		}
		if paidBy != models.PaidBySystem || jobExportOnly != exportOnly || (reservation == "") != exportOnly || refreshError != "" {
			t.Fatalf("%s job: paidBy=%s reservation=%q exportOnly=%v refresh_error=%q", file, paidBy, reservation, jobExportOnly, refreshError)
		}
	}
	for _, file := range []string{running, textFile.ID} {
		if _, ok := got[file]; ok {
			t.Fatalf("%s should wait (running) or stay out (text)", file)
		}
	}
}

func TestExportOnlyPublication(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "export_only_owner")
	file := maintenanceTestEdited(t, s, owner, "lesson.docx", false)
	// An indexed file, then trashed, of an owner then suspended: the window
	// still exports it.
	for _, q := range []string{
		`INSERT INTO rag_contents(id,workspace_id,content_hash,status) SELECT 'rc_'||id,workspace_id,'hash-a','ready' FROM files WHERE id=$1`,
		`INSERT INTO rag_file_contents(file_id,workspace_id,content_id) SELECT id,workspace_id,'rc_'||id FROM files WHERE id=$1`,
		`INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes,published) VALUES('ica_'||$1,$1,repeat('c',64),'caption/c',10,true)`,
		`UPDATE files SET indexed=true,content_hash='hash-a' WHERE id=$1`,
		`UPDATE files SET trashed_at=now(),trash_episode_id='episode',purge_after=now()+interval '30 days' WHERE id=$1`,
		`UPDATE users SET suspended_at=now(),suspended_reason='test' WHERE id=(SELECT user_id FROM files WHERE id=$1)`,
	} {
		if _, err := s.pool.Exec(ctx, q, file); err != nil {
			t.Fatal(err)
		}
	}
	job, err := s.requestSourceRefresh(ctx, owner, file, false, models.PaidBySystem, true)
	if err != nil {
		t.Fatal(err)
	}
	evictions := func() (n int) {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM collaboration_eviction_outbox WHERE payload->>'room'='source:'||$1||':epoch:1'`, file).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	evictedBefore := evictions()
	candidate, err := s.ClaimSourceRefresh(ctx, file, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	finalize := SourceRefreshFinalize{JobID: job.JobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-b", SeedBytes: int64(len("fresh-seed"))}
	if err = s.FinalizeSourceRefresh(ctx, file, finalize); err != nil {
		t.Fatal(err)
	}

	var blobPath, sha string
	var size, revision int64
	var indexed, hasHash bool
	if err = s.pool.QueryRow(ctx, `SELECT blob_path,source_sha256,size_bytes,revision,indexed,content_hash IS NOT NULL FROM files WHERE id=$1`, file).Scan(&blobPath, &sha, &size, &revision, &indexed, &hasHash); err != nil {
		t.Fatal(err)
	}
	if blobPath != candidate.SourceBlobPath || sha != finalize.SourceSHA256 || size != 120 || revision != 2 || indexed || hasHash {
		t.Fatalf("file row: %s %s %d %d indexed=%v hash=%v", blobPath, sha, size, revision, indexed, hasHash)
	}
	// The state is seed(export) again: NULL, with a derived baseline.
	var epoch, checkpoint, indexedCheckpoint, netTokens, seedBytes int64
	var state, storedBaseline []byte
	var effects string
	var marked, running bool
	if err = s.pool.QueryRow(ctx, `SELECT epoch,checkpoint,indexed_checkpoint,net_tokens,seed_bytes,state,indexed_baseline,pending_effects::text,reprocess_at IS NOT NULL,running_job_id IS NOT NULL FROM source_documents WHERE file_id=$1`, file).Scan(&epoch, &checkpoint, &indexedCheckpoint, &netTokens, &seedBytes, &state, &storedBaseline, &effects, &marked, &running); err != nil {
		t.Fatal(err)
	}
	if epoch != 2 || indexedCheckpoint != checkpoint || netTokens != 0 || seedBytes != 0 || state != nil || storedBaseline != nil || effects != "[]" || !marked || running {
		t.Fatalf("source row: epoch=%d checkpoint=%d/%d tokens=%d state=%q effects=%s marked=%v running=%v", epoch, checkpoint, indexedCheckpoint, netTokens, state, effects, marked, running)
	}
	var aliases, captions, candidates int
	var status string
	if err = s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM rag_file_contents WHERE file_id=$1),(SELECT count(*) FROM image_caption_associations WHERE file_id=$1),(SELECT count(*) FROM source_refresh_candidates WHERE file_id=$1),(SELECT status FROM jobs WHERE id=$2)`, file, job.JobID).Scan(&aliases, &captions, &candidates, &status); err != nil {
		t.Fatal(err)
	}
	if aliases != 0 || captions != 0 || candidates != 0 || status != "done" || evictions() != evictedBefore+1 {
		t.Fatalf("index %d, captions %d, candidates %d, job %s, old room evicted %v", aliases, captions, candidates, status, evictions() > evictedBefore)
	}
}

// Store-only files publish export-only under the automatic trigger whatever
// auto-reparse says, through the handoff: finalize keeps the candidate, and the
// publication takes the collaboration service's rebase of a save made after
// the capture. The file stays unmarked and its room is left to the handoff.
func TestStoreOnlyAutomaticExport(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "store_only_export")
	file := maintenanceTestEdited(t, s, owner, "lesson.docx", true)
	for _, q := range []string{
		`UPDATE workspaces w SET auto_reparse=false FROM files f WHERE f.id=$1 AND w.id=f.workspace_id`,
		`UPDATE source_documents SET net_tokens=3000,last_edited_at=now()-interval '2 minutes' WHERE file_id=$1`,
	} {
		if _, err := s.pool.Exec(ctx, q, file); err != nil {
			t.Fatal(err)
		}
	}
	job, err := s.RequestSourceRefresh(ctx, owner, file, true)
	if err != nil {
		t.Fatal(err)
	}
	var exportOnly bool
	var reservation string
	if err = s.pool.QueryRow(ctx, `SELECT (payload->>'exportOnly')::boolean,payload->>'reservationId' FROM jobs WHERE id=$1`, job.JobID).Scan(&exportOnly, &reservation); err != nil {
		t.Fatal(err)
	}
	if !exportOnly || reservation != "" {
		t.Fatalf("store-only automatic job: exportOnly=%v reservation=%q", exportOnly, reservation)
	}
	candidate, err := s.ClaimSourceRefresh(ctx, file, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	baseline := sourceTestBaseline("docx", "D")
	if err = s.FinalizeSourceRefresh(ctx, file, SourceRefreshFinalize{JobID: job.JobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("d", 64), SizeBytes: 90, SourceETag: "etag-d", SeedBytes: int64(len("seed-d"))}); err != nil {
		t.Fatal(err)
	}
	// The handoff that follows gets a fresh lease.
	var jobType, status string
	var renewed bool
	if err = s.pool.QueryRow(ctx, `SELECT type,status,lease_expires_at>now()+interval '4 minutes' FROM jobs WHERE id=$1`, job.JobID).Scan(&jobType, &status, &renewed); err != nil || jobType != "source_refresh" || status != "running" || !renewed {
		t.Fatalf("finalize should keep the export for the handoff: %s %s renewed=%v %v", jobType, status, renewed, err)
	}
	doc, err := s.SourceSession(ctx, owner, file)
	if err != nil {
		t.Fatal(err)
	}
	doc = sourceTestEdit(t, s, owner, doc, "later-state")
	residual := json.RawMessage(`[{"id":"p","kind":"text","label":"Paragraph","operation":"replace","before":"a","after":"b"}]`)
	publish := SourceRefreshPublish{AttemptID: 1, JobID: job.JobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-d", PendingEffects: residual, NetTokens: 1, IndexedBaseline: baseline, RebasedState: []byte("rebased-later"), ExpectedLatestCheckpoint: doc.Checkpoint - 1}
	if _, err = s.PublishSourceRefresh(ctx, file, publish); !errors.Is(err, ErrConflict) {
		t.Fatalf("publication missing the later save: %v", err)
	}
	publish.ExpectedLatestCheckpoint = doc.Checkpoint
	published, err := s.PublishSourceRefresh(ctx, file, publish)
	if err != nil {
		t.Fatal(err)
	}
	if published.Epoch != 2 || published.IndexedCheckpoint != candidate.Checkpoint || published.Checkpoint != doc.Checkpoint || string(published.State) != "rebased-later" || string(published.IndexedBaseline) != string(baseline) || published.NetTokens != 1 || published.BaseRevision != 2 {
		t.Fatalf("export publication: %+v", published)
	}
	var marked, indexed bool
	var blobPath string
	var evictions int
	if err = s.pool.QueryRow(ctx, `SELECT d.reprocess_at IS NOT NULL,f.indexed,f.blob_path,j.status,(SELECT count(*) FROM collaboration_eviction_outbox WHERE payload->>'room'='source:'||d.file_id||':epoch:1') FROM source_documents d JOIN files f ON f.id=d.file_id JOIN jobs j ON j.id=$2 WHERE d.file_id=$1`, file, job.JobID).Scan(&marked, &indexed, &blobPath, &status, &evictions); err != nil {
		t.Fatal(err)
	}
	if marked || indexed || blobPath != candidate.SourceBlobPath || status != "done" || evictions != 0 {
		t.Fatalf("marked=%v indexed=%v blob=%s job=%s evictions=%d", marked, indexed, blobPath, status, evictions)
	}
	if again, err := s.PublishSourceRefresh(ctx, file, publish); err != nil || again.Epoch != 2 {
		t.Fatalf("publication receipt replay: %+v %v", again, err)
	}
}

// An automatic export is gated like a refresh: finalize refuses what the
// publication would certainly refuse (the new bytes against a source row with
// nothing left), and the publication refuses the net growth it then charges.
func TestStoreOnlyExportIsQuotaGated(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "store_only_quota")
	file := maintenanceTestEdited(t, s, owner, "lesson.docx", true)
	usage, err := s.StorageUsage(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	// Another upload leaves 1,000 bytes of headroom.
	var ws string
	var size int64
	if err = s.pool.QueryRow(ctx, `SELECT workspace_id,size_bytes FROM files WHERE id=$1`, file).Scan(&ws, &size); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateSourceReady(ctx, ws, owner, "big.pdf", "pdf", nil, "", usage.LimitBytes-usage.UsedBytes-1000, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE source_documents SET net_tokens=3000,last_edited_at=now()-interval '2 minutes' WHERE file_id=$1`, file); err != nil {
		t.Fatal(err)
	}
	job, err := s.RequestSourceRefresh(ctx, owner, file, true)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := s.ClaimSourceRefresh(ctx, file, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	finalize := SourceRefreshFinalize{JobID: job.JobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("f", 64), SizeBytes: size + 5000, SourceETag: "etag-f", SeedBytes: int64(len("seed-f"))}
	var quota *QuotaExceededError
	if err = s.FinalizeSourceRefresh(ctx, file, finalize); !errors.As(err, &quota) {
		t.Fatalf("finalize of an export that cannot fit: %v", err)
	}
	finalize.SizeBytes = size + 500
	if err = s.FinalizeSourceRefresh(ctx, file, finalize); err != nil {
		t.Fatal(err)
	}
	publish := SourceRefreshPublish{AttemptID: 1, JobID: job.JobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-f", PendingEffects: json.RawMessage(`[]`), IndexedBaseline: sourceTestBaseline("docx", "F"), RebasedState: []byte(strings.Repeat("r", 2000+len("seed-f"))), ExpectedLatestCheckpoint: candidate.Checkpoint}
	// With no save after the capture the state returns to seed(export): a
	// rebased state is refused.
	if _, err = s.PublishSourceRefresh(ctx, file, publish); !errors.Is(err, ErrConflict) {
		t.Fatalf("rebased state without a later save: %v", err)
	}
	// A save lands during the export; its rebase, 2,000 bytes past the export's
	// seed, does not fit.
	doc, err := s.SourceSession(ctx, owner, file)
	if err != nil {
		t.Fatal(err)
	}
	publish.ExpectedLatestCheckpoint = sourceTestEdit(t, s, owner, doc, "later-state").Checkpoint
	if _, err = s.PublishSourceRefresh(ctx, file, publish); !errors.As(err, &quota) {
		t.Fatalf("export past the quota: %v", err)
	}
}

// The owner's Process during an export-only publication is kept: before
// finalize the job goes on as an owner-paid parse of the same capture (the
// first parse's fee), after finalize it becomes that parse at once and the
// export's own publication is refused.
func TestProcessDuringExportOnlyIsKept(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "export_process")
	start := func(name string) (string, SourceRefreshCandidate, SourceRefreshFinalize) {
		t.Helper()
		file := maintenanceTestEdited(t, s, owner, name, true)
		for _, q := range []string{
			`UPDATE workspaces w SET auto_reparse=false FROM files f WHERE f.id=$1 AND w.id=f.workspace_id`,
			`UPDATE source_documents SET net_tokens=3000,last_edited_at=now()-interval '2 minutes' WHERE file_id=$1`,
		} {
			if _, err := s.pool.Exec(ctx, q, file); err != nil {
				t.Fatal(err)
			}
		}
		job, err := s.RequestSourceRefresh(ctx, owner, file, true)
		if err != nil {
			t.Fatal(err)
		}
		candidate, err := s.ClaimSourceRefresh(ctx, file, job.JobID)
		if err != nil {
			t.Fatal(err)
		}
		return file, candidate, SourceRefreshFinalize{JobID: job.JobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("e", 64), SizeBytes: 90, SourceETag: "etag-e", SeedBytes: int64(len("seed-e"))}
	}
	job := func(id string) (jobType string, exportOnly bool, paidBy, reservation string, fee bool) {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT type,(payload->>'exportOnly')::boolean,payload->>'paidBy',payload->>'reservationId',(payload->>'parseFee')::boolean FROM jobs WHERE id=$1`, id).Scan(&jobType, &exportOnly, &paidBy, &reservation, &fee); err != nil {
			t.Fatal(err)
		}
		return
	}
	process := func(file, running string) {
		t.Helper()
		result, err := s.RequestSourceRefresh(ctx, owner, file, false)
		if err != nil || result.JobID != running {
			t.Fatalf("Process: %+v %v", result, err)
		}
	}

	early, _, finalize := start("early.docx")
	process(early, finalize.JobID)
	if _, exportOnly, paidBy, reservation, fee := job(finalize.JobID); exportOnly || paidBy != models.PaidByPlatform || reservation == "" || !fee {
		t.Fatalf("Process before finalize: exportOnly=%v paidBy=%s reservation=%q fee=%v", exportOnly, paidBy, reservation, fee)
	}
	if err := s.FinalizeSourceRefresh(ctx, early, finalize); err != nil {
		t.Fatal(err)
	}
	if jobType, _, _, _, _ := job(finalize.JobID); jobType != "parse" {
		t.Fatalf("finalize after Process: job %s, want parse", jobType)
	}

	late, candidate, finalize := start("late.docx")
	if err := s.FinalizeSourceRefresh(ctx, late, finalize); err != nil {
		t.Fatal(err)
	}
	process(late, finalize.JobID)
	if jobType, exportOnly, _, _, _ := job(finalize.JobID); jobType != "parse" || exportOnly {
		t.Fatalf("Process after finalize: job %s exportOnly=%v, want its parse", jobType, exportOnly)
	}
	doc, err := s.SourceSession(ctx, owner, late)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.PublishSourceRefresh(ctx, late, SourceRefreshPublish{AttemptID: 1, JobID: finalize.JobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-e", PendingEffects: json.RawMessage(`[]`), ExpectedLatestCheckpoint: doc.Checkpoint})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("the export's own publication after Process: %v", err)
	}
}

// A maintenance republish publishes an over-quota (frozen) owner's edits end
// to end, where the owner's own refresh is refused.
func TestBlockedOwnerMaintenanceRepublish(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "frozen_owner")
	subID := uid("sub")
	if err := s.UpsertSubscription(ctx, proSubscription(owner, subID, 1000)); err != nil {
		t.Fatal(err)
	}
	file := maintenanceTestEdited(t, s, owner, "lesson.docx", false)
	var ws string
	if err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, file).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSourceReady(ctx, ws, owner, "big.pdf", "pdf", nil, "", mustPlanLimits(t, s, PlanFree).StorageBytes+1, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	lapsed := time.Now().AddDate(0, 0, -(overQuotaBufferDays + 1)).UTC()
	ended := proSubscription(owner, subID, 1001)
	ended.Status, ended.CurrentPeriodEnd = "canceled", &lapsed
	if err := s.UpsertSubscription(ctx, ended); err != nil {
		t.Fatal(err)
	}
	if status, err := s.AccountAccess(ctx, owner); err != nil || status.State != AccountOverQuotaFrozen {
		t.Fatalf("owner state %s %v", status.State, err)
	}
	var locked *AccountLockedError
	if _, err := s.RequestSourceRefresh(ctx, owner, file, false); !errors.As(err, &locked) {
		t.Fatalf("owner refresh while frozen: %v", err)
	}
	maintenanceTestPause(t, s)
	published, err := s.PublishAllOfficeSources(ctx)
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(published, func(p OfficePublication) bool { return p.FileID == file })
	if i < 0 || published[i].Err != nil || published[i].ExportOnly {
		t.Fatalf("publish-all for a frozen owner: %+v", published)
	}
	jobID := published[i].JobID
	candidate, err := s.ClaimSourceRefresh(ctx, file, jobID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.FinalizeSourceRefresh(ctx, file, SourceRefreshFinalize{JobID: jobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 5 << 20, SourceETag: "etag-b", SeedBytes: int64(len("seed-b"))}); err != nil {
		t.Fatal(err)
	}
	content := uid("rc")
	// The pipeline's parse and index, as far as publication reads them.
	for _, step := range []struct {
		q    string
		args []any
	}{
		{`UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, []any{jobID}},
		{`INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'hash-b','ready')`, []any{content, ws}},
		{`UPDATE source_refresh_candidates SET content_id=$2,content_hash='hash-b' WHERE file_id=$1`, []any{file, content}},
	} {
		if _, err = s.pool.Exec(ctx, step.q, step.args...); err != nil {
			t.Fatal(step.q, err)
		}
	}
	out, err := s.PublishSourceRefresh(ctx, file, SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, jobID), JobID: jobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-b", ContentID: content, ContentHash: "hash-b", PendingEffects: json.RawMessage(`[]`), ExpectedLatestCheckpoint: candidate.Checkpoint})
	if err != nil {
		t.Fatal(err)
	}
	if out.Epoch != 2 || out.IndexedCheckpoint != out.Checkpoint || out.State != nil || out.IndexedBaseline != nil {
		t.Fatalf("frozen owner's republish: %+v", out)
	}
}

// An export that fails for a trashed file is recorded rather than left to its
// lease: the maintenance window exports trashed files.
func TestFailedTrashedExportParks(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "trashed_export_failure")
	file := maintenanceTestEdited(t, s, owner, "lesson.docx", false)
	if _, err := s.pool.Exec(ctx, `UPDATE files SET trashed_at=now(),trash_episode_id='episode',purge_after=now()+interval '30 days' WHERE id=$1`, file); err != nil {
		t.Fatal(err)
	}
	job, err := s.requestSourceRefresh(ctx, owner, file, false, models.PaidBySystem, true)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := s.ClaimSourceRefresh(ctx, file, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.FailSourceRefresh(ctx, file, job.JobID, candidate.LeaseToken, "engine export failed", false); err != nil {
		t.Fatal(err)
	}
	var refreshError string
	var running bool
	if err = s.pool.QueryRow(ctx, `SELECT COALESCE(refresh_error,''),running_job_id IS NOT NULL FROM source_documents WHERE file_id=$1`, file).Scan(&refreshError, &running); err != nil || refreshError != "engine export failed" || running {
		t.Fatalf("refresh_error=%q running=%v %v", refreshError, running, err)
	}
}

// TestReprocessSelection runs the scheduler's candidate statement: an
// export-only file is reprocessed once its owner is active and it is out of
// the trash, never while store-only or indexed; Go indexes it at platform cost
// and moves the next attempt a day ahead, and a refusal moves it an hour. A
// locked owner's file with due edits comes through the refresh branch without
// the flag, so Go's refusal parks it instead of deferring a reprocess forever.
func TestReprocessSelection(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "reprocess_owner")
	suspended := newBlobTestUser(t, s, "reprocess_suspended")
	marked := func(user, name string, storeOnly bool, extra string) string {
		t.Helper()
		_, file := sourceTestFile(t, s, user, name, "doc")
		sourceTestSeed(t, s, user, file.ID)
		if _, err := s.pool.Exec(ctx, `UPDATE files SET ever_parsed_successfully=$2,parse_mode=CASE WHEN $2 THEN 'fast' ELSE 'none' END WHERE id=$1`, file.ID, !storeOnly); err != nil {
			t.Fatal(err)
		}
		if _, err := s.pool.Exec(ctx, `UPDATE source_documents SET reprocess_at=now()-interval '1 minute' WHERE file_id=$1`, file.ID); err != nil {
			t.Fatal(err)
		}
		if extra != "" {
			if _, err := s.pool.Exec(ctx, extra, file.ID); err != nil {
				t.Fatal(err)
			}
		}
		return file.ID
	}
	due := marked(owner, "due.docx", false, "")
	mine := []string{
		due,
		marked(owner, "store-only.docx", true, ""),
		marked(owner, "indexed.docx", false, `UPDATE files SET indexed=true WHERE id=$1`),
		marked(owner, "trashed.docx", false, `UPDATE files SET trashed_at=now(),trash_episode_id='episode',purge_after=now()+interval '30 days' WHERE id=$1`),
		marked(owner, "later.docx", false, `UPDATE source_documents SET reprocess_at=now()+interval '1 hour' WHERE file_id=$1`),
	}
	locked := marked(suspended, "locked.docx", false, "")
	lockedDoc, err := s.SourceSession(ctx, suspended, locked)
	if err != nil {
		t.Fatal(err)
	}
	sourceTestEdit(t, s, suspended, lockedDoc, "edited-state")
	mine = append(mine, locked)
	for _, q := range []string{
		`UPDATE source_documents SET last_edited_at=now()-interval '2 minutes' WHERE file_id=$1`,
		`UPDATE users SET suspended_at=now(),suspended_reason='test' WHERE id=(SELECT user_id FROM files WHERE id=$1)`,
	} {
		if _, err = s.pool.Exec(ctx, q, locked); err != nil {
			t.Fatal(err)
		}
	}
	candidatesSQL := schedulerSource(t, "(?s)const REFRESH_CANDIDATES_SQL = `(.*?)`;")
	deferSQL := schedulerSource(t, `(?s)const REPROCESS_DEFER_SQL =\s*"(.*?)";`)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	// Only this test's rows compete for the batch; the rollback restores the rest.
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET refresh_error='other test',reprocess_at=NULL WHERE NOT file_id=ANY($1)`, mine); err != nil {
		t.Fatal(err)
	}
	// file -> reprocess flag
	selected := func() map[string]bool {
		t.Helper()
		rows, err := tx.Query(ctx, candidatesSQL, officeRefreshTokens, "60 seconds", "7 days")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		files := map[string]bool{}
		for rows.Next() {
			var file, user string
			var checkpoint int64
			var reprocess bool
			if err := rows.Scan(&file, &user, &checkpoint, &reprocess); err != nil {
				t.Fatal(err)
			}
			files[file] = reprocess
		}
		return files
	}
	if got := selected(); !maps.Equal(got, map[string]bool{due: true, locked: false}) {
		t.Fatalf("candidates %v, want %s reprocessed and %s refreshed", got, due, locked)
	}
	if _, err = tx.Exec(ctx, deferSQL, due); err != nil {
		t.Fatal(err)
	}
	if got := selected(); !maps.Equal(got, map[string]bool{locked: false}) {
		t.Fatalf("a refused reprocess is selected again at once: %v", got)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	job, err := s.RequestSourceRefresh(ctx, owner, due, true)
	if err != nil {
		t.Fatal(err)
	}
	var jobType, paidBy, sessionPaidBy, fileStatus string
	var refresh, nextDay bool
	if err = s.pool.QueryRow(ctx, `SELECT j.type,j.payload->>'paidBy',j.payload ? 'sourceRefresh',ps.paid_by,f.status,d.reprocess_at>now()+interval '23 hours' FROM jobs j JOIN provider_sessions ps ON ps.id=j.payload->>'reservationId' JOIN files f ON f.id=j.payload->>'fileId' JOIN source_documents d ON d.file_id=f.id WHERE j.id=$1`, job.JobID).Scan(&jobType, &paidBy, &refresh, &sessionPaidBy, &fileStatus, &nextDay); err != nil {
		t.Fatal(err)
	}
	if jobType != "parse" || paidBy != models.PaidBySystem || refresh || sessionPaidBy != models.PaidBySystem || fileStatus != "pending" || !nextDay {
		t.Fatalf("reprocess job: type=%s paidBy=%s refresh=%v session=%s status=%s nextDay=%v", jobType, paidBy, refresh, sessionPaidBy, fileStatus, nextDay)
	}
	// A stale selection's defer never pulls the next day back to an hour, and
	// a request while the first job is queued adds no second one.
	if _, err = s.pool.Exec(ctx, deferSQL, due); err != nil {
		t.Fatal(err)
	}
	if err = s.pool.QueryRow(ctx, `SELECT reprocess_at>now()+interval '23 hours' FROM source_documents WHERE file_id=$1`, due).Scan(&nextDay); err != nil || !nextDay {
		t.Fatalf("defer pulled the daily retry back: %v %v", nextDay, err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE source_documents SET reprocess_at=now()-interval '1 minute' WHERE file_id=$1`, due); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RequestSourceRefresh(ctx, owner, due, true); !errors.Is(err, ErrConflict) {
		t.Fatalf("second reprocess while the first is queued: %v", err)
	}
}

// Readiness counts only Office publication and reprocess work, and fails until
// the pause is on.
func TestOfficeReadiness(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "office_readiness")
	unpublished := maintenanceTestEdited(t, s, owner, "lesson.docx", false)
	_, textFile := sourceTestFile(t, s, owner, "notes.txt", "txt")
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, textFile.ID), "text-edit")
	refresh, err := s.RequestSourceRefresh(ctx, owner, unpublished, false)
	if err != nil {
		t.Fatal(err)
	}
	upload, reprocess := uid("job"), uid("job")
	for id, payload := range map[string]string{
		upload:    `{"fileId":"` + textFile.ID + `"}`,
		reprocess: `{"fileId":"` + unpublished + `","paidBy":"system"}`,
	} {
		if _, err = s.pool.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,'parse',$2)`, id, payload); err != nil {
			t.Fatal(err)
		}
	}
	check := func(paused bool) OfficeReadiness {
		t.Helper()
		ready, err := s.OfficeReadiness(ctx)
		if err != nil {
			t.Fatal(err)
		}
		listed := func(file string) bool {
			return slices.ContainsFunc(ready.Unpublished, func(u UnpublishedSource) bool { return u.FileID == file })
		}
		flying := func(id string) bool {
			return slices.ContainsFunc(ready.InFlight, func(j InFlightJob) bool { return j.ID == id })
		}
		if ready.Paused != paused || !listed(unpublished) || listed(textFile.ID) || !flying(refresh.JobID) || !flying(reprocess) || flying(upload) || ready.Ready() {
			t.Fatalf("readiness %+v", ready)
		}
		return ready
	}
	check(false)
	if err = s.SetOfficeEditingPaused(ctx, true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.SetOfficeEditingPaused(context.Background(), false) })
	check(true)
	if !(OfficeReadiness{Paused: true}).Ready() || (OfficeReadiness{}).Ready() {
		t.Fatal("ready means paused with nothing left")
	}
}

// The reset template refuses while an Office source is unpublished or editing
// is not paused, then drops every state of the reset formats under a new
// epoch. Each run rolls back.
func TestOfficeWindowResetTemplate(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "reset_template")
	file := maintenanceTestEdited(t, s, owner, "lesson.docx", false)
	raw, err := os.ReadFile("../../migrations/templates/office_window_reset.sql")
	if err != nil {
		t.Fatal(err)
	}
	reset := strings.ReplaceAll(string(raw), "{{FORMATS}}", "'docx','xlsx','pptx'")
	run := func(steps ...string) (pgx.Tx, error) {
		t.Helper()
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
		for _, q := range append([]string{
			// Other tests' rows count as published.
			`UPDATE source_documents SET indexed_checkpoint=checkpoint,pending_effects='[]',running_job_id=NULL WHERE file_id<>'` + file + `'`,
		}, steps...) {
			if _, err = tx.Exec(ctx, q); err != nil {
				t.Fatal(q, err)
			}
		}
		if _, err = tx.Exec(ctx, reset); err != nil {
			_ = tx.Rollback(ctx) // release the reset's lock for the next run
		}
		return tx, err
	}
	published := `UPDATE source_documents SET indexed_checkpoint=checkpoint,pending_effects='[]' WHERE file_id='` + file + `'`
	if _, err = run(); err == nil || !strings.Contains(err.Error(), "unpublished edits") {
		t.Fatalf("reset with an unpublished file: %v", err)
	}
	if _, err = run(published); err == nil || !strings.Contains(err.Error(), "not paused") {
		t.Fatalf("reset without the pause: %v", err)
	}
	tx, err := run(published, `INSERT INTO office_editing_pause DEFAULT VALUES ON CONFLICT DO NOTHING`)
	if err != nil {
		t.Fatal(err)
	}
	var epoch int64
	var dropped bool
	if err = tx.QueryRow(ctx, `SELECT epoch,state IS NULL AND seed_bytes=0 AND indexed_baseline IS NULL AND pending_effects='[]'::jsonb FROM source_documents WHERE file_id=$1`, file).Scan(&epoch, &dropped); err != nil {
		t.Fatal(err)
	}
	if epoch != 2 || !dropped {
		t.Fatalf("reset: epoch=%d dropped=%v", epoch, dropped)
	}
}

// Go counts pending-effect tokens like effectTokens in sourceDocuments.ts: a
// move weighs nothing, any other non-text effect one token.
func TestSourceEffectTokensSkipMoves(t *testing.T) {
	var effects []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`[{"kind":"text","operation":"move"},{"kind":"image","operation":"move"},{"kind":"image","operation":"add"},{"kind":"text","operation":"replace","before":"abcd","after":"efgh"}]`), &effects); err != nil {
		t.Fatal(err)
	}
	if got, err := sourceEffectTokens(effects); err != nil || got != 3 {
		t.Fatalf("tokens %d %v, want 3", got, err)
	}
}
