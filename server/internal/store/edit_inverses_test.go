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
// owner is charged the inverse bytes, Undo is available exactly once, the
// Undo stores the Redo, and the chain's latest step is what history shows. This is the Go-owned half of the direct edit contract;
// the authority side lives in the collaboration tests.
func TestSourceEditCheckpointReceiptAndUndo(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "edit_owner")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	doc := sourceTestSeed(t, s, owner, file.ID)
	usedBefore := userUsedBytes(t, s, owner)

	// The first save reports a seed as long as its row; the rows saved after
	// it are charged with the source, so the check below takes them out.
	inverse := json.RawMessage(`{"commands":[{"type":"replace_text","expectedText":"new","text":"old","offset":0}]}`)
	guards := json.RawMessage(`[{"kind":"text","offset":0,"length":3,"runs":[{"client":1,"clock":0,"len":3}]}]`)
	edit := SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: "op_edit_" + file.ID[:8], ToolVersion: 1, RequestHash: "h1", ActorUserID: owner},
		Inverse: inverse, Guards: guards,
	}
	saved, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: doc.Checkpoint, Update: []byte("edited!-state"),
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
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: doc.Checkpoint, Update: []byte("edited!-state"),
		PendingEffects: json.RawMessage(`[]`), Operation: &edit,
	})
	if err != nil || replayed.Checkpoint != saved.Checkpoint || replayed.Operation == nil || replayed.Operation.ID != edit.Receipt.ID {
		t.Fatalf("replay = %+v err = %v", replayed, err)
	}

	// The Undo stores its own inverse and guards: its Undo is Redo.
	redoInverse := json.RawMessage(`{"commands":[{"type":"replace_text","expectedText":"old","text":"new","offset":0}]}`)
	undo := SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: "op_undo_" + file.ID[:8], ToolVersion: 1, RequestHash: "h2", ActorUserID: owner},
		UndoOf:  edit.Receipt.ID, Inverse: redoInverse, Guards: guards,
	}
	undone, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: saved.Checkpoint, Update: []byte("undone--state"),
		PendingEffects: json.RawMessage(`[]`), Operation: &undo,
	})
	if err != nil {
		t.Fatal(err)
	}
	if e := undone.Operation.Effect; e.Operation != agenttools.EffectEditUndone || e.Undo == nil || e.Undo.OperationID != undo.Receipt.ID {
		t.Fatalf("undo receipt effect = %+v", e)
	}
	// History shows the chain's latest step: the edit_undone effect with its Redo.
	steps, err := s.LatestSteps(ctx, []string{edit.Receipt.ID})
	if err != nil {
		t.Fatal(err)
	}
	latest := steps[edit.Receipt.ID]
	if latest.Effect == nil || latest.Effect.Operation != agenttools.EffectEditUndone || latest.Undo == nil ||
		latest.Undo.OperationID != undo.Receipt.ID || latest.Undo.Status != agenttools.UndoAvailable {
		t.Fatalf("latest after undo = %+v", latest)
	}
	var sourceBytes int64
	if err = s.pool.QueryRow(ctx, `SELECT storage_bytes FROM source_documents WHERE file_id=$1`, file.ID).Scan(&sourceBytes); err != nil {
		t.Fatal(err)
	}
	// The edit's inverse is released and the Redo's charged instead.
	if got, want := userUsedBytes(t, s, owner), usedBefore+sourceBytes+int64(len(redoInverse)+len(guards)); got != want {
		t.Fatalf("used %d want %d", got, want)
	}
	// A second Undo of the same edit is refused.
	_, err = s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: undone.Checkpoint, Update: []byte("undone--state"),
		PendingEffects: json.RawMessage(`[]`),
		Operation:      &SourceCheckpointOperation{Receipt: SourceCheckpointReceipt{ID: "op_undo2_" + file.ID[:8], ToolVersion: 1, RequestHash: "h3", ActorUserID: owner}, UndoOf: edit.Receipt.ID},
	})
	if !errors.Is(err, ErrUndoUnavailable) {
		t.Fatalf("second undo err = %v", err)
	}
	// Redo is the edit again, with an Undo of its own.
	redo := SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: "op_redo_" + file.ID[:8], ToolVersion: 1, RequestHash: "h4", ActorUserID: owner},
		UndoOf:  undo.Receipt.ID, Inverse: inverse, Guards: guards,
	}
	redone, err := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: undone.Checkpoint, Update: []byte("redone--state"),
		PendingEffects: json.RawMessage(`[]`), Operation: &redo,
	})
	if err != nil {
		t.Fatal(err)
	}
	if e := redone.Operation.Effect; e.Operation != agenttools.EffectEdited || e.Undo == nil || e.Undo.OperationID != redo.Receipt.ID {
		t.Fatalf("redo receipt effect = %+v", e)
	}
	if steps, err = s.LatestSteps(ctx, []string{edit.Receipt.ID}); err != nil {
		t.Fatal(err)
	}
	if latest := steps[edit.Receipt.ID]; latest.Effect == nil || latest.Effect.Operation != agenttools.EffectEdited || latest.Undo.OperationID != redo.Receipt.ID {
		t.Fatalf("latest after redo = %+v", latest)
	}
	// A rebase releases the chain's latest step like any edit's Undo.
	if err := s.InvalidateEditInverses(ctx, agenttools.KindSourceFile, file.ID, "source_rebased"); err != nil {
		t.Fatal(err)
	}
	if steps, err = s.LatestSteps(ctx, []string{edit.Receipt.ID}); err != nil {
		t.Fatal(err)
	}
	if latest := steps[edit.Receipt.ID]; latest.Undo == nil || latest.Undo.Status != agenttools.UndoUnavailable {
		t.Fatalf("latest after rebase = %+v", latest)
	}
}

