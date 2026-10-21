package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
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

func sourceUploads(ws string) string { return "/api/workspaces/" + ws + "/sources/uploads" }

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

// leftovers is what refused uploads into ws left behind: sessions not
// released (still holding a reservation) and objects in the bucket.
func leftovers(t *testing.T, th thumbnailHarness, bucket *blob.Memory, ws string) (held int, keys []string) {
	t.Helper()
	ctx := context.Background()
	if err := th.st.Pool().QueryRow(ctx, `SELECT count(*) FROM upload_sessions
		WHERE workspace_id=$1 AND status<>'expired'`, ws).Scan(&held); err != nil {
		t.Fatal(err)
	}
	listing, err := bucket.ListObjects(ctx, "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range listing.Keys {
		keys = append(keys, object.Key)
	}
	return held, keys
}

// Every streamed upload records the SHA-256 the gateway hashed as the bytes
// arrived, whatever its kind (Epo 2026-10-22), under a 128-bit blob key that
// keeps only a plain extension; an Office file's first session names it (Epo
// 2026-10-17).
func TestSourceUploadRecordsTheSHA256OfEveryKind(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	for _, tc := range []struct {
		name, ext, contentType string
		body                   []byte
	}{
		{"plan.docx", ".docx", "application/octet-stream", []byte("PK\x03\x04 a small docx stand-in")},
		{"Notes.PDF", ".pdf", "application/pdf", []byte("%PDF-1.7 stand-in")},
		{"photo.png", ".png", "image/png", []byte("\x89PNG stand-in")},
		{"odd.p df", "", "application/octet-stream", []byte("no plain extension")},
	} {
		rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
			sourceMeta(tc.name, tc.contentType, len(tc.body)), tc.contentType, tc.body)
		expectStatus(t, rec, http.StatusCreated, "upload "+tc.name)
		var file struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(tc.body)
		want := hex.EncodeToString(sum[:])
		if got := fileSourceSHA(t, th, file.ID); got != want {
			t.Fatalf("%s source_sha256 = %q, want %q", tc.name, got, want)
		}
		var key string
		if err := th.st.Pool().QueryRow(context.Background(),
			`SELECT blob_path FROM files WHERE id=$1`, file.ID).Scan(&key); err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`^sources/blob_[0-9a-f]{32}` + regexp.QuoteMeta(tc.ext) + `$`).MatchString(key) {
			t.Fatalf("%s key = %q, want a 128-bit blob id and extension %q", tc.name, key, tc.ext)
		}
		if got, contentType, ok := bucket.Object(key); !ok || !bytes.Equal(got, tc.body) || contentType != tc.contentType {
			t.Fatalf("%s object = %q %q %v", tc.name, got, contentType, ok)
		}
		if tc.ext != ".docx" {
			continue
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
	}
}

// A file part whose type is not the one its metadata names is refused, and
// nothing is written or held.
func TestSourceUploadRefusesAPartOfAnotherType(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	body := []byte("%PDF-1.7")
	rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
		sourceMeta("notes.pdf", "application/pdf", len(body)), "text/html", body)
	expectStatus(t, rec, http.StatusBadRequest, "upload with a part of another type")
	if held, keys := leftovers(t, th, bucket, ws); held != 0 || len(keys) != 0 {
		t.Fatalf("a refused upload left %d held sessions and objects %q", held, keys)
	}
}

// An upload past the uploader's per-file cap is refused without a B2 write:
// one declared over the cap before anything is reserved, and one whose body
// outgrows its declared size once reserved, which releases the reservation.
func TestSourceUploadOverTheCapWritesNothing(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	policy := doReq(t, th.h, http.MethodGet, "/api/source-upload-policy", "u_owner", nil)
	expectStatus(t, policy, http.StatusOK, "upload policy")
	var limits struct {
		MaxBytes int `json:"maxBytes"`
	}
	if err := json.Unmarshal(policy.Body.Bytes(), &limits); err != nil || limits.MaxBytes <= 0 {
		t.Fatalf("policy maxBytes %d: %v", limits.MaxBytes, err)
	}
	over := bytes.Repeat([]byte{'a'}, limits.MaxBytes+1)
	for _, declared := range []int{len(over), 1024} {
		rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
			sourceMeta("big.pdf", "application/pdf", declared), "application/pdf", over)
		expectStatus(t, rec, http.StatusBadRequest, "an upload over the cap")
	}
	if held, keys := leftovers(t, th, bucket, ws); held != 0 || len(keys) != 0 {
		t.Fatalf("refused uploads left %d held sessions and objects %q", held, keys)
	}
}

// stallingPuts lands the object, then holds the PUT until its context ends,
// as a B2 PUT whose answer never comes does; past 5 s it answers, so a
// missing bound fails the test instead of hanging it.
type stallingPuts struct {
	*blob.Memory
	stall bool
}

