package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/migrations"
)

func sourceTestFile(t *testing.T, s *Store, owner, name, kind string) (Workspace, File) {
	t.Helper()
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source workspace", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(ctx, ws.ID, owner, name, kind, nil, "", 100, "sources/"+uid("base"))
	if err != nil {
		t.Fatal(err)
	}
	return ws, file
}

// sourceTestSeed opens the editing session: the row starts with a NULL state
// (seed(base)) and a derived baseline, and nothing is saved.
func sourceTestSeed(t *testing.T, s *Store, actor, file string) SourceSession {
	t.Helper()
	doc, err := s.SourceSession(context.Background(), actor, file)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

// sourceTestSeedBytes is the seed size a text source's first save reports in
// these tests; sourceTestStateSeed the seed hash an Office change names.
const sourceTestSeedBytes = 4

var sourceTestStateSeed = strings.Repeat("c", 64)

// sourceTestSave is a save of doc's next checkpoint under migration 0039's
// rules: the first save binds the base SHA (and a text seed's size), and an
// Office state names the seed it is a change over.
func sourceTestSave(doc SourceSession, actor, state string) SourceCheckpoint {
	save := SourceCheckpoint{ActorIDs: []string{actor}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: doc.Checkpoint, State: []byte(state), PendingEffects: json.RawMessage(`[{"type":"text","before":"old","after":"new"}]`), NetTokens: 6000}
	if doc.State == nil {
		save.BaseSourceSHA256 = strings.Repeat("a", 64)
		if doc.Format == "text" {
			save.SeedBytes = sourceTestSeedBytes
		}
	}
	if doc.Format != "text" {
		save.StateSeedSHA256 = sourceTestStateSeed
	}
	return save
}

func sourceTestEdit(t *testing.T, s *Store, actor string, doc SourceSession, state string) SourceSession {
	t.Helper()
	ctx := context.Background()
	save := sourceTestSave(doc, actor, state)
	if _, err := s.SaveSourceCheckpoint(ctx, doc.FileID, save); err != nil {
		t.Fatal(err)
	}
	out, err := s.SourceSession(ctx, actor, doc.FileID)
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
	// A viewer opening first saves nothing (the state is seed(base)) and cannot author.
	doc := sourceTestSeed(t, s, viewer, file.ID)
	if doc.State != nil || doc.Checkpoint != 0 {
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
	req := SourceCheckpoint{ActorIDs: []string{viewer}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: 0, State: []byte("new"), PendingEffects: json.RawMessage(`[]`), SeedBytes: sourceTestSeedBytes, BaseSourceSHA256: strings.Repeat("a", 64)}
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

func TestOfficeAutomaticRefreshAdmission(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	owner := newBlobTestUser(t, s, "source_auto_refresh")
	for _, c := range []struct {
		tokens   int
		idle     string
		admitted bool
		effects  string
	}{
		{3000, "61 seconds", true, ""},
		{3000, "30 seconds", false, ""},
		{2999, "6 days", false, ""},
		{1, "7 days 1 minute", true, ""},
		// Moves only weigh 0 tokens and publish through the stale rule.
		{0, "7 days 1 minute", true, `[{"id":"p","kind":"text","label":"Paragraph","operation":"move"}]`},
		{0, "6 days", false, `[{"id":"p","kind":"text","label":"Paragraph","operation":"move"}]`},
		{0, "8 days", false, `[]`},
	} {
		_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
		sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "edited-state")
		if _, err = s.pool.Exec(ctx, `UPDATE files SET ever_parsed_successfully=true WHERE id=$1`, file.ID); err != nil {
			t.Fatal(err)
		}
		if _, err = s.pool.Exec(ctx, `UPDATE source_documents SET net_tokens=$2,last_edited_at=now()-$3::interval,pending_effects=COALESCE(NULLIF($4,'')::jsonb,pending_effects) WHERE file_id=$1`, file.ID, c.tokens, c.idle, c.effects); err != nil {
			t.Fatal(err)
		}
		_, err = s.RequestSourceRefresh(ctx, owner, file.ID, true)
		if (err == nil) != c.admitted || (err != nil && !errors.Is(err, ErrConflict)) {
			t.Fatalf("%d tokens after %s: err=%v, want admitted=%v", c.tokens, c.idle, err, c.admitted)
		}
	}
}

// schedulerSource reads a statement or constant of the collaboration
// scheduler (collaboration/src/sourceDocuments.ts), the first capture group of
// pattern, so the Go tests run it verbatim.
func schedulerSource(t *testing.T, pattern string) string {
	t.Helper()
	raw, err := os.ReadFile("../../../collaboration/src/sourceDocuments.ts")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(pattern).FindSubmatch(raw)
	if match == nil {
		t.Fatalf("%s not found in sourceDocuments.ts", pattern)
	}
	return string(match[1])
}

// TestRefreshSchedulerQuery runs the collaboration scheduler's statements from
// collaboration/src/sourceDocuments.ts verbatim with its trigger constants,
// which must equal Go admission's.
func TestRefreshSchedulerQuery(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	find := func(pattern string) string { return schedulerSource(t, pattern) }
	candidatesSQL := find("(?s)const REFRESH_CANDIDATES_SQL = `(.*?)`;")
	deferSQL := find(`(?s)const REFRESH_DEFER_SQL =\s*'(.*?)';`)
	tokens, err := strconv.Atoi(find(`const OFFICE_REFRESH_TOKENS = (\d+);`))
	if err != nil {
		t.Fatal(err)
	}
	idle, stale := find(`const OFFICE_REFRESH_IDLE = '(.*?)';`), find(`const OFFICE_REFRESH_STALE = '(.*?)';`)
	var same bool
	if err = s.pool.QueryRow(ctx, `SELECT $1::interval=make_interval(secs=>$2) AND $3::interval=make_interval(secs=>$4)`, idle, officeRefreshIdle.Seconds(), stale, officeRefreshStale.Seconds()).Scan(&same); err != nil || !same || tokens != officeRefreshTokens {
		t.Fatalf("scheduler trigger %d/%s/%s differs from Go admission (err %v)", tokens, idle, stale, err)
	}

	owner := newBlobTestUser(t, s, "source_scheduler")
	edited := func(netTokens int, ago, effects string) string {
		_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
		sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "edited-state")
		if _, err := s.pool.Exec(ctx, `UPDATE files SET ever_parsed_successfully=true WHERE id=$1`, file.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := s.pool.Exec(ctx, `UPDATE source_documents SET net_tokens=$2,last_edited_at=now()-$3::interval,last_refresh_requested_at=now()-$3::interval,pending_effects=COALESCE(NULLIF($4,'')::jsonb,pending_effects) WHERE file_id=$1`, file.ID, netTokens, ago, effects); err != nil {
			t.Fatal(err)
		}
		return file.ID
	}
	due := edited(3000, "2 minutes", "")
	worthless := edited(0, "8 days", `[]`) // an empty change list: Go refuses it
	// Moves only: 0 tokens, published by the stale rule.
	reordered := edited(0, "9 days", `[{"id":"p","kind":"text","label":"Paragraph","operation":"move"}]`)
	unedited := edited(5, "8 days", "")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	// Only this test's rows compete for the batch; the rollback restores the rest.
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET refresh_error='other test' WHERE NOT file_id=ANY($1)`, []string{due, worthless, reordered, unedited}); err != nil {
		t.Fatal(err)
	}
	candidates := func() []string {
		t.Helper()
		rows, err := tx.Query(ctx, candidatesSQL, tokens, idle, stale)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var files []string
		for rows.Next() {
			var file, user string
			var checkpoint int64
			var reprocess bool
			if err := rows.Scan(&file, &user, &checkpoint, &reprocess); err != nil {
				t.Fatal(err)
			}
			files = append(files, file)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return files
	}
	if got := candidates(); !slices.Equal(got, []string{reordered, unedited, due}) {
		t.Fatalf("candidates %v, want the reordered file, the unedited one, then the due one", got)
	}
	// A 429 (owner at the ingest-job limit) rotates the file behind the others.
	if _, err = tx.Exec(ctx, deferSQL, unedited); err != nil {
		t.Fatal(err)
	}
	if got := candidates(); !slices.Equal(got, []string{reordered, due, unedited}) {
		t.Fatalf("candidates after a 429 %v, want the refused file last", got)
	}
}

func TestSourceRefreshParseFeeAndSystemPayer(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	owner := newBlobTestUser(t, s, "source_refresh_payer")
	edited := func(everParsed bool) string {
		_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
		sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "edited-state")
		if _, err := s.pool.Exec(ctx, `UPDATE files SET ever_parsed_successfully=$2 WHERE id=$1`, file.ID, everParsed); err != nil {
			t.Fatal(err)
		}
		return file.ID
	}
	type jobPayload struct {
		ParseFee      bool   `json:"parseFee"`
		PaidBy        string `json:"paidBy"`
		ReservationID string `json:"reservationId"`
	}
	payloadOf := func(job SourceProcessResult, err error) jobPayload {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		var raw []byte
		if err = s.pool.QueryRow(ctx, `SELECT payload FROM jobs WHERE id=$1`, job.JobID).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var p jobPayload
		if err = json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	// The page fee applies to a file's first parse only.
	if p := payloadOf(s.RequestSourceRefresh(ctx, owner, edited(false), false)); !p.ParseFee || p.PaidBy != models.PaidByPlatform {
		t.Fatalf("first parse payload: %+v", p)
	}
	if p := payloadOf(s.RequestSourceRefresh(ctx, owner, edited(true), false)); p.ParseFee || p.PaidBy != models.PaidByPlatform {
		t.Fatalf("refresh payload: %+v", p)
	}
	// The system payer admits an owner who is out of credits and takes none of
	// the owner's ingest slots.
	if _, err = s.pool.Exec(ctx, `INSERT INTO user_credits(user_id,used_micros) VALUES($1,999999999999999) ON CONFLICT(user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros`, owner); err != nil {
		t.Fatal(err)
	}
	maintained := edited(true)
	if _, err = s.RequestSourceRefresh(ctx, owner, maintained, false); !errors.Is(err, ErrCreditsExhausted) {
		t.Fatalf("owner-paid refresh without credits: %v", err)
	}
	p := payloadOf(s.requestSourceRefresh(ctx, owner, maintained, false, models.PaidBySystem, false))
	var paidBy string
	if err = s.pool.QueryRow(ctx, `SELECT paid_by FROM provider_sessions WHERE id=$1`, p.ReservationID).Scan(&paidBy); err != nil {
		t.Fatal(err)
	}
	if p.ParseFee || p.PaidBy != models.PaidBySystem || paidBy != models.PaidBySystem {
		t.Fatalf("system refresh: payload %+v, session paid_by=%q", p, paidBy)
	}
	if slots, err := s.IngestSlots(ctx, owner); err != nil || slots.SlotsUsed != 2 {
		t.Fatalf("ingest slots: %+v %v", slots, err)
	}
}

// A maintenance (system) publication rebases the editing state onto the
// export at once; owner and automatic ones defer that (TestDeferredOffice...).
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
	job, err := s.requestSourceRefresh(ctx, owner, file.ID, false, models.PaidBySystem, false)
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
	// Copy-on-write: the candidate holds no state until a save lands, and the
	// claim reads the row's.
	captured := func() []byte {
		t.Helper()
		var state []byte
		if err := s.pool.QueryRow(ctx, `SELECT state FROM source_refresh_candidates WHERE file_id=$1`, file.ID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	if string(candidate.State) != "candidate-state" || captured() != nil {
		t.Fatalf("capture: claimed %q, stored %q", candidate.State, captured())
	}
	finalize := SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-b"}
	if err = s.FinalizeSourceRefresh(ctx, file.ID, finalize); err != nil {
		t.Fatal(err)
	}
	doc = sourceTestEdit(t, s, owner, doc, "newer-state")
	if string(captured()) != "candidate-state" {
		t.Fatalf("the first later save copied %q", captured())
	}
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, job.JobID); err != nil {
		t.Fatal(err)
	}
	contentID := uid("rc")
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'hash-b','ready')`, contentID, ws.ID); err != nil {
		t.Fatal(err)
	}
	indexedImage, pendingImage := strings.Repeat("c", 64), strings.Repeat("d", 64)
	if _, err = s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash='hash-b',image_sha256s=ARRAY[$3::text] WHERE file_id=$1`, file.ID, contentID, indexedImage); err != nil {
		t.Fatal(err)
	}
	for _, digest := range []string{indexedImage, pendingImage, strings.Repeat("e", 64)} {
		if _, err = s.pool.Exec(ctx, `INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes,published) VALUES($1,$2,$3,$4,10,false)`, uid("ica"), file.ID, digest, "caption/"+digest); err != nil {
			t.Fatal(err)
		}
	}
	residual := json.RawMessage(`[{"id":"image-new","kind":"image","operation":"add","imageSHA256":"` + pendingImage + `","after":"new image"}]`)
	publish := SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, job.JobID), JobID: job.JobID, Epoch: 1, Checkpoint: 1, LeaseToken: candidate.LeaseToken, SourceETag: "etag-b", ContentID: contentID, ContentHash: "hash-b", ExpectedLatestCheckpoint: doc.Checkpoint, RebasedState: []byte("rebased-newer-state"), RebasedStateSeedSHA256: sourceTestStateSeed, PendingEffects: residual, NetTokens: 3}
	// Another save wins while the native rebase is being calculated.
	doc = sourceTestEdit(t, s, owner, doc, "newest-state")
	if string(captured()) != "candidate-state" {
		t.Fatalf("a second later save replaced the copy with %q", captured())
	}
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
	// A rebased DOCX state lands on seed(export) and names that seed.
	publish.RebasedStateSeedSHA256 = ""
	if _, err = s.PublishSourceRefresh(ctx, file.ID, publish); !errors.Is(err, ErrConflict) {
		t.Fatalf("rebased DOCX state without its seed: %v", err)
	}
	publish.RebasedStateSeedSHA256 = sourceTestStateSeed
	// An export-only publication's reprocess mark ends once the file is indexed.
	if _, err = s.pool.Exec(ctx, `UPDATE source_documents SET reprocess_at=now() WHERE file_id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	// Blob references follow the base, which moves only in UPDATEs that name it
	// (migration 0039's trigger): the file and the source row leave the old
	// base for the candidate's export, and the candidate row is deleted.
	var oldBase, newBase string
	if err = s.pool.QueryRow(ctx, `SELECT d.base_blob_path,c.source_blob_path FROM source_documents d JOIN source_refresh_candidates c ON c.file_id=d.file_id WHERE d.file_id=$1`, file.ID).Scan(&oldBase, &newBase); err != nil {
		t.Fatal(err)
	}
	oldRefs, newRefs := blobRefCount(t, s, oldBase), blobRefCount(t, s, newBase)
	published, err := s.PublishSourceRefresh(ctx, file.ID, publish)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := blobRefCount(t, s, oldBase), oldRefs-2; got != want {
		t.Fatalf("old base references = %d, want %d", got, want)
	}
	if got, want := blobRefCount(t, s, newBase), newRefs+1; got != want {
		t.Fatalf("new base references = %d, want %d", got, want)
	}
	var marked bool
	if err = s.pool.QueryRow(ctx, `SELECT reprocess_at IS NOT NULL FROM source_documents WHERE file_id=$1`, file.ID).Scan(&marked); err != nil || marked {
		t.Fatalf("reprocess mark after an indexing publication: %v %v", marked, err)
	}
	var normalizedResidual []byte
	if err = s.pool.QueryRow(ctx, `SELECT $1::jsonb`, residual).Scan(&normalizedResidual); err != nil {
		t.Fatal(err)
	}
	if published.Epoch != 2 || published.Checkpoint != doc.Checkpoint || published.IndexedCheckpoint != 1 || published.NetTokens != 3 || string(published.State) != "rebased-newest-state" || published.StateSeedSHA256 == nil || *published.StateSeedSHA256 != sourceTestStateSeed || published.BaseRevision != 2 || string(published.PendingEffects) != string(normalizedResidual) {
		t.Fatalf("bad base promotion: %+v", published)
	}
	// The rebased change is charged as stored.
	var seedBytes, storage int64
	if err = s.pool.QueryRow(ctx, `SELECT seed_bytes,storage_bytes FROM source_documents WHERE file_id=$1`, file.ID).Scan(&seedBytes, &storage); err != nil {
		t.Fatal(err)
	}
	if want := int64(len(normalizedResidual) + len("rebased-newest-state")); seedBytes != 0 || storage != want {
		t.Fatalf("seed_bytes=%d storage_bytes=%d, want 0 and %d", seedBytes, storage, want)
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
	if _, err = s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{ActorIDs: []string{owner}, Epoch: 1, BaseRevision: 2, ExpectedCheckpoint: doc.Checkpoint, State: []byte("late"), PendingEffects: json.RawMessage(`[]`)}); !errors.Is(err, ErrConflict) {
		t.Fatalf("old epoch accepted: %v", err)
	}
}

// An owner's Office publication swaps the file and its index while editing
// stays on its base and epoch; the rebuild later moves editing onto the
// published file with a compare-and-swap.
func TestDeferredOfficePublicationAndRebuild(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "deferred_publish_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "captured-state")
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	export := strings.Repeat("b", 64)
	if err = s.FinalizeSourceRefresh(ctx, file.ID, SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: export, SizeBytes: 120, SourceETag: "etag-b"}); err != nil {
		t.Fatal(err)
	}
	captured := doc.Checkpoint
	doc = sourceTestEdit(t, s, owner, doc, "later-state")
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, job.JobID); err != nil {
		t.Fatal(err)
	}
	contentID := uid("rc")
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'hash-b','ready')`, contentID, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash='hash-b' WHERE file_id=$1`, file.ID, contentID); err != nil {
		t.Fatal(err)
	}
	var oldBase, newBase string
	if err = s.pool.QueryRow(ctx, `SELECT d.base_blob_path,c.source_blob_path FROM source_documents d JOIN source_refresh_candidates c ON c.file_id=d.file_id WHERE d.file_id=$1`, file.ID).Scan(&oldBase, &newBase); err != nil {
		t.Fatal(err)
	}
	oldRefs, newRefs := blobRefCount(t, s, oldBase), blobRefCount(t, s, newBase)
	residual := json.RawMessage(`[{"id":"p2","kind":"text","operation":"replace","before":"a","after":"b"}]`)
	publish := SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, job.JobID), JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: captured, LeaseToken: candidate.LeaseToken, SourceETag: "etag-b", ContentID: contentID, ContentHash: "hash-b", ExpectedLatestCheckpoint: doc.Checkpoint, PendingEffects: residual, NetTokens: 2}
	// The owner's work defers, and a deferred publication carries no rebase.
	if _, err = s.PublishSourceRefresh(ctx, file.ID, publish); !errors.Is(err, ErrConflict) {
		t.Fatalf("owner publication without deferral: %v", err)
	}
	publish.Deferred = true
	publish.RebasedState, publish.RebasedStateSeedSHA256 = []byte("rebased"), sourceTestStateSeed
	if _, err = s.PublishSourceRefresh(ctx, file.ID, publish); !errors.Is(err, ErrConflict) {
		t.Fatalf("deferred publication with a rebase: %v", err)
	}
	publish.RebasedState, publish.RebasedStateSeedSHA256 = nil, ""
	published, err := s.PublishSourceRefresh(ctx, file.ID, publish)
	if err != nil {
		t.Fatal(err)
	}
	if published.Epoch != 1 || string(published.State) != "later-state" || published.BaseBlobPath != oldBase || published.IndexedCheckpoint != captured || published.BaseRevision != 2 || !published.RebuildPending || string(published.PublishedState) != "captured-state" || published.PublishedSourceSHA256 != export || published.PublishedBlobPath != newBase || published.NetTokens != 2 {
		t.Fatalf("deferred publication: %+v", published)
	}
	// The file names the export; the source row still names the old base.
	if got := blobRefCount(t, s, oldBase); got != oldRefs-1 {
		t.Fatalf("old base references = %d, want %d", got, oldRefs-1)
	}
	if got := blobRefCount(t, s, newBase); got != newRefs {
		t.Fatalf("export references = %d, want %d", got, newRefs)
	}
	current, err := s.GetFile(ctx, file.ID)
	if err != nil || current.Revision != 2 || !current.Indexed {
		t.Fatalf("published file: %+v %v", current, err)
	}
	// A save whose effects were measured before the publication is refused
	// (its effects count the published edits); the room re-reads and retries.
	if _, err = s.SaveSourceCheckpoint(ctx, file.ID, sourceTestSave(doc, owner, "stale-effects")); !errors.Is(err, ErrConflict) {
		t.Fatalf("save measured before the publication: %v", err)
	}
	// Editing goes on in the same epoch.
	if err = s.CheckSourceAccess(ctx, owner, file.ID, 1, true); err != nil {
		t.Fatalf("access after a deferred publication: %v", err)
	}
	doc = sourceTestEdit(t, s, owner, published, "newest-state")
	// Maintenance waits for the rebuild.
	ready, err := s.OfficeReadiness(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var listed bool
	for _, u := range ready.Unpublished {
		listed = listed || (u.FileID == file.ID && u.RebuildPending)
	}
	if !listed {
		t.Fatalf("pending rebuild not listed: %+v", ready.Unpublished)
	}
	rebuild := SourceRebuild{Epoch: 1, ExpectedCheckpoint: doc.Checkpoint, PublishedSourceSHA256: export, State: []byte("rebased-newest"), StateSeedSHA256: sourceTestStateSeed, PendingEffects: json.RawMessage(`[]`)}
	for name, bad := range map[string]func(*SourceRebuild){
		"stale epoch":          func(r *SourceRebuild) { r.Epoch = 2 },
		"stale checkpoint":     func(r *SourceRebuild) { r.ExpectedCheckpoint-- },
		"other published":      func(r *SourceRebuild) { r.PublishedSourceSHA256 = strings.Repeat("f", 64) },
		"no state after edits": func(r *SourceRebuild) { r.State, r.StateSeedSHA256 = nil, "" },
		"state without seed":   func(r *SourceRebuild) { r.StateSeedSHA256 = "" },
	} {
		attempt := rebuild
		bad(&attempt)
		if err = s.RebuildSource(ctx, file.ID, attempt); !errors.Is(err, ErrConflict) {
			t.Fatalf("%s rebuilt: %v", name, err)
		}
	}
	// Never under a refresh in flight: its capture belongs to this epoch.
	if _, err = s.RequestSourceRefresh(ctx, owner, file.ID, false); err != nil {
		t.Fatal(err)
	}
	if err = s.RebuildSource(ctx, file.ID, rebuild); !errors.Is(err, ErrConflict) {
		t.Fatalf("rebuilt under a refresh: %v", err)
	}
	if err = s.CancelSourceRefresh(ctx, owner, file.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.RebuildSource(ctx, file.ID, rebuild); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := s.SourceSession(ctx, owner, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rebuilt.Epoch != 2 || rebuilt.BaseBlobPath != newBase || rebuilt.BaseSourceSHA256 != export || string(rebuilt.State) != "rebased-newest" || rebuilt.StateSeedSHA256 == nil || *rebuilt.StateSeedSHA256 != sourceTestStateSeed || rebuilt.RebuildPending || rebuilt.PublishedState != nil || string(rebuilt.PendingEffects) != "[]" {
		t.Fatalf("rebuild: %+v", rebuilt)
	}
	if got := blobRefCount(t, s, oldBase); got != oldRefs-2 {
		t.Fatalf("old base references after the rebuild = %d, want %d", got, oldRefs-2)
	}
	if err = s.RebuildSource(ctx, file.ID, SourceRebuild{Epoch: 2, ExpectedCheckpoint: rebuilt.Checkpoint, PublishedSourceSHA256: export, PendingEffects: json.RawMessage(`[]`)}); !errors.Is(err, ErrConflict) {
		t.Fatalf("second rebuild: %v", err)
	}
	if _, err = s.SaveSourceCheckpoint(ctx, file.ID, sourceTestSave(doc, owner, "old-epoch")); !errors.Is(err, ErrConflict) {
		t.Fatalf("old epoch accepted after the rebuild: %v", err)
	}
}

// Nothing saved after the capture: the viewer still reads the published edits
// (the old base plus the state), and the rebuild lands on seed(published).
// sourceTestDeferredPublication is a DOCX whose saved edits (state
// "captured-state") published deferred with nothing saved since: its rebuild
// is pending onto the export it returns.
func sourceTestDeferredPublication(t *testing.T, s *Store, owner string) (fileID string, checkpoint int64, export string) {
	t.Helper()
	ctx := context.Background()
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "captured-state")
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	export = strings.Repeat("b", 64)
	sourceTestPublishDeferred(t, s, ws.ID, file.ID, job.JobID, export)
	return file.ID, doc.Checkpoint, export
}

// sourceTestPublishDeferred claims, exports (as export), parses and publishes
// the admitted refresh jobID deferred, with nothing saved after its capture.
func sourceTestPublishDeferred(t *testing.T, s *Store, workspaceID, fileID, jobID, export string) {
	t.Helper()
	ctx := context.Background()
	candidate, err := s.ClaimSourceRefresh(ctx, fileID, jobID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.FinalizeSourceRefresh(ctx, fileID, SourceRefreshFinalize{JobID: jobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: export, SizeBytes: 120, SourceETag: "etag-" + export[:1]}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	contentID := uid("rc")
	if _, err = s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,$3,'ready')`, contentID, workspaceID, "hash-"+export); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash=$3 WHERE file_id=$1`, fileID, contentID, "hash-"+export); err != nil {
		t.Fatal(err)
	}
	if _, err = s.PublishSourceRefresh(ctx, fileID, SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, jobID), JobID: jobID, Epoch: candidate.Epoch, Checkpoint: candidate.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-" + export[:1], ContentID: contentID, ContentHash: "hash-" + export, ExpectedLatestCheckpoint: candidate.Checkpoint, PendingEffects: json.RawMessage(`[]`), Deferred: true}); err != nil {
		t.Fatal(err)
	}
}

