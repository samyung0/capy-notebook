package httpapi

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Server-side Office thumbnails after agent edits (openwiki/thumbnails.md,
// "Agent captures"; Epo 2026-10-11, 2026-10-13). Once per finished agent
// response, after the message is final and off the edit and save paths: the
// collaboration server draws page 1 of each Office file the turn's edits may
// have changed, natively as the browser's capture draws it, and the WebP is
// stored like a browser capture. Nothing retries: a failure is logged once
// and the card keeps its image.

// agentThumbnailBudget bounds one turn's captures, run one file after the
// other (Epo 2026-10-13).
const agentThumbnailBudget = 5 * time.Minute

// captureTurnThumbnails starts the turn's captures and returns at once.
func (a *api) captureTurnThumbnails(ctx context.Context, messageID string) {
	go func() {
		ctx, cancel := obs.Detach(ctx, agentThumbnailBudget)
		defer cancel()
		a.captureAgentThumbnails(ctx, messageID)
	}()
}

// captureAgentThumbnails captures each file of the turn once.
func (a *api) captureAgentThumbnails(ctx context.Context, messageID string) {
	files, err := a.s.TurnThumbnails(ctx, messageID)
	if err != nil {
		obs.Log(ctx).Warn("agent thumbnail capture failed", "message_id", messageID, "error", err)
		return
	}
	for _, file := range files {
		if err := a.captureAgentThumbnail(ctx, file); err != nil {
			obs.Log(ctx).Warn("agent thumbnail capture failed", "file_id", file.FileID, "format", file.Format, "error", err)
		}
	}
}

func (a *api) captureAgentThumbnail(ctx context.Context, file store.AgentThumbnail) error {
	started := time.Now()
	image, err := a.s.CaptureSourceThumbnail(ctx, file)
	if err != nil {
		return fmt.Errorf("render: %w", err)
	}
	if image == nil {
		return nil // page 1 is as it was
	}
	if err := checkThumbnailWebP(image); err != nil {
		return fmt.Errorf("render: %w", err)
	}
	target, err := a.s.ThumbnailTarget(ctx, file.FileID)
	if err != nil {
		return err
	}
	switch err := a.storeThumbnail(ctx, file.FileID, target.Key, image); {
	case errors.Is(err, store.ErrThumbnailTooSoon):
		// A browser captured the file meanwhile; its capture stands.
		return nil
	case err != nil:
		return err
	}
	obs.Log(ctx).Info("agent thumbnail captured", "file_id", file.FileID, "format", file.Format,
		"ms", time.Since(started).Milliseconds(), "bytes", len(image))
	return nil
}
