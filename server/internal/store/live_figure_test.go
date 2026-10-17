package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// TestNoteContentWritesTakeLiveFigures (Epo 2026-10-18): a whole-document
// note write through the content API takes the room's live policy, so a note
// holding what a merge of two editors left (here a pie with a second series)
// creates and updates, while an agent's block write of the same pie is
// refused (ParseWrite, which the agent's note and edit blocks go through).
func TestNoteContentWritesTakeLiveFigures(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_live_figure")
	pie := func(title string) string {
		raw, err := json.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
			{"type": "p", "id": "p1", "children": []any{map[string]any{"text": title}}},
			{"type": "chart", "id": "f1", "children": []any{map[string]any{"text": ""}}, "block": map[string]any{
				"type": "chart", "kind": "pie", "title": "Share", "labels": []any{"a", "b"},
				"series": []any{
					map[string]any{"name": "S", "values": []any{1, 2}},
					map[string]any{"name": "R", "values": []any{3, 4}},
				},
			}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: ownerID, Kind: "note", Title: "Merged", Content: pie("before")})
	if err != nil {
		t.Fatalf("a note holding a two-series pie is not created: %v", err)
	}
	updated := pie("after")
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &updated, UpdatedBy: ownerID}); err != nil {
		t.Fatalf("a note holding a two-series pie does not update: %v", err)
	}
	if _, err := materialdoc.ParseWrite(updated); !errors.Is(err, materialdoc.ErrInvalid) {
		t.Fatalf("an agent's block write of the pie is taken: %v", err)
	}
}
