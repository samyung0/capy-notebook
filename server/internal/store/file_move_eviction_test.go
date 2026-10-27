package store

import (
	"context"
	"encoding/json"
	"testing"
)

// Q447 and Q454 (Epo 2026-10-27): a Move drains the moved file's open source
// room, so the room stores what it admitted before it closes, and its tabs
// hear the move with the target workspace first. Fails if the Move enqueues
// a discard, or an eviction that does not name the move.
func TestMoveDrainsTheSourceRoomAndNamesTheTargetWorkspace(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_move_evict_owner")
	src, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	dst, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	file := uploadWorkspaceFile(t, s, owner, src.ID)
	if _, err := s.pool.Exec(ctx, `INSERT INTO source_documents (user_id, file_id, format, epoch, base_revision, base_blob_path)
		VALUES ($1, $2, 'text', 3, 1, 'p')`, owner, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveFiles(ctx, owner, []string{file.ID}, MoveTarget{WorkspaceID: dst.ID}, false); err != nil {
		t.Fatal(err)
	}
	rows, err := s.pool.Query(ctx, `SELECT id, channel, payload FROM collaboration_eviction_outbox WHERE payload->>'fileId'=$1`, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var events []map[string]string
	for rows.Next() {
		var id, channel string
		var raw []byte
		if err := rows.Scan(&id, &channel, &raw); err != nil {
			t.Fatal(err)
		}
		var payload map[string]string
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		if channel != "capy:collaboration:evict" || payload["evictionId"] != id {
			t.Fatalf("eviction row %s on %s: %v", id, channel, payload)
		}
		events = append(events, payload)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"type": "file-moved", "mode": "drain", "workspaceId": dst.ID,
		"fileId": file.ID, "room": "source:" + file.ID + ":epoch:3",
	}
	if len(events) != 1 {
		t.Fatalf("evictions = %v, want one", events)
	}
	for key, value := range want {
		if events[0][key] != value {
			t.Fatalf("eviction %s = %q, want %q (%v)", key, events[0][key], value, events[0])
		}
	}
}
