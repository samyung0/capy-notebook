package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// The e2e stack's memory store serves its objects under blob.ServedPath with
// no session (the browser and the collaboration server read source bases
// there); a store that is not served registers no such route.
func TestOnlyTheServedMemoryStoreServesItsObjects(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	registry, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(registry)
	config := httpapi.Config{
		AuthDisabled:  true,
		E2EAuth:       true,
		E2ESecret:     "e2e-test-secret",
		E2EUserIDs:    []string{"u_owner"},
		ModelRegistry: registry,
	}
	served := blob.NewServedMemory()
	handler := httpapi.New(st, served, nil, nil, "opendataloader", config)
	upload, err := served.PresignPut(ctx, "sources/a.md", "text/markdown", 5)
	if err != nil || upload.URL != blob.ServedPath+"sources/a.md" {
		t.Fatalf("put URL = %q, %v", upload.URL, err)
	}
	put := httptest.NewRequest(http.MethodPut, upload.URL, strings.NewReader("hello"))
	put.Header.Set("Content-Type", "text/markdown")
	putAnswer := httptest.NewRecorder()
	handler.ServeHTTP(putAnswer, put)
	if putAnswer.Code != http.StatusOK {
		t.Fatalf("put = %d %s", putAnswer.Code, putAnswer.Body.String())
	}
	link, err := served.PresignGet(ctx, "sources/a.md")
	if err != nil || link != upload.URL {
		t.Fatalf("get URL = %q, %v", link, err)
	}
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, link, nil))
	// Answered as the bucket answers a read link (blob.ReadHeaders), whatever
	// type the upload declared.
	if get.Code != http.StatusOK || get.Body.String() != "hello" ||
		get.Header().Get("Content-Type") != "application/octet-stream" ||
		get.Header().Get("Content-Disposition") != "attachment" {
		t.Fatalf("get = %d %q %q %q", get.Code, get.Body.String(),
			get.Header().Get("Content-Type"), get.Header().Get("Content-Disposition"))
	}

	plain := blob.NewMemory()
	if _, _, err := plain.Put("sources/a.md", strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}
	unserved := httptest.NewRecorder()
	httpapi.New(st, plain, nil, nil, "opendataloader", config).
		ServeHTTP(unserved, httptest.NewRequest(http.MethodGet, blob.ServedPath+"sources/a.md", nil))
	if unserved.Code == http.StatusOK || strings.Contains(unserved.Body.String(), "hello") {
		t.Fatalf("an unserved store answered %d %q", unserved.Code, unserved.Body.String())
	}
}
