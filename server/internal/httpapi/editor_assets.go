package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

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

// uploadEditorAsset streams one image or audio file for a material through
// the gateway (Epo 2026-10-22; see uploads.go). The material's payer is
// charged (Sam 2026-10-19), and the bytes must open with their type's
// signature.
func (a *api) uploadEditorAsset(w http.ResponseWriter, r *http.Request) {
	scope, ok := a.editorAssetScopeFor(w, r)
	if !ok {
		return
	}
	asset, err := a.receiveEditorAsset(w, r, scope)
	if err != nil {
		a.failUpload(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, asset)
}

func (a *api) receiveEditorAsset(w http.ResponseWriter, r *http.Request, scope editorAssetScope) (store.EditorAsset, error) {
	ctx := r.Context()
	// Audio, at the payer's per-file cap, is the largest asset.
	r.Body = http.MaxBytesReader(w, r.Body, scope.limits.EditorAssetBytes("audio")+uploadMetadataMaxBytes)
	if a.blob == nil {
		return store.EditorAsset{}, errors.New("blob store not configured")
	}
	var in reserveEditorAssetRequest
	form, err := readUploadMetadata(r, &in)
	if err != nil {
		return store.EditorAsset{}, err
	}
	freeLimits, err := a.s.PlanLimits(store.PlanFree)
	if err != nil {
		return store.EditorAsset{}, err
	}
	name, ext, contentType, err := validateEditorAssetMetadata(in, freeLimits.StorageBytes, scope.limits)
	if err != nil {
		return store.EditorAsset{}, huma.Error400BadRequest(err.Error())
	}

	assetID := randID("asset")
	uploadID := randID("eau")
	key := editorAssetObjectKey(assetID, ext)
	if _, _, err := a.s.CreateEditorAssetReservation(ctx, store.NewEditorAssetReservation{
		AssetID: assetID, UploadID: uploadID, WorkspaceID: scope.workspaceID, MaterialID: scope.materialID, CreatedBy: uid(r),
		Name: name, Purpose: in.Purpose, ObjectPath: key, FinalPath: key, ContentType: contentType,
		DeclaredSize: in.SizeBytes, ExpiresAt: time.Now().UTC().Add(uploadSessionTTL),
	}); err != nil {
		return store.EditorAsset{}, err
	}
	asset, err := a.storeEditorAssetBytes(ctx, form, uploadID, key, in.Purpose, ext, contentType, in.SizeBytes)
	if err != nil {
		// Discarding the pending asset releases the reservation and queues
		// the key for the reaper.
		if err := a.s.MarkEditorAssetUploadExpired(context.WithoutCancel(ctx), uploadID); err != nil {
			log.Printf("release failed editor asset upload %s: %v", uploadID, err)
		}
		return store.EditorAsset{}, err
	}
	return asset, nil
}

// storeEditorAssetBytes spools the file part, checks its signature, writes it
// in one PUT and finalizes the reserved asset; the object is deleted when
// anything after the PUT fails.
func (a *api) storeEditorAssetBytes(
	ctx context.Context, form *multipart.Reader, uploadID, key, purpose, ext, contentType string, size int64,
) (store.EditorAsset, error) {
	spool, _, err := spoolUpload(form, size, contentType)
	if err != nil {
		return store.EditorAsset{}, err
	}
	defer dropSpool(spool)
	head := make([]byte, 512)
	n, _ := spool.ReadAt(head, 0)
	if !editorAssetSignatureAllowed(purpose, ext, head[:n]) {
		return store.EditorAsset{}, huma.Error400BadRequest("uploaded content does not match its file type")
	}
	etag, err := putUpload(ctx, a.blob, uploadID, key, spool, contentType)
	var asset store.EditorAsset
	if err == nil {
		asset, err = a.s.FinalizeEditorAssetUpload(ctx, uploadID, etag)
	}
	if err != nil {
		dropUploadObject(ctx, a.blob, key)
	}
	return asset, err
}

func editorAssetObjectKey(assetID, ext string) string {
	return "editor-assets/" + assetID + "/" + store.ObjectKeyID("blob") + ext
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
