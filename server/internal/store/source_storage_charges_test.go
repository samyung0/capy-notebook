package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/migrations"
)

// chargeTestLedger is what the triggers booked for owner (used bytes plus
// pending deltas) and what reconciliation recounts from the rows.
func chargeTestLedger(t *testing.T, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, owner string) (booked, recount int64) {
	t.Helper()
	ctx := context.Background()
	var reserved int64
	if err := q.QueryRow(ctx, `SELECT COALESCE((SELECT used_bytes FROM user_storage WHERE user_id=$1),0)+COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$1),0)`, owner).Scan(&booked); err != nil {
		t.Fatal(err)
	}
	if err := q.QueryRow(ctx, storageRecountSQL, owner).Scan(&recount, &reserved); err != nil {
		t.Fatal(err)
	}
	return booked, recount
}

// chargeTestCharged is owner's charge, after checking that reconciliation
// recounts what the triggers booked.
func chargeTestCharged(t *testing.T, s *Store, owner string) int64 {
	t.Helper()
	booked, recount := chargeTestLedger(t, s.pool, owner)
	if booked != recount {
		t.Fatalf("booked %d, reconciliation recounts %d", booked, recount)
	}
	return booked
}

// chargeTestPublish runs the refresh jobID of fileID to its publication: an
// export of size bytes from the captured checkpoint, then (when later is set)
// a save of the state later after the capture, then the publication with
// effects remaining.
func chargeTestPublish(t *testing.T, s *Store, owner, workspaceID, fileID, jobID string, size int64, later string, effects json.RawMessage, deferred bool) SourceSession {
	t.Helper()
	ctx := context.Background()
	candidate, err := s.ClaimSourceRefresh(ctx, fileID, jobID)
	if err != nil {
		t.Fatal(err)
	}
	sha := strings.Repeat(uid("e")[2:3], 64)
	if err = s.FinalizeSourceRefresh(ctx, fileID, SourceRefreshFinalize{JobID: jobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: sha, SizeBytes: size, SourceETag: "etag-" + jobID}); err != nil {
		t.Fatal(err)
	}
	latest := candidate.Checkpoint
	if later != "" {
		latest = sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, fileID), later).Checkpoint
	}
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	contentID := uid("rc")
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,$3,'ready')`, contentID, workspaceID, "hash-"+jobID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash=$3 WHERE file_id=$1`, fileID, contentID, "hash-"+jobID); err != nil {
		t.Fatal(err)
	}
	published, err := s.PublishSourceRefresh(ctx, fileID, SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, jobID), JobID: jobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-" + jobID, ContentID: contentID, ContentHash: "hash-" + jobID, ExpectedLatestCheckpoint: latest, PendingEffects: effects, NetTokens: 1, Deferred: deferred})
	if err != nil {
		t.Fatal(err)
	}
	return published
}

func chargeTestStorageBytes(t *testing.T, s *Store, fileID string) int64 {
	t.Helper()
	var storage int64
	if err := s.pool.QueryRow(context.Background(), `SELECT storage_bytes FROM source_documents WHERE file_id=$1`, fileID).Scan(&storage); err != nil {
		t.Fatal(err)
	}
	return storage
}

