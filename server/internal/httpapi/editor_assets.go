package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/evonotes/server/internal/store"
)

const editorAssetMetadataMaxBytes = 64 << 10

type editorAssetRule struct {
	maxBytes int64
	mimes    map[string][]string
}

var editorAssetRules = map[string]editorAssetRule{
	"image": {
		maxBytes: 20 << 20,
		mimes: map[string][]string{
			".png": {"image/png"}, ".jpg": {"image/jpeg"}, ".jpeg": {"image/jpeg"},
			".gif": {"image/gif"}, ".webp": {"image/webp"}, ".avif": {"image/avif"},
		},
	},
	"audio": {
		maxBytes: 100 << 20,
		mimes: map[string][]string{
			".mp3": {"audio/mpeg"}, ".wav": {"audio/wav", "audio/x-wav"},
			".ogg": {"audio/ogg"}, ".flac": {"audio/flac"}, ".m4a": {"audio/mp4", "audio/x-m4a"},
			".aac": {"audio/aac"},
		},
	},
	"pdf": {
		maxBytes: 50 << 20,
		mimes:    map[string][]string{".pdf": {"application/pdf"}},
	},
	"file": {
		maxBytes: 100 << 20,
		mimes: map[string][]string{
			".txt": {"text/plain"}, ".md": {"text/markdown", "text/plain"},
			".csv": {"text/csv", "text/plain"}, ".zip": {"application/zip", "application/x-zip-compressed"},
			".doc":  {"application/msword"},
			".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
			".xls":  {"application/vnd.ms-excel"},
			".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
			".ppt":  {"application/vnd.ms-powerpoint"},
			".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
		},
	},
}

func editorAssetMaxBytes(rule editorAssetRule) int64 {
	if rule.maxBytes > store.FreeStorageLimitBytes {
		return store.FreeStorageLimitBytes
	}
	return rule.maxBytes
}

type reserveEditorAssetRequest struct {
	Name        string `json:"name"`
	Purpose     string `json:"purpose"`
	SizeBytes   int64  `json:"sizeBytes"`
	ContentType string `json:"contentType"`
}

func normalizeMediaType(value string) (string, error) {
	if strings.ContainsAny(value, "\r\n") {
		return "", errors.New("invalid content type")
	}
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return "", errors.New("invalid content type")
	}
	return strings.ToLower(mediaType), nil
}

func validateEditorAssetMetadata(in reserveEditorAssetRequest) (name, ext, contentType string, err error) {
	name = strings.TrimSpace(in.Name)
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	hasControl := strings.IndexFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0
	if name == "" || name == "." || len(name) > 255 || hasControl {
		return "", "", "", errors.New("file name is required and must be at most 255 characters")
	}
	rule, ok := editorAssetRules[in.Purpose]
	if !ok {
		return "", "", "", errors.New("purpose must be image, audio, pdf, or file")
	}
	maxBytes := editorAssetMaxBytes(rule)
	if in.SizeBytes <= 0 || in.SizeBytes > maxBytes {
		return "", "", "", fmt.Errorf("%s uploads must be between 1 byte and %d MB", in.Purpose, maxBytes>>20)
	}
	ext = strings.ToLower(filepath.Ext(name))
	allowedMimes, ok := rule.mimes[ext]
	if !ok {
		return "", "", "", fmt.Errorf("%s files with extension %q are not allowed", in.Purpose, ext)
	}
	contentType, err = normalizeMediaType(in.ContentType)
	if err != nil {
		return "", "", "", err
	}
	for _, allowed := range allowedMimes {
		if contentType == allowed {
			return name, ext, contentType, nil
		}
	}
	return "", "", "", fmt.Errorf("content type %q does not match %s extension %q", contentType, in.Purpose, ext)
}