// A material the chat created carries an Undo that trashes it; that step's
// Undo (Redo) restores it, whose Undo trashes it again. A rebase leaves the
// steps alone, a purge releases them.
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
	if created.Effect.Undo == nil || created.Effect.Undo.OperationID != created.ID {
		t.Fatalf("created effect = %+v", created.Effect)
	}
	// A rebase or compaction does not release a file step.
	if err := s.InvalidateEditInverses(ctx, agenttools.KindMaterial, material, "compacted"); err != nil {
		t.Fatal(err)
	}
	step := func(id string) AgentOperation {
		t.Helper()
		inv, _, err := s.GetEditInverse(ctx, id)
		if err != nil || inv.UndoStatus != agenttools.UndoAvailable {
			t.Fatalf("step %s = %+v err = %v", id, inv, err)
		}
		receipt, err := s.UndoFileStep(ctx, owner, inv, AgentOperation{ID: uid("op"), RequestHash: "u_" + id})
		if err != nil {
			t.Fatal(err)
		}
		return receipt
	}
	trashed := step(created.ID)
	if trashed.Effect.Operation != agenttools.EffectTrashed || trashed.Effect.Undo == nil {
		t.Fatalf("undo of create = %+v", trashed.Effect)
	}
	var inTrash bool
	if err := s.pool.QueryRow(ctx, `SELECT trashed_at IS NOT NULL FROM materials WHERE id=$1`, material).Scan(&inTrash); err != nil || !inTrash {
		t.Fatalf("trashed = %v err = %v", inTrash, err)
	}
	restored := step(trashed.ID)
	if restored.Effect.Operation != agenttools.EffectRestored || restored.Effect.Undo == nil {
		t.Fatalf("redo = %+v", restored.Effect)
	}
	again := step(restored.ID)
	if again.Effect.Operation != agenttools.EffectTrashed {
		t.Fatalf("undo of redo = %+v", again.Effect)
	}
	steps, err := s.LatestSteps(ctx, []string{created.ID})
	if err != nil {
		t.Fatal(err)
	}
	if latest := steps[created.ID]; latest.Effect == nil || latest.Effect.Operation != agenttools.EffectTrashed ||
		latest.Undo == nil || latest.Undo.OperationID != again.ID || latest.Undo.Status != agenttools.UndoAvailable {
		t.Fatalf("latest = %+v", latest)
	}
	// The used step is refused; a purge releases the one left.
	inv, _, err := s.GetEditInverse(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UndoFileStep(ctx, owner, inv, AgentOperation{ID: uid("op"), RequestHash: "again"}); err == nil {
		t.Fatal("a used step undid twice")
	}
	if _, err := s.PurgeTrashed(ctx, owner, agenttools.KindMaterial, material, again.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	if steps, err = s.LatestSteps(ctx, []string{created.ID}); err != nil {
		t.Fatal(err)
	}
	if latest := steps[created.ID]; latest.Undo == nil || latest.Undo.Status != agenttools.UndoUnavailable {
		t.Fatalf("latest after purge = %+v", latest)
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
		ActorIDs: []string{owner}, Epoch: doc.Epoch, BaseRevision: doc.BaseRevision, ExpectedCheckpoint: doc.Checkpoint, Update: []byte("new"),
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
