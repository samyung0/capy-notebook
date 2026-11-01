package httpapi

import (
	"context"
	"testing"
)

// A batch that finds every slot taken is skipped before it reads its images:
// the room stays small and nothing waits for a slot (Sam 2026-10-29).
func TestEditorImageThumbnailsSkipAFullRoom(t *testing.T) {
	a := &api{assetThumbs: make(chan struct{}, 1)}
	a.assetThumbs <- struct{}{}
	read := false
	a.thumbnailEditorImages(context.Background(), []editorImage{{"asset_x", func() ([]byte, error) {
		read = true
		return nil, nil
	}}})
	if read || len(a.assetThumbs) != 1 {
		t.Fatalf("a full room read the image (%v) or took a slot (%d in use)", read, len(a.assetThumbs))
	}
}
