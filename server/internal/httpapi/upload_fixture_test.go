package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

// postUpload streams body to an upload route as the browser does: a multipart
// POST whose "metadata" part is meta as JSON and whose "file" part carries
// partType.
func postUpload(t *testing.T, h http.Handler, path, userID string, meta map[string]any, partType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	field, err := form.CreateFormField("metadata")
	if err == nil {
		err = json.NewEncoder(field).Encode(meta)
	}
	if err != nil {
		t.Fatal(err)
	}
	part, err := form.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="file"; filename="upload"`},
		"Content-Type":        {partType},
	})
	if err == nil {
		_, err = part.Write(body)
	}
	if err == nil {
		err = form.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, &buf)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set(auth.HeaderE2EUserID, userID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// sourceMeta is a source upload's metadata in a batch of its own.
func sourceMeta(name, contentType string, size int) map[string]any {
	return map[string]any{
		"name": name, "parseMode": "none", "sizeBytes": size, "contentType": contentType,
		"batchId": fmt.Sprintf("sb_%d", time.Now().UnixNano()), "batchTotal": 1,
	}
}
