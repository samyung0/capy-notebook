package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// standaloneSourceFile is a ready file with no workspace, its owner's alone.
func standaloneSourceFile(t *testing.T, s *Store, owner, name, kind string) File {
	t.Helper()
	ctx := context.Background()
	id := uid("f")
	if _, err := s.pool.Exec(ctx, `INSERT INTO files (id,user_id,created_by,name,kind,size_bytes,added_at,status,blob_path)
		VALUES ($1,$2,$2,$3,$4,100,now(),'ready',$5)`, id, owner, name, kind, "sources/"+uid("base")); err != nil {
		t.Fatal(err)
	}
	file, err := s.GetFile(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return file
}

// Standalone files edit like workspace files through an owner-only room
// (Epo 2026-10-27): the source session, its edit admission and its saves are
// the payer's alone, never another user's, a link holder's included, and
// refused while the owner is suspended or pending deletion.
func TestStandaloneSourceSessionIsItsOwnersAlone(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for _, state := range []string{"suspended", "deletion_pending"} {
		t.Run(state, func(t *testing.T) {
			owner := newBlobTestUser(t, s, "u_loose_source_owner_"+state)
			other := newBlobTestUser(t, s, "u_loose_source_other_"+state)
			file := standaloneSourceFile(t, s, owner, "notes.md", "md")

			doc, err := s.SourceSession(ctx, owner, file.ID)
			if err != nil {
				t.Fatal(err)
			}
			if doc.WorkspaceID != "" || doc.Access != "write" || doc.OwnerID != owner || doc.Format != "text" {
				t.Fatalf("owner's session = %+v, want a writable text session with no workspace", doc.BrowserSourceSession)
			}
			if err := s.CheckSourceAccess(ctx, owner, file.ID, doc.Epoch, true); err != nil {
				t.Fatalf("owner's edit admission = %v", err)
			}

			// The other user edits the owner's link-shared workspace through its
			// link, which reaches none of the owner's files with no workspace.
			shared, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Shared", Tags: []TagRef{}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='link',share_role='editor' WHERE id=$1`, shared.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_link_grants (workspace_id,user_id) VALUES ($1,$2)`, shared.ID, other); err != nil {
				t.Fatal(err)
			}
			inShared, err := s.createReadyFile(ctx, shared.ID, owner, "shared.md", "md", nil, "", 100, "sources/"+uid("base"))
			if err != nil {
				t.Fatal(err)
			}
			if linked, err := s.SourceSession(ctx, other, inShared.ID); err != nil || linked.Access != "write" {
				t.Fatalf("link holder's session in the shared workspace = %+v, %v", linked.BrowserSourceSession, err)
			}
			if _, err := s.SourceSession(ctx, other, file.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("other user's session = %v, want not found", err)
			}
			if err := s.CheckSourceAccess(ctx, other, file.ID, doc.Epoch, false); !errors.Is(err, ErrNotFound) {
				t.Fatalf("other user's access = %v, want not found", err)
			}
			if _, err := s.SaveSourceCheckpoint(ctx, file.ID, sourceTestSave(doc, other, "theirs")); !errors.Is(err, ErrNotFound) {
				t.Fatalf("other user's save = %v, want not found", err)
			}

			lockOwner(t, s, owner, state)
			if state == "suspended" {
				var locked *AccountLockedError
				if _, err := s.SourceSession(ctx, owner, file.ID); !errors.As(err, &locked) || locked.State != AccountSuspended {
					t.Fatalf("suspended owner's session = %v, want the suspended account", err)
				}
				if err := s.CheckSourceAccess(ctx, owner, file.ID, doc.Epoch, true); !errors.As(err, &locked) {
					t.Fatalf("suspended owner's access = %v, want the suspended account", err)
				}
				return
			}
			if _, err := s.SourceSession(ctx, owner, file.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("deletion-pending owner's session = %v, want not found", err)
			}
			if err := s.CheckSourceAccess(ctx, owner, file.ID, doc.Epoch, true); !errors.Is(err, ErrNotFound) {
				t.Fatalf("deletion-pending owner's access = %v, want not found", err)
			}
		})
	}
}

