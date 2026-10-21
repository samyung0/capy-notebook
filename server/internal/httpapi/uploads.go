package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Object keys are built only through these helpers so every source object lands
// under one prefix. Three shapes used to coexist — `sources/blob_…` from the
// presign flow against bare `blob_…` from the legacy multipart and import paths —
// which made the incoming/ lifecycle rule and the orphan sweep unable to reason
// about a key from its name alone.
func sourceObjectKey(name string) string { return "sources/" + name }

// incomingObjectKey is where the import worker writes before promotion. The
// prefix carries a bucket lifecycle rule expiring objects after a day, so an
// import that is never completed costs nothing even if the outbox never hears
// about it.
func incomingObjectKey(uploadID, name string) string {
	return "incoming/" + uploadID + "/" + name
}

// sourceObjectKeys names a source's incoming and final objects: a 128-bit blob
// id plus the filename's plain extension. Cloud imports use both; browser
// uploads write the final key only.
func sourceObjectKeys(uploadID, name string) (incoming, final string) {
	blob := store.ObjectKeyID("blob") + keyExtension(name)
	return incomingObjectKey(uploadID, blob), sourceObjectKey(blob)
}

// keyExtension is the filename's extension as an object key suffix, kept only
// when it is plain lowercase letters and digits: the name is user input, and
// control or space characters must not reach a bucket key.
func keyExtension(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if !keyExtensionPattern.MatchString(ext) {
		return ""
	}
	return ext
}

var keyExtensionPattern = regexp.MustCompile(`^\.[a-z0-9]{1,11}$`)

// Uploads stream through the gateway (Epo 2026-10-22): one multipart request
// whose first part, "metadata", is the upload's JSON and whose second part,
// "file", is its bytes. The gateway reserves the payer's storage, spools and
// hashes the bytes, writes them to their final key in one bounded PUT and
// finalizes the row, all in that request.

// uploadMetadataMaxBytes bounds the metadata part and the multipart framing
// around the file part.
const uploadMetadataMaxBytes = 64 << 10

// uploadSessionTTL outlasts the slowest body an upload request reads; the
// sweeper releases a reservation that a crashed request left pending.
const uploadSessionTTL = time.Hour

// uploadPutBound bounds an upload's one B2 PUT (Epo 2026-10-21, kept
// 2026-10-22); tests shorten it.
var uploadPutBound = 60 * time.Second

// readUploadMetadata decodes the metadata part into v and returns the reader
// positioned for the file part. The caller has capped r.Body.
func readUploadMetadata(r *http.Request, v any) (*multipart.Reader, error) {
	form, err := r.MultipartReader()
	if err != nil {
		return nil, huma.Error400BadRequest("an upload is a multipart body")
	}
	part, err := form.NextPart()
	if err != nil || part.FormName() != "metadata" {
		return nil, huma.Error400BadRequest("an upload starts with its metadata part")
	}
	if err := json.NewDecoder(io.LimitReader(part, uploadMetadataMaxBytes)).Decode(v); err != nil {
		return nil, huma.Error400BadRequest("invalid upload metadata")
	}
	return form, nil
}

// spoolUpload reads the file part into a temporary file, hashing it as it
// streams, and refuses a part that is not size bytes of contentType. The PUT
// reads the rewound file, so its 60 s bound covers B2 alone, never the
// browser's upload. The caller removes the file with dropSpool.
func spoolUpload(form *multipart.Reader, size int64, contentType string) (*os.File, string, error) {
	part, err := form.NextPart()
	if err != nil || part.FormName() != "file" {
		return nil, "", huma.Error400BadRequest("an upload carries its file part after the metadata")
	}
	got, err := normalizeMediaType(part.Header.Get("Content-Type"))
	want, _ := normalizeMediaType(contentType)
	if err != nil || got != want {
		return nil, "", huma.Error400BadRequest("uploaded content type does not match the upload's metadata")
	}
	spool, err := os.CreateTemp("", "upload-*")
	if err != nil {
		return nil, "", err
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(spool, hash), io.LimitReader(part, size+1))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		err = huma.Error413RequestEntityTooLarge("the upload is larger than the per-file limit")
	case errors.Is(err, io.ErrUnexpectedEOF):
		err = huma.Error400BadRequest("the upload ended early")
	case err == nil && n != size:
		err = huma.Error400BadRequest("uploaded size does not match the upload's metadata")
	case err == nil:
		_, err = spool.Seek(0, io.SeekStart)
	}
	if err != nil {
		dropSpool(spool)
		return nil, "", err
	}
	return spool, hex.EncodeToString(hash.Sum(nil)), nil
}

func dropSpool(spool *os.File) {
	_ = spool.Close()
	_ = os.Remove(spool.Name())
}

// putUpload writes the spooled bytes to key in one PUT bounded at
// uploadPutBound and logs its duration with the upload id (never keys or
// URLs). A PUT past the bound fails the upload with the generic 5xx the
// browser offers a retry on; nothing retries it automatically.
func putUpload(ctx context.Context, objects blob.Store, uploadID, key string, body io.ReadSeeker, contentType string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, uploadPutBound)
	defer cancel()
	start := time.Now()
	etag, err := objects.PutObjectOnce(ctx, key, body, contentType, "")
	outcome := "ok"
	if err != nil {
		outcome = "error"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			outcome = "timeout"
		}
	}
	obs.Log(ctx).Info("upload b2 put", "upload_id", uploadID,
		"duration_ms", time.Since(start).Milliseconds(), "outcome", outcome)
	return etag, err
}

// dropUploadObject deletes an upload's object after a failure past its PUT
// started (a PUT that timed out may still land); the released reservation
// also queues the key for the reaper.
func dropUploadObject(ctx context.Context, objects blob.Store, key string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), uploadPutBound)
	defer cancel()
	if err := objects.Delete(ctx, key); err != nil {
		obs.Log(ctx).Warn("upload object cleanup failed; the reaper retries it")
	}
}

// failUpload answers a refused upload as the JSON operations answer errors
// (reportHandlerError), after reading what is left of the capped body so the
// browser reads the answer rather than a reset connection. It returns the
// status sent.
func (a *api) failUpload(w http.ResponseWriter, r *http.Request, err error) int {
	_, _ = io.Copy(io.Discard, r.Body)
	var status huma.StatusError
	if !errors.As(err, &status) {
		err = hErr(err)
	}
	answer := reportHandlerError(r.Context(), err)
	errors.As(answer, &status)
	writeJSON(w, status.GetStatus(), answer)
	return status.GetStatus()
}
