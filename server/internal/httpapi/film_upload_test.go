package httpapi_test

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// A film is stored as uploaded and ready at once, with no ingest job; one
// whose structure does not hold is refused before anything is stored.
func TestFilmUploadsAreCheckedAndStoredReady(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	film, err := os.ReadFile("../cmvfile/testdata/drawn.cmv")
	if err != nil {
		t.Fatal(err)
	}
	const octet = "application/octet-stream"

	cut := film[:len(film)-1]
	rec := postUpload(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("cut.cmv", octet, len(cut)), octet, cut)
	expectStatus(t, rec, http.StatusBadRequest, "upload a cut film")
	if code := errorCode(t, rec); code != "invalid_film" {
		t.Fatalf("cut film refused as %q", code)
	}

	rec = postUpload(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("circle.cmv", octet, len(film)), octet, film)
	expectStatus(t, rec, http.StatusCreated, "upload a film")
	var file struct {
		Kind   string `json:"kind"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil {
		t.Fatal(err)
	}
	if file.Kind != "film" || file.Status != "ready" {
		t.Fatalf("film stored as %+v", file)
	}
}
