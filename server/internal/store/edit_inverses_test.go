package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
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

	// The first save reports a seed as long as its state, so used-bytes deltas
	// isolate the inverse charge.
	inverse := json.RawMessage(`{"commands":[{"type":"replace_text","expectedText":"new","text":"old","offset":0}]}`)
	guards := json.RawMessage(`[{"kind":"text","offset":0,"length":3,"runs":[{"client":1,"clock":0,"len":3}]}]`)
	edit := SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: "op_edit_" + file.ID[:8], ToolVersion: 1, RequestHash: "h1", ActorUserID: owner},
		Inverse: inverse, Guards: guards,
	}
	saved, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: doc.Checkpoint, State: []byte("edited!-state"),
		PendingEffects: json.RawMessage(`[{"type":"text","before":"old","after":"new"}]`), Operation: &edit,
		SeedBytes: int64(len("edited!-state")), BaseSourceSHA256: strings.Repeat("a", 64),
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
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: doc.Checkpoint, State: []byte("edited!-state"),
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
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: saved.Checkpoint, State: []byte("undone--state"),
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
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: undone.Checkpoint, State: []byte("undone--state"),
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
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: doc.Checkpoint, State: []byte("new"),
		PendingEffects: json.RawMessage(`[]`), Operation: &edit, SeedBytes: sourceTestSeedBytes, BaseSourceSHA256: strings.Repeat("a", 64),
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
