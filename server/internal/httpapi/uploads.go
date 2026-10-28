package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
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
// finalizes the row, all in that request. The request carries a ticket whose
// turn has come (upload_queue.go) and has bodyDeadline to send its body.

// uploadMetadataMaxBytes bounds the metadata part and the multipart framing
// around the file part.
const uploadMetadataMaxBytes = 64 << 10

// uploadSessionTTL outlasts the slowest body an upload request reads; the
// sweeper releases a reservation that a crashed request left pending. A
// failed upload's object is left to the reaper, which checks references
// before it deletes.
const uploadSessionTTL = time.Hour

// uploadPutBound bounds an upload's one B2 PUT (Epo 2026-10-21, kept
// 2026-10-22); tests shorten it.
var uploadPutBound = 60 * time.Second

// uploadBody is an upload's multipart body on its clock.
type uploadBody struct {
	form *multipart.Reader
	conn *http.ResponseController
}

// uploadSpoolPattern names an upload body's spool in the temp directory.
const uploadSpoolPattern = "upload-*"

// RemoveUploadSpools deletes the body spools in dir that a process left when
// it died mid-upload; the API calls it at startup, before it serves, since a
// restarted container keeps its temp directory.
func RemoveUploadSpools(dir string) {
	spools, err := filepath.Glob(filepath.Join(dir, uploadSpoolPattern))
	if err != nil {
		log.Printf("list upload spools: %v", err)
		return
	}
	for _, spool := range spools {
		if err := os.Remove(spool); err != nil {
			log.Printf("remove upload spool %s: %v", spool, err)
		}
	}
}

// readUploadMetadata starts the body's clock (bodyDeadline of the declared
// size its ticket names), decodes the metadata part into v and returns the
// body positioned for the file part. The caller has capped r.Body.
func readUploadMetadata(w http.ResponseWriter, r *http.Request, size int64, v any) (*uploadBody, error) {
	conn := http.NewResponseController(w)
	if err := conn.SetReadDeadline(time.Now().Add(bodyDeadline(size))); err != nil {
		return nil, err
	}
	// The answer follows the body, the bucket PUT and the bookkeeping, past
	// the server's write timeout for a slow allowed upload.
	if err := conn.SetWriteDeadline(time.Now().Add(bodyDeadline(size) + uploadPutBound + time.Minute)); err != nil {
		return nil, err
	}
	form, err := r.MultipartReader()
	if err != nil {
		return nil, huma.Error400BadRequest("an upload is a multipart body")
	}
	part, err := form.NextPart()
	if err != nil || part.FormName() != "metadata" {
		return nil, bodyError(err, "an upload starts with its metadata part")
	}
	if err := json.NewDecoder(io.LimitReader(part, uploadMetadataMaxBytes)).Decode(v); err != nil {
		return nil, bodyError(err, "invalid upload metadata")
	}
	return &uploadBody{form: form, conn: conn}, nil
}

// spoolUpload reads the file part into a temporary file, hashing it as it
// streams, and refuses a part that is not size bytes of contentType or that
// anything follows. The PUT reads the rewound file, so its 60 s bound covers
// B2 alone, never the browser's upload. The caller removes the file with
// dropSpool.
func spoolUpload(body *uploadBody, size int64, contentType string) (*os.File, string, error) {
	form := body.form
	part, err := form.NextPart()
	if err != nil || part.FormName() != "file" {
		return nil, "", bodyError(err, "an upload carries its file part after the metadata")
	}
	got, err := normalizeMediaType(part.Header.Get("Content-Type"))
	want, _ := normalizeMediaType(contentType)
	if err != nil || got != want {
		return nil, "", huma.Error400BadRequest("uploaded content type does not match the upload's metadata")
	}
	spool, err := os.CreateTemp("", uploadSpoolPattern)
	if err != nil {
		return nil, "", err
	}
	hash := sha256.New()
	read := &bodyReader{r: io.LimitReader(part, size+1)}
	n, err := io.Copy(io.MultiWriter(spool, hash), read)
	switch {
	case read.err != nil:
		err = bodyError(read.err, "the upload ended early")
	case err == nil && n != size:
		err = huma.Error400BadRequest("uploaded size does not match the upload's metadata")
	case err == nil:
		if _, next := form.NextPart(); !errors.Is(next, io.EOF) {
			err = bodyError(next, "an upload carries nothing after its file part")
		}
	}
	// The body is read: its clock stops, so it never cuts the PUT, whose
	// context the connection's next read would cancel.
	if err == nil {
		err = body.conn.SetReadDeadline(time.Time{})
	}
	if err == nil {
		_, err = spool.Seek(0, io.SeekStart)
	}
	if err != nil {
		dropSpool(spool)
		return nil, "", err
	}
	return spool, hex.EncodeToString(hash.Sum(nil)), nil
}

// bodyReader keeps the error of the body it reads, so a failed spool tells a
// body the client cut off from a write the gateway failed.
type bodyReader struct {
	r   io.Reader
	err error
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err != nil && err != io.EOF {
		b.err = err
	}
	return n, err
}

// readTicketMetadata decodes a ticket request's JSON body within
// uploadTicketReadBound, then lifts the deadline so it never cancels the
// checks that follow.
func readTicketMetadata(w http.ResponseWriter, r *http.Request, v any) error {
	conn := http.NewResponseController(w)
	if err := conn.SetReadDeadline(time.Now().Add(uploadTicketReadBound)); err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, uploadMetadataMaxBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return huma.NewError(http.StatusRequestTimeout, "the ticket request took too long to send")
		}
		return bodyError(err, "invalid upload metadata")
	}
	return conn.SetReadDeadline(time.Time{})
}

// bodyError refuses a body the client sent wrong: past the cap is 413, past
// its deadline 408, and anything else (a cut-off, malformed or misordered
// body) a 400 with msg.
func bodyError(err error, msg string) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return huma.Error413RequestEntityTooLarge("the upload is larger than the per-file limit")
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		// Typed, for the browser's own copy.
		return &huma.ErrorModel{
			Status: http.StatusRequestTimeout,
			Title:  http.StatusText(http.StatusRequestTimeout),
			Detail: "the upload took too long to send",
			Errors: []*huma.ErrorDetail{{Message: "upload_timeout"}},
		}
	}
	return huma.Error400BadRequest(msg)
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

// failUpload answers a refused upload. What is left of the body is not read:
// the connection closes after the answer.
func (a *api) failUpload(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Connection", "close")
	answerError(w, r, err)
}

// answerError answers err as the JSON operations answer errors
// (reportHandlerError).
func answerError(w http.ResponseWriter, r *http.Request, err error) {
	var status huma.StatusError
	if !errors.As(err, &status) {
		err = hErr(err)
	}
	answer := reportHandlerError(r.Context(), err)
	errors.As(answer, &status)
	writeJSON(w, status.GetStatus(), answer)
}
