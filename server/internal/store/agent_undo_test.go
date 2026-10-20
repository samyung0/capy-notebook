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

// undoTestEdit commits a text source edit through its checkpoint, then puts
// the Undo ref on its receipt as the collaboration service does once the
// live room took it.
func undoTestEdit(t *testing.T, s *Store, owner, fileID string) AgentOperation {
	t.Helper()
	ctx := context.Background()
	doc := sourceTestSeed(t, s, owner, fileID)
	save := sourceTestSave(doc, owner, "edited")
	save.Operation = &SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: uid("op"), ToolVersion: 1, RequestHash: "h", ActorUserID: owner},
	}
	saved, err := s.SaveSourceCheckpoint(ctx, fileID, save)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Operation.Effect.Undo != nil {
		t.Fatalf("a checkpoint set the Undo ref: %+v", saved.Operation.Effect)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE agent_operations SET effect = jsonb_set(effect, '{undo}', $2) WHERE id=$1`,
		saved.Operation.ID, agenttools.UndoRef{OperationID: saved.Operation.ID, Status: agenttools.UndoAvailable}); err != nil {
		t.Fatal(err)
	}
	op, err := getAgentOperation(ctx, s.pool, saved.Operation.ID)
	if err != nil {
		t.Fatal(err)
	}
	return *op
}

// undoTestAuthority answers the collaboration service's Undo routes: every
// Undo lands under the id `kept` gives (the request's when it gives ""), and
// undo-status names the steps in `live`. It counts the Undos it was asked.
func undoTestAuthority(t *testing.T, s *Store, live func() []string, asked *[]string) *int {
	t.Helper()
	return undoTestAuthorityKeeping(t, s, live, asked, func(string) string { return "" })
}

func undoTestAuthorityKeeping(t *testing.T, s *Store, live func() []string, asked *[]string, kept func(step string) string) *int {
	t.Helper()
	undos := new(int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/documents/undo":
			var body struct {
				UndoOf    string            `json:"undoOf"`
				Operation DocumentOperation `json:"operation"`
				Target    DocumentTarget    `json:"target"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			*undos++
			id := kept(body.UndoOf)
			if id == "" {
				id = body.Operation.ID
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"operationId": id})
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
	return undos
}

// A step whose Undo landed in the room but whose receipt was not written (a
// lost answer, a failed insert) ends with one receipt: the room answers the
// next request with the id it kept the reverse under, the receipt takes that
// id, and the step's receipt is then found for any later request.
func TestALostUndoAnswerEndsWithOneReceipt(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "undo_lost")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	edit := undoTestEdit(t, s, owner, file.ID)
	earlier := uid("op")
	var asked []string
	undoTestAuthorityKeeping(t, s, func() []string { return nil }, &asked, func(string) string { return earlier })
	if _, err := s.UndoReceipt(ctx, edit.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("receipt of an unused step: %v", err)
	}
	undo, err := s.UndoDocumentEdit(ctx, owner, edit, DocumentOperation{ID: uid("op"), RequestHash: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	if undo.ID != earlier || undo.Effect.Undo.OperationID != earlier {
		t.Fatalf("receipt %s (ref %+v), want the room's %s", undo.ID, undo.Effect.Undo, earlier)
	}
	found, err := s.UndoReceipt(ctx, edit.ID)
	if err != nil || found.ID != earlier {
		t.Fatalf("step's receipt = %+v err = %v", found, err)
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
	edit := undoTestEdit(t, s, owner, file.ID)
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
	held := undoTestEdit(t, s, owner, file.ID)
	unloaded := undoTestEdit(t, s, owner, file.ID)
	undone := undoTestEdit(t, s, owner, file.ID)
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
