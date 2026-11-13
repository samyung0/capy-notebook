package store

import (
	"context"
	"testing"
)

func TestStorageLimitsUseDecimalBytes(t *testing.T) {
	s := openAccessTestStore(t)
	if got := mustPlanLimits(t, s, PlanFree).StorageBytes; got != 100_000_000 {
		t.Fatalf("free storage limit = %d, want 100000000", got)
	}
	if got := mustPlanLimits(t, s, PlanPro).StorageBytes; got != 1_000_000_000 {
		t.Fatalf("Pro storage limit = %d, want 1000000000", got)
	}
}

// Billing's three storage rows (Epo 2026-11-13): a set and its attachment are
// Files, the set's image is Images, a canvas with its board and image is
// Canvas, and the three add up to what the meter recounts.
func TestStorageBreakdownSplitsFilesImagesAndCanvas(t *testing.T) {
	f := newStudyFixture(t, "breakdown")
	ctx := context.Background()
	canvas, err := f.s.CreateCanvas(ctx, f.user, "Board", f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	readyAsset(t, f.s, canvas.ID, f.user, "board")
	readyAsset(t, f.s, canvas.ID, f.user, "image")
	set := f.set(t, [2]string{"Q", "A"})[0].MaterialID
	readyAsset(t, f.s, set, f.user, "image")
	readyAsset(t, f.s, set, f.user, "file")

	b, err := f.s.storageBreakdown(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	var setBytes, canvasBytes, used, reserved int64
	if err := f.s.pool.QueryRow(ctx, `SELECT
		(SELECT size_bytes FROM materials WHERE id=$1), (SELECT size_bytes FROM materials WHERE id=$2)`,
		set, canvas.ID).Scan(&setBytes, &canvasBytes); err != nil {
		t.Fatal(err)
	}
	if err := f.s.pool.QueryRow(ctx, storageRecountSQL, f.user).Scan(&used, &reserved); err != nil {
		t.Fatal(err)
	}
	want := StorageBreakdown{FilesBytes: setBytes + 10, ImagesBytes: 10, CanvasBytes: canvasBytes + 20}
	if b != want || b.FilesBytes+b.ImagesBytes+b.CanvasBytes != used {
		t.Fatalf("breakdown %+v, want %+v adding up to %d", b, want, used)
	}
}