func TestDeferredPublicationWithoutLaterEditsRebuildsToTheExport(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	fileID, checkpoint, export := sourceTestDeferredPublication(t, s, newBlobTestUser(t, s, "deferred_clean_owner"))
	view, err := s.ViewSourceSession(ctx, fileID)
	if err != nil || string(view.State) != "captured-state" || view.Checkpoint != view.IndexedCheckpoint {
		t.Fatalf("view while the rebuild is pending: %+v %v", view, err)
	}
	if err = s.RebuildSource(ctx, fileID, SourceRebuild{Epoch: 1, ExpectedCheckpoint: checkpoint, PublishedSourceSHA256: export, State: []byte("x"), StateSeedSHA256: sourceTestStateSeed, PendingEffects: json.RawMessage(`[]`)}); !errors.Is(err, ErrConflict) {
		t.Fatalf("a rebased state with no later edits: %v", err)
	}
	if err = s.RebuildSource(ctx, fileID, SourceRebuild{Epoch: 1, ExpectedCheckpoint: checkpoint, PublishedSourceSHA256: export, PendingEffects: json.RawMessage(`[]`)}); err != nil {
		t.Fatal(err)
	}
	view, err = s.ViewSourceSession(ctx, fileID)
	if err != nil || view.State != nil || view.Epoch != 2 || view.BaseSourceSHA256 != export {
		t.Fatalf("view after the rebuild: %+v %v", view, err)
	}
}