// chargeTestEffectBytes is what sourceTestSave's pending effects cost.
func chargeTestEffectBytes(t *testing.T, s *Store) int64 {
	t.Helper()
	var n int64
	if err := s.pool.QueryRow(context.Background(), `SELECT octet_length($1::jsonb::text)`, string(sourceTestSave(SourceSession{}, "", "").PendingEffects)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A deferred Office publication charges the edits it captured once, in the
// file's bytes: until the rebuild the state is charged only beyond the
// published capture, through a refused rebuild and a republication, and the
// rebuild's state is charged as stored again.
func TestDeferredPublicationChargesCapturedEditsOnce(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "deferred_charge_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	start := chargeTestCharged(t, s, owner)
	// An image inserted as a data URL and saved: the state and its effects.
	captured := "state+" + strings.Repeat("i", 1000)
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), captured)
	if got, want := chargeTestCharged(t, s, owner)-start, int64(len(captured))+chargeTestEffectBytes(t, s); got != want {
		t.Fatalf("saved edits charged %d, want %d", got, want)
	}
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	// The 1,100-byte export holds the image; "+later" lands after the capture.
	none := json.RawMessage(`[]`)
	published := chargeTestPublish(t, s, owner, ws.ID, file.ID, job.JobID, 1100, captured+"+later", none, true)
	if !published.RebuildPending || string(published.PublishedState) != captured {
		t.Fatalf("deferred publication: %+v", published)
	}
	if got := chargeTestCharged(t, s, owner) - start; got != 1100-100+int64(len("+later")) {
		t.Fatalf("charge while the rebuild waits = %d, want the export's growth plus 6", got)
	}
	// A refused rebuild keeps the charge, and the republication measures the
	// state against its own capture.
	if err = s.RefuseSourceRebuild(ctx, file.ID, SourceRebuildRefusal{Epoch: doc.Epoch, PublishedSourceSHA256: published.PublishedSourceSHA256, Error: "Office rebase: refused"}); err != nil {
		t.Fatal(err)
	}
	if got := chargeTestCharged(t, s, owner) - start; got != 1100-100+int64(len("+later")) {
		t.Fatalf("charge after the refused rebuild = %d", got)
	}
	if job, err = s.RequestSourceRefresh(ctx, owner, file.ID, false); err != nil {
		t.Fatal(err)
	}
	republished := chargeTestPublish(t, s, owner, ws.ID, file.ID, job.JobID, 1106, captured+"+later+again", none, true)
	if got := chargeTestCharged(t, s, owner) - start; got != 1106-100+int64(len("+again")) {
		t.Fatalf("charge after the republication = %d, want the export's growth plus 6", got)
	}
	// The rebuild stores the later edit as its change over seed(published).
	if err = s.RebuildSource(ctx, file.ID, SourceRebuild{Epoch: republished.Epoch, ExpectedCheckpoint: republished.Checkpoint, PublishedSourceSHA256: republished.PublishedSourceSHA256, State: []byte("change"), StateSeedSHA256: sourceTestStateSeed, PendingEffects: none}); err != nil {
		t.Fatal(err)
	}
	if got := chargeTestCharged(t, s, owner) - start; got != 1106-100+int64(len("change")) {
		t.Fatalf("charge after the rebuild = %d, want the export's growth plus the stored change", got)
	}
}

// A text publication moves the seed size by the change in the file's size:
// the text it published is charged in the file only, round after round, while
// Yjs history and edits after the capture stay charged in the state.
func TestTextPublicationChargesPublishedTextOnce(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "text_charge_owner")
	ws, file := sourceTestFile(t, s, owner, "notes.md", "md")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	start := chargeTestCharged(t, s, owner)
	state := func(n int) string { return strings.Repeat("s", n) }
	// The 100-byte file seeds a 115-byte state (see 0054). Saved: 50 bytes of
	// text added and 3 of history.
	save := sourceTestSave(sourceTestSeed(t, s, owner, file.ID), owner, state(115+50+3))
	save.SeedBytes = 115
	if _, err = s.SaveSourceCheckpoint(ctx, file.ID, save); err != nil {
		t.Fatal(err)
	}
	if got, want := chargeTestCharged(t, s, owner)-start, 53+chargeTestEffectBytes(t, s); got != want {
		t.Fatalf("saved text charged %d, want %d", got, want)
	}
	publish := func(size int64, later string) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, `UPDATE source_documents SET last_refresh_requested_at=now()-interval '16 seconds' WHERE file_id=$1`, file.ID); err != nil {
			t.Fatal(err)
		}
		job, err := s.RequestSourceRefresh(ctx, owner, file.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		chargeTestPublish(t, s, owner, ws.ID, file.ID, job.JobID, size, later, json.RawMessage(`[]`), false)
	}
	check := func(round string, seed, charge int64) {
		t.Helper()
		var got int64
		if err := s.pool.QueryRow(ctx, `SELECT seed_bytes FROM source_documents WHERE file_id=$1`, file.ID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if charged := chargeTestCharged(t, s, owner) - start; got != seed || charged != charge {
			t.Fatalf("%s: seed_bytes %d, charge %d; want %d and %d", round, got, charged, seed, charge)
		}
	}
	// The 150-byte text publishes; the 3 bytes of history stay charged.
	publish(150, "")
	check("first publication", 165, 150-100+3)
	// 40 more bytes of text and 2 of history publish as 190 bytes, and 7
	// bytes land after the capture.
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), state(115+50+3+40+2))
	publish(190, state(115+50+3+40+2+7))
	check("second publication", 205, 190-100+3+2+7)
}

