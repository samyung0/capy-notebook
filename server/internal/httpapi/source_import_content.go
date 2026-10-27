package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/integrations"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// getSourceImportContent streams one selected provider object into the
// browser analysis worker. Provider credentials stay server-side, and the
// response is bounded by the caller's source upload limit.
func (a *api) getSourceImportContent(w http.ResponseWriter, r *http.Request) {
	workspaceID := id(r)
	// The standalone route reads for the caller's own future file.
	if workspaceID == "" {
		if uid(r) == "" {
			a.fail(w, store.ErrNotFound)
			return
		}
	} else if !a.assertWS(w, r, workspaceID) {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	if provider != integrations.ProviderGoogle &&
		provider != integrations.ProviderMicrosoft {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "unknown provider"})
		return
	}
	fileID := strings.TrimSpace(r.URL.Query().Get("fileId"))
	if fileID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "fileId required"})
		return
	}
	token, err := integrations.ClerkAccessToken(r.Context(), uid(r), provider)
	if errors.Is(err, integrations.ErrNotConnected) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": provider + " account not connected"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	maxBytes, err := a.sourceMaxBytes(r.Context(), uid(r))
	if err != nil {
		a.fail(w, err)
		return
	}
	// The download has an upload's body deadline for its size (30 s plus the
	// cap at 100 KB/s, at most 5 minutes), however fast the browser reads.
	deadline := bodyDeadline(maxBytes)
	extendDeadlines(w, deadline+time.Minute)
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	out := &analysisContent{w: w}
	_, err = integrations.DownloadImportFile(
		ctx,
		provider,
		token,
		integrations.ImportRef{
			ID:      fileID,
			DriveID: strings.TrimSpace(r.URL.Query().Get("driveId")),
		},
		maxBytes,
		out,
	)
	if err != nil && out.started {
		// Part of the object is out: end the response as failed, never as a
		// complete, truncated file.
		panic(http.ErrAbortHandler)
	}
	if err != nil {
		switch {
		case errors.Is(err, integrations.ErrImportFileTooLarge):
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"message": "file_too_large"})
		case errors.Is(err, integrations.ErrImportFileUnavailable),
			errors.Is(err, integrations.ErrUnsupportedImportFile):
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "provider_file_unavailable"})
		case integrations.IsRetryableImportProviderError(err):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "provider temporarily unavailable"})
		default:
			a.fail(w, err)
		}
		return
	}
	if !out.started {
		_, _ = out.Write(nil)
	}
}

// analysisContent answers with the object's bytes as they arrive, its headers
// sent with the first write. This endpoint is a byte pipe for the analysis
// worker, not a browser preview: it never reflects a provider-controlled
// HTML/SVG content type from the application origin.
type analysisContent struct {
	w       http.ResponseWriter
	started bool
}

func (c *analysisContent) Write(p []byte) (int, error) {
	if !c.started {
		c.started = true
		c.w.Header().Set("Cache-Control", "private, no-store")
		c.w.Header().Set("Content-Disposition", `attachment; filename="source-analysis.bin"`)
		c.w.Header().Set("Content-Type", "application/octet-stream")
		c.w.Header().Set("X-Content-Type-Options", "nosniff")
		c.w.WriteHeader(http.StatusOK)
	}
	return c.w.Write(p)
}
