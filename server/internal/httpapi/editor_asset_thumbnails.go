package httpapi

import (
	"context"

	"github.com/samyung0/capy-notebook/server/internal/assetthumb"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Editor image thumbnails, the Embeds tab's pictures (openwiki/thumbnails.md,
// Sam 2026-10-29), are made in the background once the images are stored, in
// a small room: at most assetThumbnailSlots batches at once, each image's
// put within assetthumb.PutWindow. A full room skips the batch and a failure
// is logged; neither is retried, and the card keeps its icon.
const assetThumbnailSlots = 2

type editorImage struct {
	assetID string
	read    func() ([]byte, error)
}

// thumbnailEditorImages reads the images now, while the caller still holds
// their bytes, and thumbnails them one after another in one slot.
func (a *api) thumbnailEditorImages(ctx context.Context, images []editorImage) {
	if len(images) == 0 {
		return
	}
	select {
	case a.assetThumbs <- struct{}{}:
	default:
		obs.Log(ctx).Info("editor image thumbnails skipped: no free slot", "images", len(images))
		return
	}
	type job struct {
		assetID string
		data    []byte
	}
	jobs := make([]job, 0, len(images))
	for _, img := range images {
		data, err := img.read()
		if err != nil {
			obs.Log(ctx).Warn("editor image thumbnail failed", "asset_id", img.assetID, "error", err)
			continue
		}
		jobs = append(jobs, job{img.assetID, data})
	}
	ctx = context.WithoutCancel(ctx)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				obs.Log(ctx).Error("editor image thumbnail panicked", "panic", r)
			}
			<-a.assetThumbs
		}()
		for _, j := range jobs {
			if err := assetthumb.Store(ctx, a.blob, a.s, j.assetID, j.data); err != nil {
				obs.Log(ctx).Warn("editor image thumbnail failed", "asset_id", j.assetID, "error", err)
			}
		}
	}()
}