// Migration 0054 charges a pending Office state beyond its published capture
// and gives every text state the seed size of its file, booking each change.
func TestPublicationStorageChargesMigration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "publication_charges_migration")
	_, pending := sourceTestFile(t, s, owner, "pending.docx", "doc")
	_, office := sourceTestFile(t, s, owner, "office.pptx", "ppt")
	_, published := sourceTestFile(t, s, owner, "published.md", "md")
	_, fresh := sourceTestFile(t, s, owner, "fresh.txt", "txt")
	body, err := migrations.FS.ReadFile("0054_publication_storage_charges.sql")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	seed := sourceTestStateSeed
	for _, q := range []string{
		// The pre-0054 shape (0043's rule).
		`ALTER TABLE source_documents DROP COLUMN storage_bytes`,
		`ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint + CASE WHEN format = 'text' THEN GREATEST(0, COALESCE(octet_length(state), 0) - seed_bytes) ELSE COALESCE(octet_length(state), 0) END) STORED`,
		// A DOCX waiting for its rebuild: 300 bytes of state, 280 of them published.
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,state_seed_sha256,rebuild_pending,published_state,published_state_seed_sha256,pending_effects) VALUES('` + pending.ID + `','docx',2,'p',convert_to(repeat('s',300),'UTF8'),'` + seed + `',true,convert_to(repeat('s',280),'UTF8'),'` + seed + `','[{"id":"p"}]')`,
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,state_seed_sha256,pending_effects) VALUES('` + office.ID + `','pptx',1,'p',convert_to(repeat('o',40),'UTF8'),'` + seed + `','[]')`,
		// A text published since its first save keeps the seed of a 60-byte
		// text; one never published holds its file's seed (100 + 15).
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,seed_bytes,pending_effects) VALUES('` + published.ID + `','text',2,'p',convert_to(repeat('t',130),'UTF8'),75,'[]')`,
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,seed_bytes,pending_effects) VALUES('` + fresh.ID + `','text',1,'p',convert_to(repeat('t',130),'UTF8'),115,'[]')`,
	} {
		if _, err = tx.Exec(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	if booked, recount := chargeTestLedger(t, tx, owner); booked != recount {
		t.Fatalf("before 0054: booked %d, recount %d", booked, recount)
	}
	if _, err = tx.Exec(ctx, string(body)); err != nil {
		t.Fatal(err)
	}
	if booked, recount := chargeTestLedger(t, tx, owner); booked != recount {
		t.Fatalf("after 0054: booked %d, recount %d", booked, recount)
	}
	charges := map[string]int64{}
	for _, id := range []string{pending.ID, office.ID, published.ID, fresh.ID} {
		var charge int64
		if err = tx.QueryRow(ctx, `SELECT storage_bytes FROM source_documents WHERE file_id=$1`, id).Scan(&charge); err != nil {
			t.Fatal(err)
		}
		charges[id] = charge
	}
	if charges[pending.ID] != int64(len(`[{"id": "p"}]`))+20 || charges[office.ID] != 40 || charges[published.ID] != 15 || charges[fresh.ID] != 15 {
		t.Fatalf("charges after 0054: pending %d, office %d, published text %d, fresh text %d", charges[pending.ID], charges[office.ID], charges[published.ID], charges[fresh.ID])
	}
}
