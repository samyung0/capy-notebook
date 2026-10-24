package httpapi_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// uploadSource lands a file the way a browser upload does: reserve an upload
// session, then finalize it (no ingest job unless the format needs one).
func uploadSource(ctx context.Context, st *store.Store, wsID, actorID, name string, size int64, blobPath string) (store.File, error) {
	id := fmt.Sprintf("up_%d", time.Now().UnixNano())
	if _, err := st.CreateUploadSession(ctx, store.NewUploadSession{
		ID: id, WorkspaceID: wsID, CreatedBy: actorID,
		ObjectPath: blobPath, FinalPath: blobPath,
		Name: name, Kind: sourceupload.KindFromName(name),
		ContentType: "application/octet-stream", DeclaredSize: size,
		ParseMode: sourceupload.ParseModeNone, ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		return store.File{}, err
	}
	return st.FinalizeUploadSession(ctx, actorID, id, "etag-"+id, "", "")
}

// formPart is one part of a multipart upload body; a part with a content type
// is a file part.
type formPart struct {
	name, contentType string
	body              []byte
}

// metadataPart is meta as an upload's metadata part.
func metadataPart(t *testing.T, meta map[string]any) formPart {
	t.Helper()
	body, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	return formPart{name: "metadata", body: body}
}

// countedBody is a request body that counts the bytes the handler read.
type countedBody struct {
	r    io.Reader
	read int64
}

func (c *countedBody) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read += int64(n)
	return n, err
}

// postForm posts parts in order, as a browser's FormData sends them, and
// returns the answer and the body, which counts what the handler read.
func postForm(t *testing.T, h http.Handler, path, userID string, parts ...formPart) (*httptest.ResponseRecorder, *countedBody) {
	t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	for _, p := range parts {
		header := textproto.MIMEHeader{"Content-Disposition": {`form-data; name="` + p.name + `"`}}
		if p.contentType != "" {
			header.Set("Content-Disposition", `form-data; name="`+p.name+`"; filename="upload"`)
			header.Set("Content-Type", p.contentType)
		}
		part, err := form.CreatePart(header)
		if err == nil {
			_, err = part.Write(p.body)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	body := &countedBody{r: &buf}
	req := httptest.NewRequest(http.MethodPost, path, body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set(auth.HeaderE2EUserID, userID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(deadlineRecorder{rec}, req)
	return rec, body
}

// deadlineRecorder takes the deadline an upload sets on its body as the
// server's connection does; TestUploadBodyIsCutOffAfterItsDeadline runs the
// real one.
type deadlineRecorder struct{ *httptest.ResponseRecorder }

func (deadlineRecorder) SetReadDeadline(time.Time) error { return nil }

// ticketTurn is an upload ticket's answer.
type ticketTurn struct {
	TicketID string `json:"ticketId"`
	Position int    `json:"position"`
}

// takeTicket asks the upload route at path for a ticket for meta.
func takeTicket(t *testing.T, h http.Handler, path, userID string, meta map[string]any) (*httptest.ResponseRecorder, ticketTurn) {
	t.Helper()
	body, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path+"/tickets", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderE2EUserID, userID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(deadlineRecorder{rec}, req)
	var turn ticketTurn
	if rec.Code == http.StatusCreated {
		if err := json.Unmarshal(rec.Body.Bytes(), &turn); err != nil {
			t.Fatal(err)
		}
	}
	return rec, turn
}

// ticketed is path with a ticket for meta whose turn has come.
func ticketed(t *testing.T, h http.Handler, path, userID string, meta map[string]any) string {
	t.Helper()
	rec, turn := takeTicket(t, h, path, userID, meta)
	if rec.Code != http.StatusCreated || turn.Position != 0 {
		t.Fatalf("ticket for %s: %d %s", path, rec.Code, rec.Body.String())
	}
	return path + "?ticket=" + turn.TicketID
}

// postUpload uploads body as the browser does: it takes the upload's ticket,
// whose refusal it returns, then streams the metadata part and the file part
// of partType.
func postUpload(t *testing.T, h http.Handler, path, userID string, meta map[string]any, partType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	rec, turn := takeTicket(t, h, path, userID, meta)
	if rec.Code != http.StatusCreated {
		return rec
	}
	if turn.Position != 0 {
		t.Fatalf("ticket for %s waits at %d", path, turn.Position)
	}
	rec, _ = postForm(t, h, path+"?ticket="+turn.TicketID, userID,
		metadataPart(t, meta), formPart{name: "file", contentType: partType, body: body})
	return rec
}

// testPNG is a 1x1 PNG's signature and header padded to size bytes: what
// the gateway's header check reads (imagecheck), with no pixels behind it.
func testPNG(size int) []byte {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00")
	png = binary.BigEndian.AppendUint32(png, crc32.ChecksumIEEE(png[12:]))
	return append(png, make([]byte, max(0, size-len(png)))...)
}

// sourceMeta is a source upload's metadata in a batch of its own.
func sourceMeta(name, contentType string, size int) map[string]any {
	return map[string]any{
		"name": name, "parseMode": "none", "sizeBytes": size, "contentType": contentType,
		"batchId": fmt.Sprintf("sb_%d", time.Now().UnixNano()), "batchTotal": 1,
	}
}
