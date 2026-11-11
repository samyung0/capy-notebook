package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// The parse coordinator converts an uploaded legacy Office file (.doc, .xls,
// .ppt), puts the converted file at incoming/legacy-convert/<jobId>.<format>
// with its own B2 credentials and hands it over here. The gateway promotes
// and checks the object, and the store swaps it in for the uploaded bytes and
// finishes the job; the worker neither finishes it nor queues what follows.

type legacyConvertReq struct {
	JobID           string `json:"jobId"`
	Attempt         int    `json:"attempt"`
	FileID          string `json:"fileId"`
	IncomingKey     string `json:"incomingKey"`
	ActualSize      int64  `json:"actualSize"`
	SHA256          string `json:"sha256"`
	RemovedPictures int    `json:"removedPictures"`
}

func (a *api) internalConvertLegacyFile(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var req legacyConvertReq
	if err := decode(r, &req); err != nil || req.JobID == "" || req.FileID == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "convert_invalid"})
		return
	}
	in := store.LegacyConvert{
		JobID: req.JobID, Attempt: req.Attempt, FileID: req.FileID, IncomingKey: req.IncomingKey,
		ActualSize: req.ActualSize, SHA256: req.SHA256, RemovedPictures: req.RemovedPictures,
	}
	// The fence runs before any bucket call: a repeat of a finished job finds
	// its object already promoted, and a refused hand-over moves nothing.
	target, err := a.s.PrepareLegacyConvert(r.Context(), in)
	if err != nil {
		a.legacyConvertRefusal(w, err)
		return
	}
	if target.Done != nil {
		writeLegacyConverted(w, *target.Done)
		return
	}
	// A missing object is a fault the job retries.
	info, err := a.blob.Head(r.Context(), req.IncomingKey)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "object_unavailable"})
		return
	}
	// The worker writes the format's own type: an object carrying another is
	// refused, as an import's is.
	if info.Size != req.ActualSize || (info.ContentType != "" && info.ContentType != ooxmlContentTypes[target.ConvertTo]) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "convert_invalid"})
		return
	}
	if err := a.blob.Promote(r.Context(), req.IncomingKey, target.FinalPath); err != nil {
		a.fail(w, err)
		return
	}
	// The gateway hashes the promoted object, the bytes that become the file
	// (B2 verifies no client-sent checksum), and takes only a ZIP container.
	// A refused one is left to the reaper the fence queued it for.
	sha, zip, err := zipObjectSHA256(r.Context(), a.blob, target.FinalPath, req.ActualSize)
	if errors.Is(err, errStoredSourceChanged) || (err == nil && (!zip || sha != req.SHA256)) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "convert_invalid"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	result, err := a.s.CompleteLegacyConvert(r.Context(), in, target.FinalPath, info.ETag)
	if err != nil {
		a.legacyConvertRefusal(w, err)
		return
	}
	writeLegacyConverted(w, result)
}

var ooxmlContentTypes = map[string]string{
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

// zipSignature opens every OOXML file: a ZIP local file header.
var zipSignature = []byte("PK\x03\x04")

// zipObjectSHA256 hashes a stored object of size bytes in one read and
// reports whether it opens with the ZIP signature.
func zipObjectSHA256(ctx context.Context, objects blob.Store, path string, size int64) (sha string, zip bool, err error) {
	body, err := objects.Open(ctx, path)
	if err != nil {
		return "", false, err
	}
	defer body.Close()
	head := make([]byte, len(zipSignature))
	n, err := io.ReadFull(body, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", false, err
	}
	sha, err = readerSHA256(io.MultiReader(bytes.NewReader(head[:n]), body), size)
	return sha, bytes.Equal(head[:n], zipSignature), err
}

func writeLegacyConverted(w http.ResponseWriter, result store.LegacyConvertResult) {
	writeJSON(w, http.StatusOK, map[string]any{
		"fileId": result.FileID, "name": result.Name, "status": "converted", "parseJobId": result.ParseJobID,
	})
}

// legacyConvertRefusal answers a refused hand-over. The worker stops quietly
// on a lost claim (409) and fails the file for good on the 413 and 422s;
// anything else is a fault its job retries.
func (a *api) legacyConvertRefusal(w http.ResponseWriter, err error) {
	var tooLarge *store.FileTooLargeError
	switch {
	case errors.Is(err, store.ErrConvertClaimLost):
		writeJSON(w, http.StatusConflict, map[string]string{"code": "convert_claim_lost"})
	case errors.As(err, &tooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"code": "file_too_large"})
	case errors.Is(err, store.ErrStorageQuotaExceeded):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "storage_quota_exceeded"})
	case errors.Is(err, store.ErrConvertInvalid):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "convert_invalid"})
	default:
		a.fail(w, err)
	}
}