func (a *api) reserveEditorAsset(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	if !a.assertEditorAssetWrite(w, r, wsID) {
		return
	}
	if a.blob == nil {
		a.fail(w, errors.New("blob store not configured"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, editorAssetMetadataMaxBytes)
	var in reserveEditorAssetRequest
	if err := decode(r, &in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid asset metadata"})
		return
	}
	name, ext, contentType, err := validateEditorAssetMetadata(in)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}

	assetID := randID("asset")
	uploadID := randID("eau")
	uploadPath := "editor-assets/incoming/" + uploadID + "/" + randID("blob") + ext
	finalPath := editorAssetObjectKey(assetID, ext)
	signed, err := a.blob.PresignPut(r.Context(), uploadPath, contentType)
	if err != nil {
		a.fail(w, err)
		return
	}
	asset, upload, err := a.s.CreateEditorAssetReservation(r.Context(), store.NewEditorAssetReservation{
		AssetID: assetID, UploadID: uploadID, WorkspaceID: wsID, CreatedBy: uid(r),
		Name: name, Purpose: in.Purpose, ObjectPath: uploadPath, FinalPath: finalPath, ContentType: contentType,
		DeclaredSize: in.SizeBytes, ExpiresAt: signed.ExpiresAt,
	})
	if err != nil {
		_ = a.blob.Delete(r.Context(), uploadPath)
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"assetId": asset.ID, "uploadId": upload.ID, "url": signed.URL, "method": "PUT",
		"headers": signed.Headers, "expiresAt": signed.ExpiresAt,
	})
}

func editorAssetObjectKey(assetID, ext string) string {
	return "editor-assets/" + assetID + "/" + randID("blob") + ext
}

func (a *api) assertEditorAssetWrite(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	err := a.s.AssertWorkspaceEditor(r.Context(), uid(r), workspaceID)
	if errors.Is(err, store.ErrForbidden) {
		writeJSON(w, http.StatusForbidden, map[string]string{"message": "workspace editor access required"})
		return false
	}
	if err != nil {
		a.fail(w, err)
		return false
	}
	return true
}

func (a *api) completeEditorAssetUpload(w http.ResponseWriter, r *http.Request) {
	uploadID := chi.URLParam(r, "uploadId")
	upload, err := a.s.GetEditorAssetUpload(r.Context(), uploadID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if upload.WorkspaceID != id(r) {
		a.fail(w, store.ErrNotFound)
		return
	}
	if !a.assertEditorAssetWrite(w, r, upload.WorkspaceID) {
		return
	}
	if upload.Status == "completed" {
		asset, err := a.s.FinalizeEditorAssetUpload(r.Context(), uploadID, "")
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, asset)
		return
	}
	if upload.Status != "pending" {
		writeJSON(w, http.StatusConflict, map[string]string{"message": store.ErrEditorAssetUploadState.Error()})
		return
	}
	if a.blob == nil {
		a.fail(w, errors.New("blob store not configured"))
		return
	}
	asset, err := a.s.GetEditorAsset(r.Context(), upload.AssetID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if time.Now().UTC().After(upload.ExpiresAt) {
		a.rejectEditorAssetUpload(r.Context(), upload)
		writeJSON(w, http.StatusGone, map[string]string{"message": store.ErrEditorAssetUploadExpired.Error()})
		return
	}

	info, err := a.blob.Head(r.Context(), upload.ObjectPath)
	fromFinalPath := false
	if err != nil {
		info, err = a.blob.Head(r.Context(), asset.ObjectPath)
		fromFinalPath = err == nil
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"message": "uploaded object is not available"})
			return
		}
	}
	actualType, typeErr := normalizeMediaType(info.ContentType)
	if info.Size != upload.DeclaredSize || typeErr != nil || actualType != upload.ContentType {
		a.rejectEditorAssetUpload(r.Context(), upload)
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "uploaded object does not match the reservation"})
		return
	}
	sourcePath := upload.ObjectPath
	if fromFinalPath {
		sourcePath = asset.ObjectPath
	}
	prefix, err := a.blob.ReadPrefix(r.Context(), sourcePath, 512)
	if err != nil {
		a.fail(w, fmt.Errorf("inspect editor asset: %w", err))
		return
	}
	if !editorAssetSignatureAllowed(asset.Purpose, strings.ToLower(filepath.Ext(asset.Name)), prefix) {
		a.rejectEditorAssetUpload(r.Context(), upload)
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "uploaded content does not match its file type"})
		return
	}
	if !fromFinalPath {
		if err := a.blob.Promote(r.Context(), upload.ObjectPath, asset.ObjectPath); err != nil {
			a.fail(w, err)
			return
		}
	}
	asset, err = a.s.FinalizeEditorAssetUpload(r.Context(), uploadID, info.ETag)
	if errors.Is(err, store.ErrEditorAssetUploadExpired) || errors.Is(err, store.ErrEditorAssetUploadState) {
		writeJSON(w, http.StatusConflict, map[string]string{"message": err.Error()})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, asset)
}

