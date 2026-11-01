package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// awaitAssetThumbnail reads an asset's thumbnail key once it lands after the
// response, waiting the room's window and no more.
func awaitAssetThumbnail(t *testing.T, st *store.Store, assetID string) string {
	t.Helper()
	var key string
	for deadline := time.Now().Add(5 * time.Second); key == "" && time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if err := st.Pool().QueryRow(context.Background(), `SELECT COALESCE(thumbnail_key,'')
			FROM editor_assets WHERE id=$1`, assetID).Scan(&key); err != nil {
			t.Fatal(err)
		}
	}
	return key
}

// An uploaded editor image gets its card thumbnail in the background, one
// attempt (Sam 2026-10-29), and the Embeds list signs it for its payer.
func TestEditorImageUploadMakesItsThumbnail(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	note := uploadNote(t, th, ws)
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewNRGBA(image.Rect(0, 0, 800, 600))); err != nil {
		t.Fatal(err)
	}
	meta := map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": picture.Len(), "contentType": "image/png"}
	rec := postUpload(t, th.h, "/api/materials/"+note+"/editor-assets/uploads", "u_owner", meta, "image/png", picture.Bytes())
	expectStatus(t, rec, http.StatusCreated, "an editor image")
	var asset struct {
		ID string `json:"assetId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &asset); err != nil {
		t.Fatal(err)
	}

	key := awaitAssetThumbnail(t, th.st, asset.ID)
	data, contentType, ok := bucket.Object(key)
	if key == "" || !ok || contentType != "image/jpeg" {
		t.Fatalf("thumbnail key %q stored=%v as %q, want a JPEG", key, ok, contentType)
	}
	thumb, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || thumb.Width != 200 || thumb.Height != 150 {
		t.Fatalf("thumbnail %dx%d (%v), want 200x150", thumb.Width, thumb.Height, err)
	}

	list := doAsUser(t, th.h, http.MethodGet, "/api/editor-assets", "u_owner", nil)
	expectStatus(t, list, http.StatusOK, "the embeds list")
	var page struct {
		Items []struct{ AssetID, ThumbnailURL string }
	}
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].AssetID != asset.ID || page.Items[0].ThumbnailURL == "" {
		t.Fatalf("embeds list %+v, want the image with its thumbnail link", page.Items)
	}
}
