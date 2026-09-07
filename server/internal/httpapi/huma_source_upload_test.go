package httpapi_test

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func multipartUpload(t *testing.T, h http.Handler, wsID, userID, name string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "notes.md")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("# notes"))
	_ = form.WriteField("name", name)
	_ = form.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+wsID+"/sources", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set(auth.HeaderE2EUserID, userID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// The multipart route validates its text parts like a JSON body, after the
// editor check in its middleware and before the handler runs.
func TestUploadSourceValidatesName(t *testing.T) {
	h, st := openInternalHTTP(t)
	ws, err := st.CreateWorkspace(context.Background(), "u_owner", "Uploads", store.ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}

	rec := multipartUpload(t, h, ws.ID, "u_owner", strings.Repeat("a", fieldlimits.FileName+1)+".md")
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "form.name") {
		t.Fatalf("long name: %d %s", rec.Code, rec.Body.String())
	}
	// A stranger with an invalid name gets the editor check's 404, not a 422:
	// authorization runs in the middleware before the form is validated.
	if rec := multipartUpload(t, h, ws.ID, "u_other", strings.Repeat("a", fieldlimits.FileName+1)+".md"); rec.Code != http.StatusNotFound {
		t.Fatalf("stranger: %d %s", rec.Code, rec.Body.String())
	}
	rec = multipartUpload(t, h, ws.ID, "u_owner", strings.Repeat("a", fieldlimits.FileName-3)+".md")
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
}