// A deferred publication's rebuild that the engine refused (RebaseError)
// makes the file due whatever its remaining tokens: the scheduler lists it,
// admission takes it as an automatic refresh that records the refusal, and
// that republication clears it so its own rebuild lands.
func TestRefusedRebuildMakesTheFileDue(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "refused_rebuild_owner")
	fileID, _, export := sourceTestDeferredPublication(t, s, owner)
	// One edit saved after the capture, far below the token trigger, idle
	// past the quiet period.
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, fileID), "later-state")
	if _, err := s.pool.Exec(ctx, `UPDATE source_documents SET net_tokens=5,last_edited_at=now()-interval '2 minutes',last_refresh_requested_at=now()-interval '2 minutes' WHERE file_id=$1`, fileID); err != nil {
		t.Fatal(err)
	}
	candidatesSQL := schedulerSource(t, "(?s)const REFRESH_CANDIDATES_SQL = `(.*?)`;")
	idle, stale := schedulerSource(t, `const OFFICE_REFRESH_IDLE = '(.*?)';`), schedulerSource(t, `const OFFICE_REFRESH_STALE = '(.*?)';`)
	listed := func() bool {
		t.Helper()
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		// Only this file competes for the batch; the rollback restores the rest.
		if _, err = tx.Exec(ctx, `UPDATE source_documents SET refresh_error='other test' WHERE file_id<>$1`, fileID); err != nil {
			t.Fatal(err)
		}
		var found bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM (`+candidatesSQL+`) c WHERE c.file_id=$4)`, officeRefreshTokens, idle, stale, fileID).Scan(&found); err != nil {
			t.Fatal(err)
		}
		return found
	}
	if listed() {
		t.Fatal("5 tokens listed before any refusal")
	}
	if _, err := s.RequestSourceRefresh(ctx, owner, fileID, true); !errors.Is(err, ErrConflict) {
		t.Fatalf("automatic refresh before any refusal: %v", err)
	}
	const refusal = "Office rebase: a field result's child would not export in its field"
	refused := SourceRebuildRefusal{Epoch: 1, PublishedSourceSHA256: export, Error: refusal}
	for name, bad := range map[string]func(*SourceRebuildRefusal){
		"stale epoch":     func(r *SourceRebuildRefusal) { r.Epoch = 2 },
		"other published": func(r *SourceRebuildRefusal) { r.PublishedSourceSHA256 = strings.Repeat("f", 64) },
	} {
		attempt := refused
		bad(&attempt)
		if err := s.RefuseSourceRebuild(ctx, fileID, attempt); !errors.Is(err, ErrConflict) {
			t.Fatalf("%s refusal recorded: %v", name, err)
		}
	}
	if err := s.RefuseSourceRebuild(ctx, fileID, refused); err != nil {
		t.Fatal(err)
	}
	if !listed() {
		t.Fatal("a refused rebuild is not due")
	}
	job, err := s.RequestSourceRefresh(ctx, owner, fileID, true)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Automatic      bool   `json:"automatic"`
		PaidBy         string `json:"paidBy"`
		RebuildRefusal string `json:"rebuildRefusal"`
	}
	var raw []byte
	if err = s.pool.QueryRow(ctx, `SELECT payload FROM jobs WHERE id=$1`, job.JobID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &payload); err != nil || !payload.Automatic || payload.PaidBy != models.PaidByPlatform || payload.RebuildRefusal != refusal {
		t.Fatalf("republication payload %s: %v", raw, err)
	}
	var workspaceID string
	if err = s.pool.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, fileID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	republished := strings.Repeat("c", 64)
	sourceTestPublishDeferred(t, s, workspaceID, fileID, job.JobID, republished)
	var pending bool
	var refusalLeft *string
	var checkpoint int64
	if err = s.pool.QueryRow(ctx, `SELECT rebuild_pending,rebuild_refusal,checkpoint FROM source_documents WHERE file_id=$1`, fileID).Scan(&pending, &refusalLeft, &checkpoint); err != nil || !pending || refusalLeft != nil {
		t.Fatalf("after the republication: pending=%v refusal=%v %v", pending, refusalLeft, err)
	}
	if err = s.RebuildSource(ctx, fileID, SourceRebuild{Epoch: 1, ExpectedCheckpoint: checkpoint, PublishedSourceSHA256: republished, PendingEffects: json.RawMessage(`[]`)}); err != nil {
		t.Fatal(err)
	}
	if err = s.RefuseSourceRebuild(ctx, fileID, SourceRebuildRefusal{Epoch: 2, PublishedSourceSHA256: republished, Error: refusal}); !errors.Is(err, ErrConflict) {
		t.Fatalf("refusal with no rebuild pending: %v", err)
	}
}

func TestSourceEpochResetKeepsTheSaveAndRetiresTheOldEpoch(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "epoch_reset_owner")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "saved")
	if err := s.ResetSourceEpoch(ctx, file.ID, SourceEpochReset{Epoch: doc.Epoch}); err != nil {
		t.Fatal(err)
	}
	// A second report of the same discard leaves the new epoch alone.
	if err := s.ResetSourceEpoch(ctx, file.ID, SourceEpochReset{Epoch: doc.Epoch}); err != nil {
		t.Fatal(err)
	}
	after := sourceTestSeed(t, s, owner, file.ID)
	if after.Epoch != doc.Epoch+1 || after.Checkpoint != doc.Checkpoint || string(after.State) != "saved" {
		t.Fatalf("after the reset: epoch %d checkpoint %d state %q", after.Epoch, after.Checkpoint, after.State)
	}
	// A save measured in the old epoch never lands.
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, sourceTestSave(doc, owner, "stale")); err == nil {
		t.Fatal("a save of the old epoch landed")
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
	if _, err = s.SavePDFAnnotation(ctx, viewer, file.ID, row.ID, body); !errors.Is(err, ErrInvalidPDFAnnotation) {
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
	if err = s.FinalizeSourceRefresh(ctx, file.ID, SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-text"}); err != nil {
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
	published, err := s.PublishSourceRefresh(ctx, file.ID, SourceRefreshPublish{AttemptID: sourceTestAttempt(t, s, job.JobID), JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-text", ContentID: contentID, ContentHash: "text-b", PendingEffects: residual, NetTokens: 2, ExpectedLatestCheckpoint: latest.Checkpoint})
	if err != nil {
		t.Fatal(err)
	}
	if published.Epoch != 1 || published.Checkpoint != 2 || published.IndexedCheckpoint != 1 || string(published.State) != "state-a-again" || published.NetTokens != 2 {
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
	// The published descriptor keeps its running change share for the reuse gate.
	contentID := uid("rgc")
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'clone-hash','ready')`, contentID, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES($1,$2,$3)`, file.ID, ws.ID, contentID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_content_summaries(content_id,workspace_id,descriptor,change_share,summary_version) VALUES($1,$2,'Photosynthesis.',0.0125,2)`, contentID, ws.ID); err != nil {
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
	var descriptor string
	var share float64
	if err = s.pool.QueryRow(ctx, `SELECT cs.descriptor,cs.change_share FROM rag_content_summaries cs JOIN rag_file_contents fc ON fc.content_id=cs.content_id WHERE fc.file_id=$1`, clonedFile).Scan(&descriptor, &share); err != nil || descriptor != "Photosynthesis." || share != 0.0125 {
		t.Fatalf("clone descriptor=%q change_share=%v err=%v", descriptor, share, err)
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
	if !ws.AutoProcess {
		t.Fatalf("auto settings not enabled: %+v", ws)
	}
	disabled := false
	updated, err := s.UpdateWorkspace(ctx, owner, ws.ID, WorkspacePatch{AutoProcess: &disabled})
	if err != nil {
		t.Fatal(err)
	}
	if updated.AutoProcess {
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
	if stats.Indexed != 1 || stats.NotIndexed != 1 || stats.NotIndexable != 1 || len(stats.FileChanges) != 1 || stats.FileChanges[0].FileID != file.ID || stats.FileChanges[0].State != "waiting" {
		t.Fatalf("wrong partition: %+v", stats)
	}
}

func TestFileChangesQueueAndCancel(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "file_changes_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "queued-state")
	state := func() string {
		t.Helper()
		stats, err := s.WorkspaceStats(ctx, owner, ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(stats.FileChanges) != 1 {
			t.Fatalf("file changes = %+v", stats.FileChanges)
		}
		return stats.FileChanges[0].State
	}
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := state(); got != "queued" {
		t.Fatalf("requested refresh is %s", got)
	}
	if err = s.CancelSourceRefresh(ctx, owner, file.ID); err != nil {
		t.Fatal(err)
	}
	var status string
	var manual bool
	if err = s.pool.QueryRow(ctx, `SELECT j.status,d.desired_manual FROM jobs j,source_documents d WHERE j.id=$1 AND d.file_id=$2`, job.JobID, file.ID).Scan(&status, &manual); err != nil || status != "failed" || manual {
		t.Fatalf("cancel left job %s manual=%v err=%v", status, manual, err)
	}
	if got := state(); got != "waiting" {
		t.Fatalf("cancelled refresh is %s", got)
	}
	if job, err = s.RequestSourceRefresh(ctx, owner, file.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1 WHERE id=$1`, job.JobID); err != nil {
		t.Fatal(err)
	}
	if err = s.CancelSourceRefresh(ctx, owner, file.ID); !errors.Is(err, ErrProcessingStarted) {
		t.Fatalf("cancel of a started refresh: %v", err)
	}
	if got := state(); got != "processing" {
		t.Fatalf("started refresh is %s", got)
	}
	if _, err = s.pool.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'failed','source_refresh','source_refresh_failed','boom')`, job.JobID); err != nil {
		t.Fatal(err)
	}
	if got := state(); got != "failed" {
		t.Fatalf("failed refresh is %s", got)
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

// An Office source is charged its pending effects plus its stored state (the
// change over the seed), a text source its state's growth beyond the seed
// (human/backend-storage-quota.md, 2026-09-28): opening saves nothing, and a
// refresh candidate is uncharged while transient.
func TestSourceQuotaChargesEffectsAndStoredState(t *testing.T) {
	for _, tc := range []struct{ name, kind string }{{"lesson.docx", "doc"}, {"notes.txt", "txt"}} {
		t.Run(tc.name, func(t *testing.T) {
			s := openAccessTestStore(t)
			ctx := context.Background()
			reg, err := models.New(ctx, s.Pool())
			if err != nil {
				t.Fatal(err)
			}
			s.SetModelRegistry(reg)
			owner := newBlobTestUser(t, s, "source_quota_rule")
			_, file := sourceTestFile(t, s, owner, tc.name, tc.kind)
			doc := sourceTestSeed(t, s, owner, file.ID)
			// Opening charges nothing beyond the source.
			var opened int64
			if err = s.pool.QueryRow(ctx, `SELECT storage_bytes FROM source_documents WHERE file_id=$1`, file.ID).Scan(&opened); err != nil || opened != 0 {
				t.Fatalf("storage after opening: %d %v", opened, err)
			}
			usage, err := s.StorageUsage(ctx, owner)
			if err != nil {
				t.Fatal(err)
			}
			// 100 bytes under the limit; an empty effect list costs nothing.
			if _, err = s.pool.Exec(ctx, `UPDATE files SET size_bytes=size_bytes+$2 WHERE id=$1`, file.ID, usage.LimitBytes-usage.UsedBytes-100); err != nil {
				t.Fatal(err)
			}
			// A text state is charged beyond its 4096-byte seed; an Office one as stored.
			free := 0
			if doc.Format == "text" {
				free = 4096
			}
			save := func(state int) error {
				req := sourceTestSave(doc, owner, strings.Repeat("s", state))
				req.PendingEffects, req.NetTokens = json.RawMessage(`[]`), 1
				if doc.Format == "text" {
					req.SeedBytes = int64(free)
				}
				_, err := s.SaveSourceCheckpoint(ctx, file.ID, req)
				return err
			}
			if err = save(free + 100); err != nil {
				t.Fatalf("a 100-byte save: %v", err)
			}
			if usage, err = s.StorageUsage(ctx, owner); err != nil || usage.UsedBytes != usage.LimitBytes {
				t.Fatalf("after the first save: %+v %v", usage, err)
			}
			// At the quota, a refresh is still admitted and charges nothing.
			if _, err = s.RequestSourceRefresh(ctx, owner, file.ID, false); err != nil {
				t.Fatalf("refresh at the quota: %v", err)
			}
			if usage, err = s.StorageUsage(ctx, owner); err != nil || usage.UsedBytes != usage.LimitBytes {
				t.Fatalf("after admission: %+v %v", usage, err)
			}
		})
	}
}

// An Office state is stored only as its change over seed(base), named by the
// seed's hash; a text state is complete. The wrong kind is refused.
func TestSourceCheckpointStateKind(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_state_kind")
	for _, tc := range []struct{ name, kind string }{{"lesson.docx", "doc"}, {"notes.txt", "txt"}} {
		_, file := sourceTestFile(t, s, owner, tc.name, tc.kind)
		doc := sourceTestSeed(t, s, owner, file.ID)
		wrong := sourceTestSave(doc, owner, "state")
		if doc.Format == "text" {
			wrong.StateSeedSHA256 = sourceTestStateSeed
		} else {
			wrong.StateSeedSHA256 = ""
		}
		if _, err := s.SaveSourceCheckpoint(ctx, file.ID, wrong); !errors.Is(err, ErrInvalidCheckpoint) {
			t.Fatalf("%s: wrong state kind saved: %v", tc.name, err)
		}
		if doc.Format != "text" {
			wrong.StateSeedSHA256, wrong.SeedBytes = strings.Repeat("C", 64), 0
			if _, err := s.SaveSourceCheckpoint(ctx, file.ID, wrong); !errors.Is(err, ErrInvalidCheckpoint) {
				t.Fatalf("malformed seed hash saved: %v", err)
			}
			wrong.StateSeedSHA256, wrong.SeedBytes = sourceTestStateSeed, 4
			if _, err := s.SaveSourceCheckpoint(ctx, file.ID, wrong); !errors.Is(err, ErrInvalidCheckpoint) {
				t.Fatalf("Office seed size saved: %v", err)
			}
		}
		doc = sourceTestEdit(t, s, owner, doc, "state")
		var stateSeed *string
		var seedBytes int64
		if err := s.pool.QueryRow(ctx, `SELECT state_seed_sha256,seed_bytes FROM source_documents WHERE file_id=$1`, file.ID).Scan(&stateSeed, &seedBytes); err != nil {
			t.Fatal(err)
		}
		if doc.Format == "text" {
			if stateSeed != nil || doc.StateSeedSHA256 != nil || seedBytes != sourceTestSeedBytes {
				t.Fatalf("text state kind: %v %d", stateSeed, seedBytes)
			}
			continue
		}
		if stateSeed == nil || *stateSeed != sourceTestStateSeed || doc.StateSeedSHA256 == nil || *doc.StateSeedSHA256 != sourceTestStateSeed || seedBytes != 0 {
			t.Fatalf("Office state kind: %v %d", stateSeed, seedBytes)
		}
	}
}

// A refresh that captured a NULL state (seed(base)) still reads NULL after a
// save lands: the save copies NULL into the candidate, and the readers (Go's
// claim and the service's CAPTURED_STATE_SQL, run verbatim) take the copy
// once the checkpoints differ instead of the row's newer state.
func TestNullCaptureSurvivesALaterSave(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	owner := newBlobTestUser(t, s, "null_capture")
	_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	doc := sourceTestSeed(t, s, owner, file.ID)
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false) // Process with no edits
	if err != nil {
		t.Fatal(err)
	}
	sourceTestEdit(t, s, owner, doc, "later-state")
	candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	reader := schedulerSource(t, `(?s)export const CAPTURED_STATE_SQL =\s*'(.*?)';`)
	var captured []byte
	if err = s.pool.QueryRow(ctx, `SELECT `+reader+` FROM source_refresh_candidates c JOIN source_documents d ON d.file_id=c.file_id WHERE c.file_id=$1`, file.ID).Scan(&captured); err != nil {
		t.Fatal(err)
	}
	if candidate.State != nil || captured != nil {
		t.Fatalf("captured seed(base) read as %q (claim) and %q (service)", candidate.State, captured)
	}
}

// Migration 0039 charges an Office row its stored state instead of its growth
// beyond seed_bytes, keeps text on its seed, and books every changed charge in
// the storage ledger.
func TestOfficeStateDiffMigrationKeepsTheLedger(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "storage_rule_ledger")
	_, office := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	_, text := sourceTestFile(t, s, owner, "notes.txt", "txt")
	body, err := migrations.FS.ReadFile("0039_office_state_diffs.sql")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, q := range []string{
		// The pre-0039 shape (0033's rule). Other tests' rows only need to satisfy it.
		`ALTER TABLE source_documents DROP COLUMN storage_bytes, DROP COLUMN state_seed_sha256, DROP CONSTRAINT source_documents_seed_bytes_text_check, ADD COLUMN indexed_baseline bytea`,
		`ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint + GREATEST(0, COALESCE(octet_length(state), 0) - seed_bytes) + COALESCE(octet_length(indexed_baseline), 0)) STORED`,
		`ALTER TABLE source_refresh_candidates DROP COLUMN state_seed_sha256, ADD COLUMN seed_bytes bigint CHECK (seed_bytes >= 0)`,
		// An edited Office file and an edited text file, each over a seed.
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,seed_bytes,indexed_baseline,pending_effects) VALUES('` + office.ID + `','docx',1,'p',convert_to(repeat('s',300),'UTF8'),200,convert_to(repeat('b',100),'UTF8'),'[{"id":"p"}]')`,
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,seed_bytes,pending_effects) VALUES('` + text.ID + `','text',1,'p',convert_to(repeat('t',50),'UTF8'),20,'[]')`,
	} {
		if _, err = tx.Exec(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	ledger := func() (booked, recount int64) {
		t.Helper()
		if err := tx.QueryRow(ctx, `SELECT
			COALESCE((SELECT used_bytes FROM user_storage WHERE user_id=$1),0)+COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$1),0),
			COALESCE((SELECT sum(size_bytes) FROM files WHERE user_id=$1),0)
			+COALESCE((SELECT sum(storage_bytes) FROM source_documents WHERE user_id=$1),0)
			+COALESCE((SELECT sum(size_bytes) FROM editor_assets WHERE user_id=$1 AND status='ready'),0)
			+COALESCE((SELECT sum(size_bytes) FROM materials WHERE owner_user_id=$1),0)
			+COALESCE((SELECT sum(inverse_bytes) FROM agent_edit_inverses WHERE owner_user_id=$1),0)`, owner).Scan(&booked, &recount); err != nil {
			t.Fatal(err)
		}
		return booked, recount
	}
	if booked, recount := ledger(); booked != recount {
		t.Fatalf("before 0039: booked %d, recount %d", booked, recount)
	}
	if _, err = tx.Exec(ctx, string(body)); err != nil {
		t.Fatal(err)
	}
	if booked, recount := ledger(); booked != recount {
		t.Fatalf("after 0039: booked %d, recount %d", booked, recount)
	}
	var officeCharge, officeSeed, textCharge, textSeed int64
	if err = tx.QueryRow(ctx, `SELECT (SELECT storage_bytes FROM source_documents WHERE file_id=$1),(SELECT seed_bytes FROM source_documents WHERE file_id=$1),(SELECT storage_bytes FROM source_documents WHERE file_id=$2),(SELECT seed_bytes FROM source_documents WHERE file_id=$2)`, office.ID, text.ID).Scan(&officeCharge, &officeSeed, &textCharge, &textSeed); err != nil {
		t.Fatal(err)
	}
	if officeCharge != int64(len(`[{"id": "p"}]`))+300+100 || officeSeed != 0 || textCharge != 30 || textSeed != 20 {
		t.Fatalf("charges after 0039: office %d (seed %d), text %d (seed %d)", officeCharge, officeSeed, textCharge, textSeed)
	}
}

// Migration 0043 drops the stored baseline once no row holds a state a
// publication rebased whole, keeps every charge, and requires an Office state
// to name its seed.
func TestOfficeRebaseSeedExportMigration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "rebase_seed_export")
	_, rebased := sourceTestFile(t, s, owner, "rebased.docx", "doc")
	_, change := sourceTestFile(t, s, owner, "change.pptx", "ppt")
	_, text := sourceTestFile(t, s, owner, "notes.txt", "txt")
	body, err := migrations.FS.ReadFile("0043_office_rebase_seed_export.sql")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	exec := func(q string, args ...any) error {
		_, err := tx.Exec(ctx, q, args...)
		return err
	}
	for _, q := range []string{
		// The pre-0043 shape (0039's rule).
		`ALTER TABLE source_documents DROP CONSTRAINT source_documents_office_state_seed_check, DROP COLUMN storage_bytes, ADD COLUMN indexed_baseline bytea`,
		`ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint + CASE WHEN format = 'text' THEN GREATEST(0, COALESCE(octet_length(state), 0) - seed_bytes) ELSE COALESCE(octet_length(state), 0) END + COALESCE(octet_length(indexed_baseline), 0)) STORED`,
		// A DOCX state a publication rebased before: stored whole, with its baseline.
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,indexed_baseline,pending_effects) VALUES('` + rebased.ID + `','docx',1,'p','whole','baseline','[]')`,
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,state_seed_sha256,pending_effects) VALUES('` + change.ID + `','pptx',1,'p','change','` + sourceTestStateSeed + `','[{"id":"p"}]')`,
		`INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,state,seed_bytes,pending_effects) VALUES('` + text.ID + `','text',1,'p',convert_to(repeat('t',50),'UTF8'),20,'[]')`,
	} {
		if err = exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	if err = exec(`SAVEPOINT refused`); err != nil {
		t.Fatal(err)
	}
	if err = exec(string(body)); err == nil || !strings.Contains(err.Error(), "publish it") {
		t.Fatalf("0043 over a state rebased whole: %v", err)
	}
	// Its publication returns the state to seed(export).
	if err = exec(`ROLLBACK TO SAVEPOINT refused`); err != nil {
		t.Fatal(err)
	}
	if err = exec(`UPDATE source_documents SET state=NULL,indexed_baseline=NULL WHERE file_id=$1`, rebased.ID); err != nil {
		t.Fatal(err)
	}
	charges := func() (booked, recount int64) {
		t.Helper()
		if err := tx.QueryRow(ctx, `SELECT
			COALESCE((SELECT used_bytes FROM user_storage WHERE user_id=$1),0)+COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$1),0),
			COALESCE((SELECT sum(size_bytes) FROM files WHERE user_id=$1),0)+COALESCE((SELECT sum(storage_bytes) FROM source_documents WHERE user_id=$1),0)`, owner).Scan(&booked, &recount); err != nil {
			t.Fatal(err)
		}
		return booked, recount
	}
	bookedBefore, recountBefore := charges()
	if err = exec(string(body)); err != nil {
		t.Fatal(err)
	}
	if booked, recount := charges(); booked != bookedBefore || recount != recountBefore || booked != recount {
		t.Fatalf("charges: booked %d → %d, recount %d → %d", bookedBefore, booked, recountBefore, recount)
	}
	if err = exec(`SAVEPOINT unnamed`); err != nil {
		t.Fatal(err)
	}
	if err = exec(`UPDATE source_documents SET state_seed_sha256=NULL WHERE file_id=$1`, change.ID); err == nil || !strings.Contains(err.Error(), "source_documents_office_state_seed_check") {
		t.Fatalf("an Office state without its seed: %v", err)
	}
}

// The collaboration service retries a moved checkpoint (it reloads and
// merges), ends an old epoch's room and gives up at once on invalid input,
// so the three answers stay distinct.
func TestSourceCheckpointConflictKinds(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "source_conflict_kinds")
	_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	doc := sourceTestSeed(t, s, owner, file.ID)
	moved := sourceTestSave(doc, owner, "state")
	moved.ExpectedCheckpoint++
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, moved); !errors.Is(err, ErrCheckpointMoved) {
		t.Fatalf("moved checkpoint: %v", err)
	}
	ended := sourceTestSave(doc, owner, "state")
	ended.Epoch++
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, ended); !errors.Is(err, ErrSourceEpochChanged) {
		t.Fatalf("ended epoch: %v", err)
	}
	invalid := sourceTestSave(doc, owner, "state")
	invalid.PendingEffects = json.RawMessage(`{}`)
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, invalid); !errors.Is(err, ErrInvalidCheckpoint) || errors.Is(err, ErrConflict) {
		t.Fatalf("invalid input: %v", err)
	}
}
