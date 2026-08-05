package httpapi

import (
	"errors"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/evonotes/server/internal/store"
)

// Object keys are built only through these helpers so every source object lands
// under one prefix. Three shapes used to coexist — `sources/blob_…` from the
// presign flow against bare `blob_…` from the legacy multipart and import paths —
// which made the incoming/ lifecycle rule and the orphan sweep unable to reason
// about a key from its name alone.
func sourceObjectKey(name string) string { return "sources/" + name }

// incomingObjectKey is where a browser PUTs before promotion. The prefix carries
// a bucket lifecycle rule expiring objects after a day, so an upload that is
// never completed costs nothing even if the outbox never hears about it.
func incomingObjectKey(uploadID, name string) string {
	return "incoming/" + uploadID + "/" + name
}

type createUploadRequest struct {
	Name        string  `json:"name"`
	Kind        string  `json:"kind"`
	ChapterID   *string `json:"chapterId"`
	ChapterName string  `json:"chapterName"`
	ParseMode   string  `json:"parseMode"`
	SizeBytes   int64   `json:"sizeBytes"`
	ContentType string  `json:"contentType"`
}

func (a *api) createSourceUpload(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	if !a.assertWS(w, r, wsID) {
		return
	}
	if a.blob == nil {
		a.fail(w, errors.New("blob store not configured"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var in createUploadRequest
	if err := decode(r, &in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid upload metadata"})
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.ChapterName = strings.TrimSpace(in.ChapterName)
	if in.Name == "" || len(in.Name) > 512 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "file name is required and must be at most 512 characters"})
		return
	}
	if len(in.ChapterName) > 255 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "chapter name must be at most 255 characters"})
		return
	}
	if in.ChapterID != nil && in.ChapterName != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "chapterId and chapterName cannot both be set"})
		return
	}
	if in.Kind == "" {
		in.Kind = kindFromName(in.Name)
	}
	if in.ParseMode == "" {
		in.ParseMode = defaultParseMode(in.Name, in.Kind)
	}
	if in.SizeBytes < 0 || in.SizeBytes > advancedMaxBytes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "uploads support files up to 100 MB"})
		return
	}
	if err := validateParseMode(in.ParseMode, in.Name, in.Kind, in.SizeBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}
	if in.ChapterID != nil {
		chapterWorkspace, err := a.s.ChapterWorkspaceID(r.Context(), *in.ChapterID)
		if err != nil || chapterWorkspace != wsID {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "chapter does not belong to this workspace"})
			return
		}
	}
	if in.ContentType == "" {
		in.ContentType = "application/octet-stream"
	}
	if _, _, err := mime.ParseMediaType(in.ContentType); err != nil || strings.ContainsAny(in.ContentType, "\r\n") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid content type"})
		return
	}

	uploadID := randID("up")
	blobID := randID("blob")
	ext := strings.ToLower(filepath.Ext(in.Name))
	if len(ext) > 12 {
		ext = ""
	}
	incoming := incomingObjectKey(uploadID, blobID+ext)
	finalPath := sourceObjectKey(blobID + ext)
	signed, err := a.blob.PresignPut(r.Context(), incoming, in.ContentType)
	if err != nil {
		a.fail(w, err)
		return
	}
	session, err := a.s.CreateUploadSession(r.Context(), store.NewUploadSession{
		ID: uploadID, WorkspaceID: wsID, CreatedBy: uid(r),
		ChapterID: in.ChapterID, ChapterName: in.ChapterName,
		ObjectPath: incoming, FinalPath: finalPath, Name: in.Name, Kind: in.Kind,
		ContentType: in.ContentType, DeclaredSize: in.SizeBytes,
		ParseMode: in.ParseMode, ExpiresAt: signed.ExpiresAt,
	})
	if err != nil {
		a.fail(w, err)
		return
	}
	log.Printf("direct upload reserved upload=%s workspace=%s bytes=%d mode=%s",
		session.ID, wsID, session.DeclaredSize, session.ParseMode)
	writeJSON(w, http.StatusCreated, map[string]any{
		"uploadId": session.ID, "url": signed.URL, "method": "PUT",
		"headers": signed.Headers, "expiresAt": signed.ExpiresAt,
	})
}

func (a *api) completeSourceUpload(w http.ResponseWriter, r *http.Request) {
	uploadID := chi.URLParam(r, "uploadId")
	session, err := a.s.GetUploadSession(r.Context(), uploadID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if session.WorkspaceID != id(r) {
		a.fail(w, store.ErrNotFound)
		return
	}
	if !a.assertWS(w, r, session.WorkspaceID) {
		return
	}
	if session.Status == "completed" {
		res, err := a.s.FinalizeUploadSession(r.Context(), uploadID, "", a.parser, a.engine)
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}
	if time.Now().UTC().After(session.ExpiresAt) {
		writeJSON(w, http.StatusGone, map[string]string{"message": store.ErrUploadExpired.Error()})
		return
	}

	info, finalErr := a.blob.Head(r.Context(), session.FinalPath)
	if finalErr != nil {
		info, err = a.blob.Head(r.Context(), session.ObjectPath)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"message": "uploaded object is not available"})
			return
		}
	}
	if info.Size != session.DeclaredSize {
		_ = a.blob.Delete(r.Context(), session.ObjectPath)
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "uploaded size does not match the reserved size"})
		return
	}
	if info.ContentType != "" && info.ContentType != session.ContentType {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "uploaded content type does not match the reservation"})
		return
	}
	if finalErr != nil {
		if err := a.blob.Promote(r.Context(), session.ObjectPath, session.FinalPath); err != nil {
			a.fail(w, err)
			return
		}
	}
	res, err := a.s.FinalizeUploadSession(r.Context(), uploadID, info.ETag, a.parser, a.engine)
	if errors.Is(err, store.ErrUploadExpired) || errors.Is(err, store.ErrUploadState) {
		writeJSON(w, http.StatusConflict, map[string]string{"message": err.Error()})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	log.Printf("direct upload completed upload=%s file=%s bytes=%d etag=%s",
		uploadID, res.ID, info.Size, info.ETag)
	writeJSON(w, http.StatusCreated, res)
}
