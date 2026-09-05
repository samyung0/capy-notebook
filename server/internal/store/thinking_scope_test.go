package store

import (
	"context"
	"errors"
	"testing"
)

func TestCanvasReadAndSaveAreOwnerScoped(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_canvas_owner")
	otherID := newBlobTestUser(t, s, "u_canvas_other")
	canvas, err := s.CreateCanvas(ctx, ownerID, "Private canvas")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetCanvas(ctx, otherID, canvas.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user read error = %v, want not found", err)
	}
	name := "Stolen"
	if _, err := s.SaveCanvas(ctx, otherID, canvas.ID, &name, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user save error = %v, want not found", err)
	}
	got, err := s.GetCanvas(ctx, ownerID, canvas.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Private canvas" {
		t.Fatalf("cross-user save changed name to %q", got.Name)
	}
}

func TestCanvasWriteRejectsSuspendedOwner(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_canvas_suspended")
	canvas, err := s.CreateCanvas(ctx, ownerID, "Canvas")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET
		suspended_at=now(), suspended_reason='test' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	name := "Blocked"
	if _, err := s.SaveCanvas(ctx, ownerID, canvas.ID, &name, nil); err == nil {
		t.Fatal("suspended owner saved a canvas")
	}
}
