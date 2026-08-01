package httpapi

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"

	"github.com/evonotes/server/internal/auth"
	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/store"
)

// The JSON billing/integration endpoints (status, picker-token, recent,
// disconnect) are registered with huma in huma_account.go. OAuth itself is
// handled by Clerk: users link Google/Microsoft external accounts through the
// Clerk frontend SDK and the backend fetches access tokens from Clerk's token
// wallet (integrations/clerk.go). Import stays on raw chi.

func (a *api) importSources(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r.Context())
	wsID := id(r)
	if err := a.s.AssertWorkspaceOwner(r.Context(), userID, wsID); err != nil {
		a.fail(w, err)
		return
	}

	var body struct {
		Provider  string   `json:"provider"`
		FileIds   []string `json:"fileIds"`
		ChapterID *string  `json:"chapterId"`
	}
	if err := decode(r, &body); err != nil || len(body.FileIds) == 0 {
		writeJSON(w, 400, map[string]string{"message": "provider and fileIds required"})
		return
	}

	tok, err := integrations.ClerkAccessToken(r.Context(), userID, body.Provider)
	if errors.Is(err, integrations.ErrNotConnected) {
		writeJSON(w, 400, map[string]string{"message": body.Provider + " account not connected"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}

	created := []store.File{}
	for _, fid := range body.FileIds {
		var data []byte
		var name string
		switch body.Provider {
		case integrations.ProviderGoogle:
			data, name, err = integrations.DownloadGoogleFile(tok, fid)
		case integrations.ProviderMicrosoft:
			data, name, err = integrations.DownloadMicrosoftFile(tok, fid)
		default:
			writeJSON(w, 400, map[string]string{"message": "unknown provider"})
			return
		}
		if err != nil {
			a.fail(w, err)
			return
		}
		kind := integrations.KindFromName(name)
		mode := defaultParseMode(name, kind)
		if err := validateParseMode(mode, name, kind, int64(len(data))); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
			return
		}
		if a.blob == nil {
			a.fail(w, fmt.Errorf("blob store not configured"))
			return
		}
		blobPath, _, err := a.blob.Put(randID("blob"), bytes.NewReader(data))
		if err != nil {
			a.fail(w, err)
			return
		}
		var f store.File
		if mode == parseModeNone {
			// Formats no parser supports (audio/…) land ready, view-only.
			f, err = a.s.CreateSourceReady(r.Context(), wsID, name, kind, body.ChapterID, "", int64(len(data)), blobPath)
		} else {
			f, _, err = a.s.CreateSourceWithJob(r.Context(), wsID, name, kind, body.ChapterID, "", int64(len(data)), blobPath, a.parser, a.engine, mode)
		}
		if err != nil {
			_ = a.blob.Delete(r.Context(), blobPath)
			a.fail(w, err)
			return
		}
		created = append(created, f)
	}
	writeJSON(w, 201, created)
}
