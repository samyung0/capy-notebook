package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// LibraryFigure is one shared-library figure as a chat answer's
// ![caption](figure:<id>) shows it (Epo 2026-10-30): the JPEG of its box
// with its printed label and credit. Any signed-in user may read it, as the
// chat agent's library tools do.
type LibraryFigure struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Credit string `json:"credit"`
	Image  []byte `json:"image" contentEncoding:"base64" contentMediaType:"image/jpeg"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type libraryFigureInput struct {
	ID string `path:"id" maxLength:"128" pattern:"^[A-Za-z0-9_-]+$"`
}

type libraryFigureOutput struct {
	// A figure id names one figure of one book version forever.
	CacheControl string `header:"Cache-Control"`
	Body         LibraryFigure
}

func (a *api) registerLibraryFigures(api huma.API) {
	reg(api, http.MethodGet, "/api/library/figures/{id}", "getLibraryFigure", "Library",
		"A library figure for a chat answer", http.StatusOK, a.getLibraryFigure)
}

func (a *api) getLibraryFigure(ctx context.Context, in *libraryFigureInput) (*libraryFigureOutput, error) {
	raw, err := a.pipe.PostRaw(ctx, "/library/figure", map[string]string{"id": in.ID})
	var pipeErr *pipeline.Error
	switch {
	case errors.As(err, &pipeErr) && pipeErr.Status == http.StatusNotFound:
		return nil, huma.Error404NotFound("library figure not found")
	case errors.As(err, &pipeErr) && pipeErr.Status == http.StatusServiceUnavailable:
		return nil, huma.Error503ServiceUnavailable("library figure unavailable")
	case err != nil:
		return nil, &aiServiceError{cause: err}
	}
	out := &libraryFigureOutput{CacheControl: "private, max-age=86400, immutable"}
	if err := json.Unmarshal(raw, &out.Body); err != nil {
		return nil, err
	}
	return out, nil
}
