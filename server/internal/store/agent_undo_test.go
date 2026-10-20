package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// undoTestEdit commits a text source edit through its checkpoint; undoable
// says a live room took it.
func undoTestEdit(t *testing.T, s *Store, owner, fileID string, undoable bool) AgentOperation {
	t.Helper()
	ctx := context.Background()
	doc := sourceTestSeed(t, s, owner, fileID)
	save := sourceTestSave(doc, owner, "edited")
	save.Operation = &SourceCheckpointOperation{
		Receipt:  SourceCheckpointReceipt{ID: uid("op"), ToolVersion: 1, RequestHash: "h", ActorUserID: owner},
		Undoable: undoable,
	}
	saved, err := s.SaveSourceCheckpoint(ctx, fileID, save)
	if err != nil {
		t.Fatal(err)
	}
	return *saved.Operation
}

// undoTestAuthority answers the collaboration service's Undo routes: every
// Undo lands, and undo-status names the steps in `live`.
func undoTestAuthority(t *testing.T, s *Store, live func() []string, asked *[]string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/documents/undo":
			_, _ = w.Write([]byte(`{}`))
		case "/internal/documents/undo-status":
			var body struct {
				OperationIDs []string `json:"operationIds"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			*asked = body.OperationIDs
			_ = json.NewEncoder(w).Encode(map[string][]string{"live": live()})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	s.ConfigureCollaboration(srv.URL, "undo-secret")
}

// A direct edit's receipt carries an Undo ref only when a loaded room took
// it (Epo 2026-10-20 (a): no room loaded, no Undo).
func TestSourceEditReceiptCarriesUndoOnlyWhenARoomTookIt(t *testing.T) {
	s := openAccessTestStore(t)
	owner := newBlobTestUser(t, s, "undo_ref")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	live := undoTestEdit(t, s, owner, file.ID, true)
	if live.Effect.Operation != agenttools.EffectEdited || live.Effect.Undo == nil || live.Effect.Undo.OperationID != live.ID {
		t.Fatalf("edit a room took = %+v", live.Effect)
	}
	if closed := undoTestEdit(t, s, owner, file.ID, false); closed.Effect.Undo != nil {
		t.Fatalf("edit no room took = %+v", closed.Effect)
	}
}

// An edit's Undo runs in its room, then records an undo_edit receipt whose
// own ref is the Redo; Redo's receipt is an edit again. A step the room no
// longer holds is refused.
func TestDocumentUndoRecordsTheRoomsSteps(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "undo_room")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	edit := undoTestEdit(t, s, owner, file.ID, true)
	var asked []string
	undoTestAuthority(t, s, func() []string { return nil }, &asked)

	undo, err := s.UndoDocumentEdit(ctx, owner, edit, DocumentOperation{ID: uid("op"), RequestHash: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	if undo.Kind != "undo_edit" || undo.Effect.Operation != agenttools.EffectEditUndone || undo.Effect.Undo.OperationID != undo.ID {
		t.Fatalf("undo = %+v %+v", undo, undo.Effect)
	}
	redo, err := s.UndoDocumentEdit(ctx, owner, undo, DocumentOperation{ID: uid("op"), RequestHash: "u2"})
	if err != nil {
		t.Fatal(err)
	}
	if redo.Effect.Operation != agenttools.EffectEdited || redo.Effect.Undo.OperationID != redo.ID {
		t.Fatalf("redo = %+v", redo.Effect)
	}
	steps, err := s.LatestSteps(ctx, []string{edit.ID})
	if err != nil || steps[edit.ID].ID != redo.ID {
		t.Fatalf("latest = %+v err = %v", steps, err)
	}

	gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"undo_unavailable","message":"this edit can no longer be undone"}`))
	}))
	t.Cleanup(gone.Close)
	s.ConfigureCollaboration(gone.URL, "undo-secret")
	if _, err := s.UndoDocumentEdit(ctx, owner, redo, DocumentOperation{ID: uid("op"), RequestHash: "u3"}); !errors.Is(err, ErrUndoUnavailable) {
		t.Fatalf("step the room no longer holds: %v", err)
	}
}