func (b *stallingPuts) PutObjectOnce(ctx context.Context, key string, body io.ReadSeeker, contentType, cacheControl string) (string, error) {
	etag, err := b.Memory.PutObjectOnce(ctx, key, body, contentType, cacheControl)
	if err != nil || !b.stall {
		return etag, err
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(5 * time.Second):
		return etag, nil
	}
}

// A PUT that stalls past its bound (Epo 2026-10-21/22) fails the upload within
// the bound with the generic 5xx the browser offers a retry on, and leaves no
// object or reservation behind; the user's next upload goes through.
func TestSourceUploadStalledPutLeavesNothing(t *testing.T) {
	httpapi.SetUploadPutBound(t, 100*time.Millisecond)
	bucket := &stallingPuts{Memory: blob.NewMemory(), stall: true}
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	body := []byte("PK\x03\x04 a stalled docx")
	start := time.Now()
	rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
		sourceMeta("plan.docx", "application/octet-stream", len(body)), "application/octet-stream", body)
	expectStatus(t, rec, http.StatusInternalServerError, "an upload whose PUT stalls")
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("the stalled upload answered after %v", took)
	}
	if held, keys := leftovers(t, th, bucket.Memory, ws); held != 0 || len(keys) != 0 {
		t.Fatalf("the stalled upload left %d held sessions and objects %q", held, keys)
	}
	bucket.stall = false
	rec = postUpload(t, th.h, sourceUploads(ws), "u_owner",
		sourceMeta("plan.docx", "application/octet-stream", len(body)), "application/octet-stream", body)
	expectStatus(t, rec, http.StatusCreated, "the next upload")
}

// Editor assets follow the same rules (Epo 2026-10-22): the payer's cap, the
// part's type, the bytes' signature and the PUT's bound; a refusal leaves no
// object and no pending asset behind.
func TestEditorAssetUploadFollowsTheUploadRules(t *testing.T) {
	httpapi.SetUploadPutBound(t, 100*time.Millisecond)
	bucket := &stallingPuts{Memory: blob.NewMemory()}
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	ctx := context.Background()
	note, err := th.st.CreateMaterial(ctx, store.Material{CreatedBy: "u_owner", WorkspaceID: ws,
		Kind: "note", Title: "Figures", Content: noteTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, th.st, note.ID)
	material := doReq(t, th.h, http.MethodGet, "/api/materials/"+note.ID, "u_owner", nil)
	expectStatus(t, material, http.StatusOK, "material")
	var limits struct {
		ImageMaxBytes int `json:"imageMaxBytes"`
	}
	if err := json.Unmarshal(material.Body.Bytes(), &limits); err != nil || limits.ImageMaxBytes <= 0 {
		t.Fatalf("material imageMaxBytes %d: %v", limits.ImageMaxBytes, err)
	}
	path := "/api/materials/" + note.ID + "/editor-assets/uploads"
	meta := func(size int) map[string]any {
		return map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": size, "contentType": "image/png"}
	}
	png := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, bytes.Repeat([]byte{7}, 100)...)
	notPNG := bytes.Repeat([]byte{7}, len(png))
	for _, tc := range []struct {
		what     string
		size     int
		partType string
		body     []byte
		stall    bool
		status   int
	}{
		{"over the cap", limits.ImageMaxBytes + 1, "image/png", png, false, http.StatusBadRequest},
		{"a part of another type", len(png), "image/gif", png, false, http.StatusBadRequest},
		{"bytes of another type", len(notPNG), "image/png", notPNG, false, http.StatusBadRequest},
		{"a stalled PUT", len(png), "image/png", png, true, http.StatusInternalServerError},
	} {
		bucket.stall = tc.stall
		start := time.Now()
		rec := postUpload(t, th.h, path, "u_owner", meta(tc.size), tc.partType, tc.body)
		expectStatus(t, rec, tc.status, "an editor asset with "+tc.what)
		if took := time.Since(start); took > 2*time.Second {
			t.Fatalf("an editor asset with %s answered after %v", tc.what, took)
		}
	}
	var assets int
	if err := th.st.Pool().QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE material_id=$1`, note.ID).
		Scan(&assets); err != nil {
		t.Fatal(err)
	}
	if _, keys := leftovers(t, th, bucket.Memory, ws); assets != 0 || len(keys) != 0 {
		t.Fatalf("refused editor assets left %d asset rows and objects %q", assets, keys)
	}
	bucket.stall = false
	rec := postUpload(t, th.h, path, "u_owner", meta(len(png)), "image/png", png)
	expectStatus(t, rec, http.StatusCreated, "the next editor asset")
}
