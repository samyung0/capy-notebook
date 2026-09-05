package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/integrations"
)

// getSourceImportContent proxies one selected provider object into the browser
// analysis worker. Provider credentials stay server-side, and the response is
// bounded by the workspace owner's source upload limit.
func (a *api) getSourceImportContent(w http.ResponseWriter, r *http.Request) {
	workspaceID := id(r)
	if !a.assertWS(w, r, workspaceID) {
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
	maxBytes, err := a.sourceMaxBytes(r.Context(), workspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	data, _, err := integrations.DownloadImportFile(
		r.Context(),
		provider,
		token,
		integrations.ImportRef{
			ID:      fileID,
			DriveID: strings.TrimSpace(r.URL.Query().Get("driveId")),
		},
		maxBytes,
	)
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
	// This endpoint is a byte pipe for the analysis worker, not a browser
	// preview. Never reflect a provider-controlled HTML/SVG content type from the
	// application origin.
	writeSourceAnalysisContent(w, data)
}

func writeSourceAnalysisContent(w http.ResponseWriter, data []byte) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="source-analysis.bin"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
