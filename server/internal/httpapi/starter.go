package httpapi

import (
	"context"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// starterProvisioner is the store as the auth middleware and the Clerk
// webhook see it: provisioning the starter workspace also fills it with its
// sample content, which needs the API's blob store and Office engine.
type starterProvisioner struct {
	*store.Store
	a *api
}

// CreateDefaultWorkspace provisions the starter workspace once, then adds a
// chapter holding a blank Word file and the welcome note (Epo 2026-10-29).
// Sample content never fails the account's first request: a failure is
// reported and leaves the workspace as far as it got.
func (p starterProvisioner) CreateDefaultWorkspace(ctx context.Context, userID string) error {
	ws, err := p.Store.CreateDefaultWorkspace(ctx, userID)
	if err != nil || ws.ID == "" {
		return err
	}
	ctx = context.WithoutCancel(ctx)
	if err := p.a.fillStarterWorkspace(ctx, userID, ws); err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "starter_content"})
		obs.Log(ctx).Error("starter content failed", "workspace_id", ws.ID, "error", err)
	}
	return nil
}

func (a *api) fillStarterWorkspace(ctx context.Context, userID string, ws store.StarterWorkspace) error {
	sample := store.StarterCopyFor(ws.Locale)
	chapter, err := a.s.AddChapter(ctx, ws.ID, userID, sample.Chapter)
	if err != nil {
		return err
	}
	if _, err := a.s.CreateStarterNote(ctx, userID, ws, chapter.ID); err != nil {
		return err
	}
	_, err = a.addBlankOfficeFile(ctx, userID, ws.ID, "docx", sample.Document+".docx", &chapter.ID)
	return err
}
