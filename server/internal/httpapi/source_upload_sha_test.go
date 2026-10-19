package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// uploadWorkspace is a workspace of u_owner's own for the uploads a test
// lands, removed with its files after the test.
func uploadWorkspace(t *testing.T, th thumbnailHarness) string {
	t.Helper()
	ctx := context.Background()
	ws, err := th.st.CreateWorkspace(ctx, "u_owner", store.WorkspaceCreate{Name: "Upload SHA", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool := th.st.Pool()
		_, _ = pool.Exec(ctx, `DELETE FROM files WHERE workspace_id=$1`, ws.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM upload_sessions WHERE workspace_id=$1`, ws.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, ws.ID)
	})
	return ws.ID
}

// putUpload reserves an upload of body as the browser does and writes it to
// the reserved bucket key; it returns the upload id.
func putUpload(t *testing.T, th thumbnailHarness, bucket *blob.Memory, ws, name string, body []byte) string {
	t.Helper()
	rec := doReq(t, th.h, http.MethodPost, "/api/workspaces/"+ws+"/sources/uploads", "u_owner", map[string]any{
		"name": name, "parseMode": "none", "sizeBytes": len(body),
		"contentType": "application/octet-stream",
		"batchId":     fmt.Sprintf("sb_%d", time.Now().UnixNano()), "batchTotal": 1,
	})
	expectStatus(t, rec, http.StatusCreated, "reserve "+name)
	var reserved struct {
		UploadID string `json:"uploadId"`
		URL      string `json:"url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &reserved); err != nil {
		t.Fatal(err)
	}
	key := strings.TrimPrefix(reserved.URL, "memory-put://")
	if err := bucket.PutObjectOnce(context.Background(), key, body, "application/octet-stream", ""); err != nil {
		t.Fatal(err)
	}
	return reserved.UploadID
}

func fileSourceSHA(t *testing.T, th thumbnailHarness, fileID string) string {
	t.Helper()
	var sha *string
	if err := th.st.Pool().QueryRow(context.Background(),
		`SELECT source_sha256 FROM files WHERE id=$1`, fileID).Scan(&sha); err != nil {
		t.Fatal(err)
	}
	if sha == nil {
		return ""
	}
	return *sha
}

// A completed upload of a file with source sessions records the SHA-256 of
// the bytes the bucket holds, hashed by the gateway, so the first session
// names it (Epo 2026-10-17); a file without source sessions is not read.
func TestSourceUploadCompletionRecordsTheStoredSHA256(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	body := []byte("PK\x03\x04 a small docx stand-in")
	sum := sha256.Sum256(body)
	want := hex.EncodeToString(sum[:])

	upload := putUpload(t, th, bucket, ws, "plan.docx", body)
	rec := doReq(t, th.h, http.MethodPost, "/api/workspaces/"+ws+"/sources/uploads/"+upload+"/complete", "u_owner", nil)
	expectStatus(t, rec, http.StatusCreated, "complete docx")
	var file struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil {
		t.Fatal(err)
	}
	if got := fileSourceSHA(t, th, file.ID); got != want {
		t.Fatalf("source_sha256 = %q, want %q", got, want)
	}
	view := doReq(t, th.h, http.MethodGet, "/api/files/"+file.ID+"/source-session?view=true", "u_owner", nil)
	expectStatus(t, view, http.StatusOK, "view session")
	var session struct {
		BaseSourceSHA256 string `json:"baseSourceSHA256"`
	}
	if err := json.Unmarshal(view.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.BaseSourceSHA256 != want {
		t.Fatalf("first session names %q, want %q", session.BaseSourceSHA256, want)
	}

	pdf := putUpload(t, th, bucket, ws, "notes.pdf", []byte("%PDF-1.7 stand-in"))
	rec = doReq(t, th.h, http.MethodPost, "/api/workspaces/"+ws+"/sources/uploads/"+pdf+"/complete", "u_owner", nil)
	expectStatus(t, rec, http.StatusCreated, "complete pdf")
	if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil {
		t.Fatal(err)
	}
	if got := fileSourceSHA(t, th, file.ID); got != "" {
		t.Fatalf("a PDF upload recorded %q", got)
	}
}

// changedReads is a bucket whose reads return other bytes than its HEAD
// reported, as an object replaced mid-completion would.
type changedReads struct{ *blob.Memory }

func (changedReads) Open(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader([]byte("other"))), nil
}

// Bytes read back that do not match the object the completion checked are
// refused: no file is created, and the upload stays pending for a retry.
func TestSourceUploadCompletionRefusesBytesThatDoNotMatchTheObject(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, changedReads{bucket})
	ws := uploadWorkspace(t, th)
	upload := putUpload(t, th, bucket, ws, "plan.docx", []byte("PK\x03\x04 the uploaded docx"))
	rec := doReq(t, th.h, http.MethodPost, "/api/workspaces/"+ws+"/sources/uploads/"+upload+"/complete", "u_owner", nil)
	expectStatus(t, rec, http.StatusConflict, "complete with changed bytes")
	var status string
	if err := th.st.Pool().QueryRow(context.Background(),
		`SELECT status FROM upload_sessions WHERE id=$1 AND file_id IS NULL`, upload).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("upload after a refused completion: status=%q err=%v", status, err)
	}
}

// Object keys carry 128 random bits and a plain extension only, and a
// completion whose object reports no Content-Type is a mismatch (security
// review E-F1, E-F2, E-F5, 2026-10-19).
func TestSourceUploadKeysAndTypeCheck(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	for _, tc := range []struct{ name, ext string }{
		{"Notes.PDF", ".pdf"},
		{"odd.p df", ""},
		{"tab.pd\tf", ""},
		{"long.abcdefghijkl", ""},
	} {
		rec := doReq(t, th.h, http.MethodPost, "/api/workspaces/"+ws+"/sources/uploads", "u_owner", map[string]any{
			"name": tc.name, "parseMode": "none", "sizeBytes": 4, "contentType": "application/octet-stream",
			"batchId": fmt.Sprintf("sb_%d", time.Now().UnixNano()), "batchTotal": 1,
		})
		expectStatus(t, rec, http.StatusCreated, "reserve "+tc.name)
		var reserved struct {
			UploadID string `json:"uploadId"`
			URL      string `json:"url"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &reserved); err != nil {
			t.Fatal(err)
		}
		got := strings.TrimPrefix(reserved.URL, "memory-put://")
		key := regexp.MustCompile(`^incoming/up_[0-9a-f]{10}/blob_[0-9a-f]{32}` + regexp.QuoteMeta(tc.ext) + `$`)
		if !key.MatchString(got) {
			t.Fatalf("%q key = %q, want 128-bit blob id and extension %q", tc.name, got, tc.ext)
		}
		if tc.ext != ".pdf" {
			continue
		}
		// B2 reporting no type is not a pass.
		if err := bucket.PutObjectOnce(context.Background(), got, []byte("%PDF"), "", ""); err != nil {
			t.Fatal(err)
		}
		rec = doReq(t, th.h, http.MethodPost, "/api/workspaces/"+ws+"/sources/uploads/"+reserved.UploadID+"/complete", "u_owner", nil)
		expectStatus(t, rec, http.StatusBadRequest, "complete with no content type")
	}
}
