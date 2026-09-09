package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// A source edit checkpoint commits its receipt and inverse together: the
// owner is charged the inverse bytes, Undo is available exactly once and a
// trash releases it. This is the Go-owned half of the direct edit contract;
// the authority side lives in the collaboration tests.
func TestSourceEditCheckpointReceiptAndUndo(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "edit_owner")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	doc := sourceTestSeed(t, s, owner, file.ID)
	usedBefore := userUsedBytes(t, s, owner)

	// States keep the seed's byte length so used-bytes deltas isolate the inverse charge.
	inverse := json.RawMessage(`{"commands":[{"type":"replace_text","expectedText":"new","text":"old","offset":0}]}`)
	guards := json.RawMessage(`[{"kind":"text","offset":0,"length":3,"runs":[{"client":1,"clock":0,"len":3}]}]`)
	edit := SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: "op_edit_" + file.ID[:8], ToolVersion: 1, RequestHash: "h1", ActorUserID: owner},
		Inverse: inverse, Guards: guards,
	}
	saved, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, ExpectedCheckpoint: doc.Checkpoint, State: []byte("edited!-state"),
		PendingEffects: json.RawMessage(`[{"type":"text","before":"old","after":"new"}]`), Operation: &edit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Operation == nil || saved.Operation.Effect == nil || saved.Operation.Effect.Operation != agenttools.EffectEdited {
		t.Fatalf("receipt = %+v", saved.Operation)
	}
	if saved.Operation.Effect.Undo == nil || saved.Operation.Effect.Undo.Status != agenttools.UndoAvailable {
		t.Fatalf("undo ref = %+v", saved.Operation.Effect.Undo)
	}
	inv, op, err := s.GetEditInverse(ctx, edit.Receipt.ID)
	if err != nil || op.ID != edit.Receipt.ID || inv.OwnerUserID != owner || inv.WorkspaceID != ws.ID {
		t.Fatalf("inverse = %+v op = %+v err = %v", inv, op, err)
	}
	charged := userUsedBytes(t, s, owner) - usedBefore
	if charged < int64(len(inverse)+len(guards)) {
		t.Fatalf("owner charged %d bytes for a %d byte inverse", charged, len(inverse)+len(guards))
	}

	// Replaying the same receipt returns the recorded operation without a new checkpoint.
	replayed, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, ExpectedCheckpoint: doc.Checkpoint, State: []byte("edited!-state"),
		PendingEffects: json.RawMessage(`[]`), Operation: &edit,
	})
	if err != nil || replayed.Checkpoint != saved.Checkpoint || replayed.Operation == nil || replayed.Operation.ID != edit.Receipt.ID {
		t.Fatalf("replay = %+v err = %v", replayed, err)
	}

	undo := SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: "op_undo_" + file.ID[:8], ToolVersion: 1, RequestHash: "h2", ActorUserID: owner},
		UndoOf:  edit.Receipt.ID,
	}
	undone, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: saved.Epoch, ExpectedCheckpoint: saved.Checkpoint, State: []byte("undone--state"),
		PendingEffects: json.RawMessage(`[]`), Operation: &undo,
	})
	if err != nil {
		t.Fatal(err)
	}
	if undone.Operation == nil || undone.Operation.Effect == nil || undone.Operation.Effect.Operation != agenttools.EffectEditUndone {
		t.Fatalf("undo receipt = %+v", undone.Operation)
	}
	statuses, err := s.UndoStatuses(ctx, []string{edit.Receipt.ID})
	if err != nil || statuses[edit.Receipt.ID].Status != agenttools.UndoUndone {
		t.Fatalf("statuses = %+v err = %v", statuses, err)
	}
	if got := userUsedBytes(t, s, owner); got != usedBefore {
		t.Fatalf("inverse bytes not released: used %d want %d", got, usedBefore)
	}
	// A second Undo of the same edit is refused.
	_, err = s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: undone.Epoch, ExpectedCheckpoint: undone.Checkpoint, State: []byte("undone--state"),
		PendingEffects: json.RawMessage(`[]`),
		Operation:      &SourceCheckpointOperation{Receipt: SourceCheckpointReceipt{ID: "op_undo2_" + file.ID[:8], ToolVersion: 1, RequestHash: "h3", ActorUserID: owner}, UndoOf: edit.Receipt.ID},
	})
	if !errors.Is(err, ErrUndoUnavailable) {
		t.Fatalf("second undo err = %v", err)
	}
}