func (a *api) resolveEditorAsset(w http.ResponseWriter, r *http.Request) {
	asset, err := a.s.GetEditorAsset(r.Context(), chi.URLParam(r, "assetId"))
	if err != nil || asset.Status != "ready" {
		a.fail(w, store.ErrNotFound)
		return
	}
	if _, err := a.s.WorkspaceAccess(r.Context(), uid(r), asset.WorkspaceID); err != nil {
		a.fail(w, err)
		return
	}
	if a.blob == nil {
		a.fail(w, errors.New("blob store not configured"))
		return
	}
	objectPath, err := a.s.EditorAssetObjectPath(r.Context(), asset.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	signed, err := a.blob.PresignGetWithExpiry(r.Context(), objectPath)
	if err != nil {
		a.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"assetId": asset.ID, "url": signed.URL, "expiresAt": signed.ExpiresAt,
		"name": asset.Name, "purpose": asset.Purpose, "contentType": asset.ContentType,
		"sizeBytes": asset.SizeBytes,
	})
}

// rejectEditorAssetUpload discards a reservation whose object failed
// verification. Discarding the row queues both object paths for the reaper, so
// the bytes are released without this handler touching the bucket.
func (a *api) rejectEditorAssetUpload(ctx context.Context, upload store.EditorAssetUpload) {
	_ = a.s.MarkEditorAssetUploadExpired(ctx, upload.ID)
}

func editorAssetSignatureAllowed(purpose, ext string, data []byte) bool {
	rule, ok := editorAssetRules[purpose]
	if !ok {
		return false
	}
	if _, ok := rule.mimes[ext]; !ok {
		return false
	}
	has := func(prefix []byte) bool { return bytes.HasPrefix(data, prefix) }
	isISOBaseMedia := len(data) >= 12 && string(data[4:8]) == "ftyp"
	isoBrand := ""
	if isISOBaseMedia {
		isoBrand = string(data[8:12])
	}
	switch ext {
	case ".png":
		return has([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	case ".jpg", ".jpeg":
		return has([]byte{0xff, 0xd8, 0xff})
	case ".gif":
		return has([]byte("GIF87a")) || has([]byte("GIF89a"))
	case ".webp":
		return len(data) >= 12 && has([]byte("RIFF")) && string(data[8:12]) == "WEBP"
	case ".avif":
		return isISOBaseMedia && (bytes.Contains(data[8:min(len(data), 32)], []byte("avif")) ||
			bytes.Contains(data[8:min(len(data), 32)], []byte("avis")))
	case ".mp3":
		return has([]byte("ID3")) || (len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0)
	case ".wav":
		return len(data) >= 12 && has([]byte("RIFF")) && string(data[8:12]) == "WAVE"
	case ".ogg":
		return has([]byte("OggS"))
	case ".flac":
		return has([]byte("fLaC"))
	case ".aac":
		return len(data) >= 2 && data[0] == 0xff && data[1]&0xf6 == 0xf0
	case ".m4a":
		return isISOBaseMedia && (isoBrand == "M4A " || isoBrand == "M4B " || isoBrand == "f4a ")
	case ".pdf":
		return has([]byte("%PDF-"))
	case ".doc", ".xls", ".ppt":
		return has([]byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1})
	case ".docx", ".xlsx", ".pptx", ".zip":
		return has([]byte{'P', 'K', 0x03, 0x04}) || has([]byte{'P', 'K', 0x05, 0x06})
	case ".txt", ".md", ".csv":
		return utf8.Valid(data) && !bytes.ContainsRune(data, '\x00')
	default:
		return false
	}
}
