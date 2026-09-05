package httpapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Workspace IDs are existing prefixed tokens, not UUIDs. Bound input without
// changing already issued share links, including development seed IDs.
var summaryWorkspaceID = regexp.MustCompile(`^ws_[A-Za-z0-9_-]{1,64}$`)

type workspaceSummaryOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         store.WorkspaceSummary
}
type workspaceSummaryHeadOutput struct {
	CacheControl string `header:"Cache-Control"`
}

func (a *api) registerWorkspaceSummary(api huma.API) {
	reg(api, http.MethodGet, "/api/public/workspaces/{id}/summary", "getPublicWorkspaceSummary", "Sharing", "Get public workspace metadata", http.StatusOK, a.getPublicWorkspaceSummary)
	reg(api, http.MethodHead, "/api/public/workspaces/{id}/summary", "headPublicWorkspaceSummary", "Sharing", "Check public workspace metadata", http.StatusOK, a.headPublicWorkspaceSummary)
}

func (a *api) readPublicWorkspaceSummary(ctx context.Context, id string) (store.WorkspaceSummary, error) {
	if !summaryWorkspaceID.MatchString(id) {
		return store.WorkspaceSummary{}, huma.Error404NotFound("not found")
	}
	summary, err := a.s.PublicWorkspaceSummary(ctx, id)
	if errors.Is(err, store.ErrSummaryTooLarge) {
		return store.WorkspaceSummary{}, huma.Error422UnprocessableEntity("workspace summary exceeds public response limit")
	}
	if err != nil {
		return store.WorkspaceSummary{}, hErr(err)
	}
	return summary, nil
}
func (a *api) getPublicWorkspaceSummary(ctx context.Context, in *workspaceIDInput) (*workspaceSummaryOutput, error) {
	summary, err := a.readPublicWorkspaceSummary(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	return &workspaceSummaryOutput{CacheControl: "no-store", Body: summary}, nil
}
func (a *api) headPublicWorkspaceSummary(ctx context.Context, in *workspaceIDInput) (*workspaceSummaryHeadOutput, error) {
	if _, err := a.readPublicWorkspaceSummary(ctx, in.ID); err != nil {
		return nil, err
	}
	return &workspaceSummaryHeadOutput{CacheControl: "no-store"}, nil
}