// An Office file with no workspace saves its room's edits and an agent's
// edit, whose receipt names no workspace.
func TestStandaloneSourceSavesEditsAndAgentReceipts(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_loose_save_owner")
	file := standaloneSourceFile(t, s, owner, "lesson.docx", "doc")

	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "typed")
	if doc.Checkpoint != 1 || sourceTestDocument(doc) != "typed" {
		t.Fatalf("saved = %d %q, want checkpoint 1 typed", doc.Checkpoint, sourceTestDocument(doc))
	}
	save := sourceTestSave(doc, owner, "agent")
	save.Operation = &SourceCheckpointOperation{Receipt: SourceCheckpointReceipt{ID: uid("op"), RequestHash: "hash", ActorUserID: owner, ToolVersion: 1}}
	saved, err := s.SaveSourceCheckpoint(ctx, file.ID, save)
	if err != nil || saved.Checkpoint != 2 || saved.Operation == nil {
		t.Fatalf("agent save = %+v, %v", saved, err)
	}
	var kind string
	var ws *string
	if err := s.pool.QueryRow(ctx, `SELECT kind,workspace_id FROM agent_operations WHERE id=$1`, save.Operation.Receipt.ID).Scan(&kind, &ws); err != nil {
		t.Fatal(err)
	}
	if kind != "edit_document" || ws != nil {
		t.Fatalf("receipt = %s in %v, want edit_document with no workspace", kind, ws)
	}
}

// Q459 for a room that opened a file with no workspace: its Move's drain
// saves the payer's edits there, and nobody else's, the new workspace's
// editors included.
func TestAStandaloneRoomsDrainSavesAsItsPayer(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_loose_drain_owner")
	editor := newBlobTestUser(t, s, "u_loose_drain_editor")
	file := standaloneSourceFile(t, s, owner, "notes.md", "md")
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "before")
	target, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, target.ID, editor)
	if _, err := s.MoveFiles(ctx, owner, []string{file.ID}, MoveTarget{WorkspaceID: target.ID}, false); err != nil {
		t.Fatal(err)
	}

	theirs := sourceTestSave(doc, editor, "theirs")
	if theirs.WorkspaceID != "" {
		t.Fatalf("the room's workspace = %q, want none", theirs.WorkspaceID)
	}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, theirs); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an editor's save in the room with no workspace = %v, want not found", err)
	}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, sourceTestSave(doc, owner, "drain")); err != nil {
		t.Fatalf("the payer's drain save = %v", err)
	}
	reopened, err := s.SourceSession(ctx, editor, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.WorkspaceID != target.ID || reopened.Checkpoint != doc.Checkpoint+1 {
		t.Fatalf("reopened in %q at %d, want %q at %d", reopened.WorkspaceID, reopened.Checkpoint, target.ID, doc.Checkpoint+1)
	}
}

