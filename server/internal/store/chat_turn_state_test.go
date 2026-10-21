package store

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// A crash mid-turn leaves the streaming row with its last turn checkpoint;
// the boot sweep keeps it and adds the receipts (Epo 2026-10-21).
func TestAbortOrphanedStreamsKeepsTheLastTurnCheckpoint(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, userID, WorkspaceCreate{Name: "Crash"})
	if err != nil {
		t.Fatal(err)
	}
	conv, err := s.CreateConversation(ctx, userID, ws.ID, "crash")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := reg.ResolveUser(ctx, flashModelRef, models.SlotChat)
	if err != nil {
		t.Fatal(err)
	}
	assistant, err := s.StartAssistantMessage(ctx, userID, conv.ID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	activity := []ActivityBlock{{ID: "c1", Kind: "tool", CallID: "c1", Name: "list_sources", Outcome: "succeeded"}}
	evidence := json.RawMessage(`{"tools":[{"name":"list_sources","text":"checkpoint listing"}],"passages":[],"skills":[]}`)
	if err := s.CheckpointAssistantMessage(ctx, assistant.ID, activity, evidence); err != nil {
		t.Fatal(err)
	}
	// A write after the checkpoint: only its receipt survived the crash.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO agent_operations (id, kind, request_hash, workspace_id, conversation_id, message_id, call_id, outcome, effect)
		VALUES ($1, 'create_material', 'h', $2, $3, $4, 'c2', 'succeeded',
		        '{"operation":"created","resource":{"kind":"material","id":"mat_crash","title":"Note"}}')`,
		"op_crash_"+assistant.ID, ws.ID, conv.ID, assistant.ID); err != nil {
		t.Fatal(err)
	}

	if err := s.AbortOrphanedStreams(ctx); err != nil {
		t.Fatal(err)
	}

	var (
		status string
		raw    []byte
	)
	if err := s.pool.QueryRow(ctx, `SELECT status, metadata FROM messages WHERE id=$1`, assistant.ID).Scan(&status, &raw); err != nil {
		t.Fatal(err)
	}
	var meta msgMetadata
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	var saved, want any
	_ = json.Unmarshal(meta.ToolEvidence, &saved)
	_ = json.Unmarshal(evidence, &want)
	if status != "aborted" || len(meta.Activity) != 2 || meta.Activity[0].CallID != "c1" ||
		meta.Activity[1].CallID != "c2" || !reflect.DeepEqual(saved, want) {
		t.Fatalf("aborted turn = %s %+v, evidence %v", status, meta.Activity, saved)
	}
}
