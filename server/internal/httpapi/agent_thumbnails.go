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
// response, after the message is final, and after a chat card's Undo of a
// source edit, off the edit and save paths: the collaboration server draws
// page 1 of each Office file the edits may have changed, natively as the
// browser's capture draws it, and the WebP is stored like a browser capture.
// Nothing retries: a failure is logged once and the card keeps its image.

// agentThumbnailBudget bounds one response's (or one Undo's) captures, run
// one file after the other (Epo 2026-10-13).
const agentThumbnailBudget = 5 * time.Minute

// captureTurnThumbnails starts the finished turn's captures and returns at
// once.
func (a *api) captureTurnThumbnails(ctx context.Context, messageID string) {
	a.captureInBackground(ctx, func(ctx context.Context) ([]store.AgentThumbnail, error) {
		return a.s.TurnThumbnails(ctx, messageID)
	})
}

// captureUndoThumbnail starts the capture after an Undo of a source edit and
// returns at once.
func (a *api) captureUndoThumbnail(ctx context.Context, inv store.EditInverse) {
	a.captureInBackground(ctx, func(ctx context.Context) ([]store.AgentThumbnail, error) {
		return a.s.UndoThumbnails(ctx, inv)
	})
}

func (a *api) captureInBackground(ctx context.Context, read func(context.Context) ([]store.AgentThumbnail, error)) {
	go func() {
		ctx, cancel := obs.Detach(ctx, agentThumbnailBudget)
		defer cancel()
		files, err := read(ctx)
		if err != nil {
			obs.Log(ctx).Warn("agent thumbnail capture failed", "error", err)
			return
		}
		a.captureAgentThumbnails(ctx, files)
	}()
}

// captureAgentThumbnails captures each file once.
func (a *api) captureAgentThumbnails(ctx context.Context, files []store.AgentThumbnail) {
	if len(files) == 0 {
		return
	}
	if a.blob == nil {
		obs.Log(ctx).Warn("agent thumbnail capture skipped", "files", len(files), "error", errThumbnailStorage)
		return
	}
	for _, file := range files {
		if file.Unknown {
			obs.Log(ctx).Info("agent thumbnail targets unread; page 1 counts as changed",
				"file_id", file.FileID, "format", file.Format, "reason", file.Why)
		}
		if err := a.captureAgentThumbnail(ctx, file); err != nil {
			obs.Log(ctx).Warn("agent thumbnail capture failed", "file_id", file.FileID, "format", file.Format, "error", err)
		}
	}
}

// captureAgentThumbnail waits out the file's capture interval first: a
// capture claimed before the edits were read is older than they are. It then
// draws the saved state and claims. A claim that beats it was made after the
// edits were read, so that capture is newer and stands.
func (a *api) captureAgentThumbnail(ctx context.Context, file store.AgentThumbnail) error {
	if wait := time.Until(file.Ready); wait > 0 {
		if err := a.waitThumbnailInterval(ctx, wait); err != nil {
			return err
		}
	}
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
		return nil
	case err != nil:
		return err
	}
	obs.Log(ctx).Info("agent thumbnail captured", "file_id", file.FileID, "format", file.Format,
		"ms", time.Since(started).Milliseconds(), "bytes", len(image))
	return nil
}

// waitThumbnailInterval sleeps until d has passed or ctx ends. Tests count
// the waits instead (api.thumbnailWait).
func (a *api) waitThumbnailInterval(ctx context.Context, d time.Duration) error {
	if a.thumbnailWait != nil {
		return a.thumbnailWait(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
