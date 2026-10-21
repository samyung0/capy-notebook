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

	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/planlimits"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

const editorAssetMetadataMaxBytes = 64 << 10

// editorAssetRules lists, per purpose, each allowed extension's content types.
// A note's media are images and audio only (Epo 2026-10-15).
var editorAssetRules = map[string]map[string][]string{
	"image": {
		".png": {"image/png"}, ".jpg": {"image/jpeg"}, ".jpeg": {"image/jpeg"},
		".gif": {"image/gif"}, ".webp": {"image/webp"}, ".avif": {"image/avif"},
	},
	"audio": {
		".mp3": {"audio/mpeg"}, ".wav": {"audio/wav", "audio/x-wav"},
		".ogg": {"audio/ogg"}, ".flac": {"audio/flac"}, ".m4a": {"audio/mp4", "audio/x-m4a"},
		".aac": {"audio/aac"},
	},
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

func validateEditorAssetMetadata(
	in reserveEditorAssetRequest,
	storageCeiling int64,
	limits planlimits.Limits,
) (name, ext, contentType string, err error) {
	name = strings.TrimSpace(in.Name)
	name = fieldlimits.ClampFileName(path.Base(strings.ReplaceAll(name, `\`, "/")))
	hasControl := strings.IndexFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0
	if name == "" || name == "." || hasControl {
		return "", "", "", errors.New("file name is required")
	}
	rule, ok := editorAssetRules[in.Purpose]
	if !ok {
		return "", "", "", errors.New("purpose must be image or audio")
	}
	// The payer's plan cap (the browser shrinks larger images first), never
	// above the storage ceiling.
	maxBytes := min(limits.EditorAssetBytes(in.Purpose), storageCeiling)
	if in.SizeBytes <= 0 || in.SizeBytes > maxBytes {
		return "", "", "", fmt.Errorf("%s uploads must be between 1 byte and %d MB", in.Purpose, maxBytes>>20)
	}
	ext = strings.ToLower(filepath.Ext(name))
	allowedMimes, ok := rule[ext]
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

// editorAssetScope is where a material's editor assets live: always the
// material, so its saves and purge delete them, and its workspace when it has
// one.
type editorAssetScope struct {
	workspaceID, materialID string
	// The payer's plan limits, which cap each asset (EditorAssetBytes).
	// Bank figures have their own limit (bank/assets.go).
	limits planlimits.Limits
}

// editorAssetScopeFor admits an editor of the route's material and resolves the
// scope: the material plus its workspace when it has one. The material's
// payer pays (Sam 2026-10-19). The store transaction rechecks both.
func (a *api) editorAssetScopeFor(w http.ResponseWriter, r *http.Request) (editorAssetScope, bool) {
	materialID := id(r)
	err := a.s.AssertMaterialEditor(r.Context(), uid(r), materialID)
	if errors.Is(err, store.ErrForbidden) {
		writeJSON(w, http.StatusForbidden, map[string]string{"message": "material editor access required"})
		return editorAssetScope{}, false
	}
	if err != nil {
		a.fail(w, err)
		return editorAssetScope{}, false
	}
	workspaceID, limits, err := a.s.EditorAssetMaterial(r.Context(), materialID)
	if err != nil {
		a.fail(w, err)
		return editorAssetScope{}, false
	}
	return editorAssetScope{workspaceID: workspaceID, materialID: materialID, limits: limits}, true
}

func (a *api) reserveEditorAsset(w http.ResponseWriter, r *http.Request) {
	scope, ok := a.editorAssetScopeFor(w, r)
	if !ok {
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
	freeLimits, err := a.s.PlanLimits(store.PlanFree)
	if err != nil {
		a.fail(w, err)
		return
	}
	name, ext, contentType, err := validateEditorAssetMetadata(in, freeLimits.StorageBytes, scope.limits)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}

	assetID := randID("asset")
	uploadID := randID("eau")
	uploadPath := "editor-assets/incoming/" + uploadID + "/" + store.ObjectKeyID("blob") + ext
	finalPath := editorAssetObjectKey(assetID, ext)
	signed, err := a.blob.PresignPut(r.Context(), uploadPath, contentType, in.SizeBytes)
	if err != nil {
		a.fail(w, err)
		return
	}
	asset, upload, err := a.s.CreateEditorAssetReservation(r.Context(), store.NewEditorAssetReservation{
		AssetID: assetID, UploadID: uploadID, WorkspaceID: scope.workspaceID, MaterialID: scope.materialID, CreatedBy: uid(r),
		Name: name, Purpose: in.Purpose, ObjectPath: uploadPath, FinalPath: finalPath, ContentType: contentType,
		DeclaredSize: in.SizeBytes, ExpiresAt: signed.ExpiresAt,
	})
	if err != nil {
		_ = a.blob.Delete(r.Context(), uploadPath)
		a.failFor(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"assetId": asset.ID, "uploadId": upload.ID, "url": signed.URL, "method": "PUT",
		"headers": signed.Headers, "expiresAt": signed.ExpiresAt,
	})
}

func editorAssetObjectKey(assetID, ext string) string {
	return "editor-assets/" + assetID + "/" + store.ObjectKeyID("blob") + ext
}

func (a *api) completeEditorAssetUpload(w http.ResponseWriter, r *http.Request) {
	scope, ok := a.editorAssetScopeFor(w, r)
	if !ok {
		return
	}
	uploadID := chi.URLParam(r, "uploadId")
	upload, err := a.s.GetEditorAssetUpload(r.Context(), uploadID)
	if err != nil {
		a.fail(w, err)
		return
	}
	// Only the account that reserved the upload completes it (Sam 2026-10-18);
	// the material's payer is charged (Sam 2026-10-19).
	if upload.WorkspaceID != scope.workspaceID || upload.MaterialID != scope.materialID || upload.CreatedBy != uid(r) {
		a.fail(w, store.ErrNotFound)
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

	info, err := boundB2(r.Context(), uploadID, "head", func(ctx context.Context) (blob.ObjectInfo, error) {
		return a.blob.Head(ctx, upload.ObjectPath)
	})
	fromFinalPath := false
	if errors.Is(err, errB2CallTimeout) {
		a.fail(w, err)
		return
	}
	if err != nil {
		info, err = boundB2(r.Context(), uploadID, "head", func(ctx context.Context) (blob.ObjectInfo, error) {
			return a.blob.Head(ctx, asset.ObjectPath)
		})
		fromFinalPath = err == nil
		if errors.Is(err, errB2CallTimeout) {
			a.fail(w, err)
			return
		}
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
	prefix, err := boundB2(r.Context(), uploadID, "signature_read", func(ctx context.Context) ([]byte, error) {
		return a.blob.ReadPrefix(ctx, sourcePath, 512)
	})
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
		if _, err := boundB2(r.Context(), uploadID, "promote", func(ctx context.Context) (struct{}, error) {
			return struct{}{}, a.blob.Promote(ctx, upload.ObjectPath, asset.ObjectPath)
		}); err != nil {
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
		a.failFor(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, asset)
}

func (a *api) resolveEditorAsset(w http.ResponseWriter, r *http.Request) {
	asset, err := a.s.GetEditorAsset(r.Context(), chi.URLParam(r, "assetId"))
	// A trashed asset stays hidden until its material's save restores it.
	if err != nil || asset.Status != "ready" || asset.Trashed {
		a.fail(w, store.ErrNotFound)
		return
	}
	if asset.WorkspaceID != "" {
		if _, err := a.s.WorkspaceAccess(r.Context(), uid(r), asset.WorkspaceID); err != nil {
			a.fail(w, err)
			return
		}
	} else if asset.MaterialID != "" {
		if _, err := a.s.MaterialEffectiveRole(r.Context(), uid(r), asset.MaterialID); err != nil {
			a.fail(w, err)
			return
		}
	} else {
		a.fail(w, store.ErrNotFound)
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
		"sizeBytes": asset.SizeBytes, "materialId": asset.MaterialID,
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
	if _, ok := rule[ext]; !ok {
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
	default:
		return false
	}
}