func TestTrashReleasesAvailableUndo(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "edit_owner")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	doc := sourceTestSeed(t, s, owner, file.ID)
	edit := SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: "op_trash_" + file.ID[:8], ToolVersion: 1, RequestHash: "h1", ActorUserID: owner},
		Inverse: json.RawMessage(`{"commands":[]}`), Guards: json.RawMessage(`[]`),
	}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, ExpectedCheckpoint: doc.Checkpoint, State: []byte("new"),
		PendingEffects: json.RawMessage(`[]`), Operation: &edit,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TrashFile(ctx, owner, file.ID, AgentOperation{ID: "req_trash_" + file.ID[:8], RequestHash: "h2"}); err != nil {
		t.Fatal(err)
	}
	inv, _, err := s.GetEditInverse(ctx, edit.Receipt.ID)
	if err != nil || inv.UndoStatus != agenttools.UndoUnavailable || inv.UndoReason == "" {
		t.Fatalf("inverse after trash = %+v err = %v", inv, err)
	}
}

// A removed flashcard keeps its study state through Undo: the restoration is
// applied by the projection that first shows the card again at or after the
// Undo version, exactly once, and never over progress recorded later.
func TestCardStateRestoreAppliesOnceWhenTheCardReappears(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "restore_owner")
	ws, err := s.CreateWorkspace(ctx, owner, "Restore workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	cards := []materialdoc.Card{{ID: uid("card"), Front: "a", Back: "A"}, {ID: uid("card"), Front: "b", Back: "B"}}
	both, err := materialdoc.FlashcardsDocument(cards)
	if err != nil {
		t.Fatal(err)
	}
	onlySecond, err := materialdoc.FlashcardsDocument(cards[1:])
	if err != nil {
		t.Fatal(err)
	}
	mt, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "flashcards", Title: "Restore", Content: both})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents (material_id, state, stored_version) VALUES ($1, '\x00'::bytea, 5)`, mt.ID); err != nil {
		t.Fatal(err)
	}
	studied := `{"reps": 3, "due": "2026-01-01T00:00:00Z"}`
	if _, err := s.pool.Exec(ctx, `UPDATE card_stats SET known=true, srs=$2::jsonb WHERE card_id=$1`, cards[0].ID, studied); err != nil {
		t.Fatal(err)
	}
	// The agent removes the first card; the projection drops its study row.
	if _, err := s.ProjectMaterialContent(ctx, mt.ID, onlySecond, 2); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM card_stats WHERE card_id=$1`, cards[0].ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("removed card study row count = %d err = %v", count, err)
	}
	// Undo re-inserts the card at version 3 and files the retained state.
	opID := "op_restore_" + mt.ID[:8]
	if _, err := s.pool.Exec(ctx, `INSERT INTO agent_operations (id, kind, tool_version, request_hash, actor_user_id, workspace_id, outcome)
		VALUES ($1,'undo_edit',1,'h',$2,$3,'succeeded')`, opID, owner, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO agent_card_state_restores (operation_id, material_id, card_id, srs, known, restore_at_version)
		VALUES ($1,$2,$3,$4::jsonb,true,3)`, opID, mt.ID, cards[0].ID, studied); err != nil {
		t.Fatal(err)
	}
	// A projection at the Undo version that still lacks the card (a lagging
	// replica) keeps the restoration pending.
	if _, err := s.ProjectMaterialContent(ctx, mt.ID, onlySecond, 3); err != nil {
		t.Fatal(err)
	}
	var applied *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT applied_at FROM agent_card_state_restores WHERE operation_id=$1`, opID).Scan(&applied); err != nil || applied != nil {
		t.Fatalf("restoration applied early: %v err = %v", applied, err)
	}
	if _, err := s.ProjectMaterialContent(ctx, mt.ID, both, 4); err != nil {
		t.Fatal(err)
	}
	var known bool
	var reps int
	if err := s.pool.QueryRow(ctx, `SELECT known, (srs->>'reps')::int FROM card_stats WHERE card_id=$1`, cards[0].ID).Scan(&known, &reps); err != nil || !known || reps != 3 {
		t.Fatalf("restored state known=%v reps=%d err=%v", known, reps, err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT applied_at FROM agent_card_state_restores WHERE operation_id=$1`, opID).Scan(&applied); err != nil || applied == nil {
		t.Fatalf("restoration not marked applied: err = %v", err)
	}
	// Later progress survives a repeated projection.
	if _, err := s.pool.Exec(ctx, `UPDATE card_stats SET srs='{"reps": 4, "due": "2026-02-01T00:00:00Z"}'::jsonb WHERE card_id=$1`, cards[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProjectMaterialContent(ctx, mt.ID, both+" ", 5); err != nil && !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT (srs->>'reps')::int FROM card_stats WHERE card_id=$1`, cards[0].ID).Scan(&reps); err != nil || reps != 4 {
		t.Fatalf("later progress overwritten: reps=%d err=%v", reps, err)
	}
}
