package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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

// undoTestAuthority answers the collaboration service's Undo route with a
// Redo payload (none when `redo` is nil) and records each request's body.
func undoTestAuthority(t *testing.T, s *Store, redo map[string]string, asked *[]map[string]any) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/documents/undo" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		*asked = append(*asked, body)
		var next any
		if redo != nil {
			next = map[string]any{"epoch": 1, "updates": redo}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"undo": next})
	}))
	t.Cleanup(srv.Close)
	s.ConfigureCollaboration(srv.URL, "undo-secret")
}

// undoTestPayload is the payload the collaboration service built for `step`,
// signed as EditDocument signs it.
func undoTestPayload(t *testing.T, s *Store, step AgentOperation, update string) *UndoPayload {
	t.Helper()
	resource := step.Effect.Resource
	signed := s.signUndoPayload(step.ID, DocumentTarget{Kind: resource.Kind, ID: resource.ID},
		&UndoPayload{Epoch: 1, Updates: map[string]string{"source": base64.StdEncoding.EncodeToString([]byte(update))}})
	if signed == nil {
		t.Fatal("the payload was not signed")
	}
	return signed
}

// An edit's Undo sends its payload (without the signature) to the
// collaboration service and records an undo_edit receipt whose own ref is
// the Redo, carrying the Redo payload signed under the receipt's id; Redo's
// receipt is an edit again. An Undo the service builds no Redo for (too
// large, Epo 2026-10-21) records a receipt with no ref and no payload.
func TestDocumentUndoSendsItsPayloadAndReturnsTheRedo(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "undo_payload")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	edit := undoTestEdit(t, s, owner, file.ID)
	var asked []map[string]any
	undoTestAuthority(t, s, map[string]string{"source": base64.StdEncoding.EncodeToString([]byte("redo"))}, &asked)

	undo, err := s.UndoDocumentEdit(ctx, owner, edit, undoTestPayload(t, s, edit, "undo"), DocumentOperation{ID: uid("op"), RequestHash: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	if undo.Kind != "undo_edit" || undo.Effect.Operation != agenttools.EffectEditUndone || undo.Effect.Undo.OperationID != undo.ID {
		t.Fatalf("undo = %+v %+v", undo, undo.Effect)
	}
	sent, _ := asked[0]["undo"].(map[string]any)
	if sent["mac"] != nil || sent["updates"].(map[string]any)["source"] != base64.StdEncoding.EncodeToString([]byte("undo")) {
		t.Fatalf("sent %v", asked[0])
	}
	if undo.UndoPayload == nil || undo.UndoPayload.OperationID != undo.ID ||
		!s.verifyUndoPayload(undo.ID, edit.Effect.Resource, undo.UndoPayload) {
		t.Fatalf("redo payload = %+v", undo.UndoPayload)
	}
	redo, err := s.UndoDocumentEdit(ctx, owner, undo, undo.UndoPayload, DocumentOperation{ID: uid("op"), RequestHash: "u2"})
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

	undoTestAuthority(t, s, nil, &asked)
	last, err := s.UndoDocumentEdit(ctx, owner, redo, redo.UndoPayload, DocumentOperation{ID: uid("op"), RequestHash: "u3"})
	if err != nil {
		t.Fatal(err)
	}
	if last.Effect.Undo != nil || last.UndoPayload != nil {
		t.Fatalf("no Redo payload, yet = %+v %+v", last.Effect, last.UndoPayload)
	}

	gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"undo_unavailable","message":"this edit can no longer be undone"}`))
	}))
	t.Cleanup(gone.Close)
	s.ConfigureCollaboration(gone.URL, "undo-secret")
	edit2 := undoTestEdit(t, s, owner, file.ID)
	if _, err := s.UndoDocumentEdit(ctx, owner, edit2, undoTestPayload(t, s, edit2, "u"), DocumentOperation{ID: uid("op"), RequestHash: "u4"}); !errors.Is(err, ErrUndoUnavailable) {
		t.Fatalf("a payload the service refuses: %v", err)
	}
}

// Security regression (durable Undo payload, Epo 2026-10-21): the browser
// keeps the payload, so it is untrusted when it comes back. Only a payload
// this server signed for this step of this document is sent on: none at all,
// a changed update, a changed epoch, a bad signature, another step's payload
// and one signed for another file are refused before the collaboration
// service is asked. Fails if the signature check goes.
func TestAnUndoPayloadMustCarryTheServersSignature(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "undo_signed")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	_, other := sourceTestFile(t, s, owner, "other.txt", "txt")
	edit := undoTestEdit(t, s, owner, file.ID)
	otherEdit := undoTestEdit(t, s, owner, other.ID)
	var asked []map[string]any
	undoTestAuthority(t, s, nil, &asked)
	tamper := func(change func(*UndoPayload)) *UndoPayload {
		payload := *undoTestPayload(t, s, edit, "undo")
		payload.Updates = map[string]string{"source": payload.Updates["source"]}
		change(&payload)
		return &payload
	}
	forOtherFile := s.signUndoPayload(edit.ID, DocumentTarget{Kind: agenttools.KindSourceFile, ID: other.ID},
		&UndoPayload{Epoch: 1, Updates: map[string]string{"source": base64.StdEncoding.EncodeToString([]byte("undo"))}})
	for name, payload := range map[string]*UndoPayload{
		"none":           nil,
		"changed update": tamper(func(p *UndoPayload) { p.Updates["source"] = base64.StdEncoding.EncodeToString([]byte("undid")) }),
		"changed epoch":  tamper(func(p *UndoPayload) { p.Epoch = 2 }),
		"bad mac":        tamper(func(p *UndoPayload) { p.MAC = strings.Repeat("0", 64) }),
		"another step":   undoTestPayload(t, s, otherEdit, "undo"),
		"another file":   forOtherFile,
	} {
		if _, err := s.UndoDocumentEdit(ctx, owner, edit, payload, DocumentOperation{ID: uid("op"), RequestHash: "u_" + name}); !errors.Is(err, ErrUndoUnavailable) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if len(asked) != 0 {
		t.Fatalf("the collaboration service was asked: %v", asked)
	}
	if _, err := s.UndoDocumentEdit(ctx, owner, edit, undoTestPayload(t, s, edit, "undo"), DocumentOperation{ID: uid("op"), RequestHash: "u_ok"}); err != nil {
		t.Fatalf("the signed payload: %v", err)
	}
}

// Epo 2026-10-21 (Editor): a payload passes through in transit only. After
// an edit's Undo, no agent_operations row holds the payload's update, the
// Redo payload's or a signature. Fails if a receipt stores its payload.
func TestUndoPayloadsAreNeverStored(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "undo_unstored")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	edit := undoTestEdit(t, s, owner, file.ID)
	redoUpdate := base64.StdEncoding.EncodeToString([]byte("redo-payload-bytes"))
	var asked []map[string]any
	undoTestAuthority(t, s, map[string]string{"source": redoUpdate}, &asked)
	payload := undoTestPayload(t, s, edit, "undo-payload-bytes")
	undo, err := s.UndoDocumentEdit(ctx, owner, edit, payload, DocumentOperation{ID: uid("op"), RequestHash: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	var rows string
	if err := s.pool.QueryRow(ctx, `SELECT string_agg(row_to_json(a)::text, '') FROM agent_operations a WHERE id = ANY($1)`,
		[]string{edit.ID, undo.ID}).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	for _, held := range []string{payload.Updates["source"], payload.MAC, redoUpdate, undo.UndoPayload.MAC, "undoPayload"} {
		if strings.Contains(rows, held) {
			t.Fatalf("a receipt row holds %q: %s", held, rows)
		}
	}
}

// A reloaded conversation shows each chain where it stands. An edit step
// keeps its Undo ref, the browser offering it while it holds the step's
// payload (Epo 2026-10-21); a created file loses it (Epo 2026-10-20 Q2).
func TestChatHistoryKeepsUndoOnEditSteps(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "undo_history")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	held := undoTestEdit(t, s, owner, file.ID)
	undone := undoTestEdit(t, s, owner, file.ID)
	created, _, err := s.CreateMaterialOperation(ctx, MaterialDraft{
		ID: uid("mat"), ActorUserID: owner, WorkspaceID: ws.ID, Kind: "flashcards", Title: "Cells",
		Cards: [][2]string{{"Cell", "Unit of life"}},
	}, AgentOperation{ID: uid("op"), RequestHash: "c1", ActorUserID: owner, WorkspaceID: ws.ID})
	if err != nil {
		t.Fatal(err)
	}
	var asked []map[string]any
	undoTestAuthority(t, s, map[string]string{"source": base64.StdEncoding.EncodeToString([]byte("redo"))}, &asked)
	undo, err := s.UndoDocumentEdit(ctx, owner, undone, undoTestPayload(t, s, undone, "undo"), DocumentOperation{ID: uid("op"), RequestHash: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	messages := []Message{{Activity: []ActivityBlock{{Effects: []agenttools.ResourceEffect{
		*held.Effect, *undone.Effect, *created.Effect,
	}}}}}
	if err := s.refreshUndoStatuses(ctx, messages); err != nil {
		t.Fatal(err)
	}
	effects := messages[0].Activity[0].Effects
	if effects[0].Undo == nil || effects[0].Undo.OperationID != held.ID {
		t.Fatalf("edit = %+v", effects[0])
	}
	if effects[1].Operation != agenttools.EffectEditUndone || effects[1].Undo == nil || effects[1].Undo.OperationID != undo.ID {
		t.Fatalf("undone edit = %+v", effects[1])
	}
	if effects[2].Operation != agenttools.EffectCreated || effects[2].Undo != nil {
		t.Fatalf("created file = %+v", effects[2])
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