// A material the chat created carries an Undo that trashes it; that step's
// Undo (Redo) restores it, whose Undo trashes it again. A used step is
// refused.
func TestCreatedMaterialUndoTrashesAndRedoRestores(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "create_owner")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Undo workspace", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	created, ok, err := s.CreateMaterialOperation(ctx, MaterialDraft{
		ID: uid("mat"), ActorUserID: owner, WorkspaceID: ws.ID, Kind: "flashcards", Title: "Cells",
		Cards: [][2]string{{"Cell", "Unit of life"}},
	}, AgentOperation{ID: uid("op"), RequestHash: "c1", ActorUserID: owner, WorkspaceID: ws.ID})
	if err != nil || !ok {
		t.Fatalf("create = %v %v", ok, err)
	}
	material := created.Effect.Resource.ID
	step := func(id string) (AgentOperation, error) {
		t.Helper()
		step, err := s.UndoStep(ctx, id)
		if err != nil {
			t.Fatalf("step %s: %v", id, err)
		}
		return s.UndoFileStep(ctx, owner, step, AgentOperation{ID: uid("op"), RequestHash: "u_" + id})
	}
	trashed, err := step(created.ID)
	if err != nil || trashed.Effect.Operation != agenttools.EffectTrashed || trashed.Effect.Undo == nil {
		t.Fatalf("undo of create = %+v err = %v", trashed.Effect, err)
	}
	var inTrash bool
	if err := s.pool.QueryRow(ctx, `SELECT trashed_at IS NOT NULL FROM materials WHERE id=$1`, material).Scan(&inTrash); err != nil || !inTrash {
		t.Fatalf("trashed = %v err = %v", inTrash, err)
	}
	restored, err := step(trashed.ID)
	if err != nil || restored.Effect.Operation != agenttools.EffectRestored || restored.Effect.Undo == nil {
		t.Fatalf("redo = %+v err = %v", restored.Effect, err)
	}
	// The used step is refused and its trash rolls back.
	if _, err := step(created.ID); !errors.Is(err, ErrUndoUnavailable) {
		t.Fatalf("a used step: %v", err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT trashed_at IS NOT NULL FROM materials WHERE id=$1`, material).Scan(&inTrash); err != nil || inTrash {
		t.Fatalf("trashed by a used step = %v err = %v", inTrash, err)
	}
	again, err := step(restored.ID)
	if err != nil || again.Effect.Operation != agenttools.EffectTrashed {
		t.Fatalf("undo of redo = %+v err = %v", again.Effect, err)
	}
	steps, err := s.LatestSteps(ctx, []string{created.ID})
	if err != nil || steps[created.ID].ID != again.ID {
		t.Fatalf("latest = %+v err = %v", steps, err)
	}
}

// A reloaded conversation shows each chain where it stands and keeps Undo
// only on an edit step a loaded room holds: not on an edit whose room
// unloaded, nor on a created file (Epo 2026-10-20 Q2).
func TestChatHistoryKeepsUndoOnlyForStepsARoomHolds(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "undo_history")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	held := undoTestEdit(t, s, owner, file.ID, true)
	unloaded := undoTestEdit(t, s, owner, file.ID, true)
	undone := undoTestEdit(t, s, owner, file.ID, true)
	created, _, err := s.CreateMaterialOperation(ctx, MaterialDraft{
		ID: uid("mat"), ActorUserID: owner, WorkspaceID: ws.ID, Kind: "flashcards", Title: "Cells",
		Cards: [][2]string{{"Cell", "Unit of life"}},
	}, AgentOperation{ID: uid("op"), RequestHash: "c1", ActorUserID: owner, WorkspaceID: ws.ID})
	if err != nil {
		t.Fatal(err)
	}
	var live, asked []string
	undoTestAuthority(t, s, func() []string { return live }, &asked)
	undo, err := s.UndoDocumentEdit(ctx, owner, undone, DocumentOperation{ID: uid("op"), RequestHash: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	live = []string{held.ID, undo.ID}

	messages := []Message{{Activity: []ActivityBlock{{Effects: []agenttools.ResourceEffect{
		*held.Effect, *unloaded.Effect, *undone.Effect, *created.Effect,
	}}}}}
	if err := s.refreshUndoStatuses(ctx, messages); err != nil {
		t.Fatal(err)
	}
	effects := messages[0].Activity[0].Effects
	if effects[0].Undo == nil || effects[0].Undo.OperationID != held.ID {
		t.Fatalf("held edit = %+v", effects[0])
	}
	if effects[1].Undo != nil {
		t.Fatalf("unloaded edit = %+v", effects[1])
	}
	if effects[2].Operation != agenttools.EffectEditUndone || effects[2].Undo == nil || effects[2].Undo.OperationID != undo.ID {
		t.Fatalf("undone edit = %+v", effects[2])
	}
	if effects[3].Operation != agenttools.EffectCreated || effects[3].Undo != nil {
		t.Fatalf("created file = %+v", effects[3])
	}
	// Only edit steps are asked about.
	slices.Sort(asked)
	want := []string{held.ID, unloaded.ID, undo.ID}
	slices.Sort(want)
	if !slices.Equal(asked, want) {
		t.Fatalf("asked %v want %v", asked, want)
	}
}