// A file with no workspace always auto-publishes (Epo 2026-10-27): the
// scheduler lists it as its payer's, Go admits the automatic refresh with an
// ingest in the payer's scope (no workspace, the retrieval default's
// embedding space), and the publication takes only the payer's content.
func TestStandaloneSourcePublishesAutomaticallyInItsOwnersScope(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	owner := newBlobTestUser(t, s, "u_loose_publish_owner")
	other := newBlobTestUser(t, s, "u_loose_publish_other")
	file := standaloneSourceFile(t, s, owner, "notes.md", "md")
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "state-b")
	// Idle, and older than any other test's file, so the scheduler's 8 list it.
	if _, err := s.pool.Exec(ctx, `UPDATE source_documents SET last_edited_at=now()-interval '400 days',last_refresh_requested_at=now()-interval '400 days' WHERE file_id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}

	candidatesSQL := schedulerSource(t, `(?s)const REFRESH_CANDIDATES_SQL: &str = "(.*?)";`)
	rows, err := s.pool.Query(ctx, candidatesSQL, officeRefreshTokens, "60 seconds", "7 days")
	if err != nil {
		t.Fatal(err)
	}
	listedFor := ""
	for rows.Next() {
		var id, user string
		var checkpoint int64
		var reprocess bool
		if err := rows.Scan(&id, &user, &checkpoint, &reprocess); err != nil {
			t.Fatal(err)
		}
		if id == file.ID {
			listedFor = user
		}
	}
	rows.Close()
	if listedFor != owner {
		t.Fatalf("scheduler listed the file for %q, want its payer %q", listedFor, owner)
	}

	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	var named bool
	var actor, embedding string
	var sessionWS *string
	if err := s.pool.QueryRow(ctx, `SELECT j.payload ? 'workspaceId',j.payload->>'actorUserId',COALESCE(j.payload->>'embeddingModelSlug',''),p.workspace_id
		FROM jobs j JOIN provider_sessions p ON p.id=j.payload->>'reservationId' WHERE j.id=$1`, job.JobID).Scan(&named, &actor, &embedding, &sessionWS); err != nil {
		t.Fatal(err)
	}
	if named || actor != owner || embedding == "" || sessionWS != nil {
		t.Fatalf("refresh job: workspace named %v, actor %q, embedding %q, session workspace %v", named, actor, embedding, sessionWS)
	}

	candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.FinalizeSourceRefresh(ctx, file.ID, SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-text", State: []byte("state-b")}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE jobs SET status='running',attempts=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`, job.JobID); err != nil {
		t.Fatal(err)
	}
	attempt := sourceTestAttempt(t, s, job.JobID)
	publish := func(contentID string) (SourceSession, error) {
		if _, err := s.pool.Exec(ctx, `UPDATE source_refresh_candidates SET content_id=$2,content_hash='text-b' WHERE file_id=$1`, file.ID, contentID); err != nil {
			t.Fatal(err)
		}
		return s.PublishSourceRefresh(ctx, file.ID, SourceRefreshPublish{AttemptID: attempt, JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceETag: "etag-text", ContentID: contentID, ContentHash: "text-b", PendingEffects: json.RawMessage(`[]`), ExpectedLatestCheckpoint: doc.Checkpoint})
	}
	content := func(user string) string {
		id := uid("rc")
		if _, err := s.pool.Exec(ctx, `INSERT INTO rag_contents(id,user_id,content_hash,status) VALUES($1,$2,'text-b','ready')`, id, user); err != nil {
			t.Fatal(err)
		}
		return id
	}
	if _, err := publish(content(other)); !errors.Is(err, ErrConflict) {
		t.Fatalf("publication with another user's content = %v, want conflict", err)
	}
	own := content(owner)
	published, err := publish(own)
	if err != nil {
		t.Fatal(err)
	}
	if published.WorkspaceID != "" || published.IndexedCheckpoint != doc.Checkpoint {
		t.Fatalf("published = %+v", published.BrowserSourceSession)
	}
	var aliasWS *string
	var aliased string
	var revision int64
	var indexed bool
	if err := s.pool.QueryRow(ctx, `SELECT a.workspace_id,a.content_id,f.revision,f.indexed FROM rag_file_contents a JOIN files f ON f.id=a.file_id WHERE a.file_id=$1`, file.ID).Scan(&aliasWS, &aliased, &revision, &indexed); err != nil {
		t.Fatal(err)
	}
	if aliasWS != nil || aliased != own || revision != 2 || !indexed {
		t.Fatalf("alias in %v to %q, revision %d, indexed %v", aliasWS, aliased, revision, indexed)
	}
}

// A PDF with no workspace takes its owner's private marks, and nobody else's.
func TestStandalonePDFAnnotationsAreItsOwners(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_loose_pdf_owner")
	other := newBlobTestUser(t, s, "u_loose_pdf_other")
	file := standaloneSourceFile(t, s, owner, "lesson.pdf", "pdf")
	body := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "highlight", Rects: []PDFRect{{X: 10, Y: 20, Width: 100, Height: 30}}, Color: "#ffcc00"}
	if _, err := s.SavePDFAnnotation(ctx, owner, file.ID, "", body); err != nil {
		t.Fatalf("owner's mark = %v", err)
	}
	if _, err := s.SavePDFAnnotation(ctx, other, file.ID, "", body); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user's mark = %v, want not found", err)
	}
}
