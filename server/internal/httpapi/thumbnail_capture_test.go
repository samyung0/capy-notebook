package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// WebP fixtures made with Pillow: a 200x113 lossy slide-shaped capture, a
// 20x12 lossless one, and lossy images one pixel too wide and too tall.
var (
	webpCapture  = mustBase64("UklGRg4BAABXRUJQVlA4IAIBAACwDACdASrIAHEAPrVap04nJSOiJYgA4BaJZW7hceDl3zURipqgCnHy8RWaQOlTfArvxqxjUj6fNWdw3IjrXueOn6g+j42+TSnOpQEmsLprbSYSE1aBSxl3dWPeNgoI8iQmlXHWMe8bBQR5EhNCAAD++K4v+OSR9v/B3u6vhpGI40ONn7gF4N+S6+PduAS5A3mUDsTTiGZaNs1DqOYEW752Vbf4FJf+JZDJooD3zjv49w/ZWQyGCVOBZ4hADx3t5I6AsaXUkpstX03hiaDU/uVH5z+X1dHDtn/OOjowmulQaE7YZVWEY+5eKKFFIrVgM7qxbPVhjoAfJKtkAIaIR86QAAA=")
	webpLossless = mustBase64("UklGRi4AAABXRUJQVlA4TCIAAAAvE8ACAA/wrf9//D/5f/7jAYTZRv3N3/QkziGi/wEA6wAA")
	webpTooWide  = mustBase64("UklGRnoAAABXRUJQVlA4IG4AAADwBACdASrJAAoAPrFInUmnJCKhMSgA4BYJYwDRkf/2RuBp1YjrVSlIcqlQr2nZ4AAA/viuL9yH+rXDwBviwkPU/qbRLw9foM7NMvDd6IWKA4gwAwkPjB71pS2t8kZaaHjhcZNuBTiUOshZ++AAAA==")
	webpTooTall  = mustBase64("UklGRnwAAABXRUJQVlA4IHAAAAAQBgCdASoKAJEBPrVKnkmnJCKhMAgA4BaJYwAjwD9QAKUfLsuFBvk+1UikWMVercXSVr4k0618RAAA/viuL93/gPf/gA7IMGtAmYuHt4z39CY4qOyrfO83e9AN4KjrOwIF7J/aee78ncr4Ve2IgAAA")
)

func mustBase64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

type thumbnailHarness struct {
	h     http.Handler
	st    *store.Store
	blobs *blob.Memory
}

func openThumbnailHarness(t *testing.T) thumbnailHarness {
	t.Helper()
	return openThumbnailHarnessWith(t, blob.NewMemory())
}

// failingPuts is a bucket whose puts fail after writing, as a put whose answer
// was lost would.
type failingPuts struct{ *blob.Memory }

func (f failingPuts) PutObjectOnce(ctx context.Context, key string, body []byte, contentType, cacheControl string) error {
	_ = f.Memory.PutObjectOnce(ctx, key, body, contentType, cacheControl)
	return errors.New("the bucket did not answer")
}

// openThumbnailHarnessWith serves captures into bucket (none when nil).
func openThumbnailHarnessWith(t *testing.T, bucket blob.Store) thumbnailHarness {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	reg, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(reg)
	blobs, _ := bucket.(*blob.Memory)
	h := httpapi.New(st, bucket, nil, nil, "docling", httpapi.Config{
		AuthDisabled:  true,
		E2EAuth:       true,
		E2ESecret:     "e2e-test-secret",
		E2EUserIDs:    []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		ModelRegistry: reg,
	})
	return thumbnailHarness{h: h, st: st, blobs: blobs}
}

// file seeds a ready file in ws and removes it after the test.
func (th thumbnailHarness) file(t *testing.T, id, ws, name, kind string) {
	t.Helper()
	pool := th.st.Pool()
	if _, err := pool.Exec(context.Background(), `INSERT INTO files
		(id, workspace_id, user_id, name, kind, size_bytes, status)
		VALUES ($1,$2,'u_owner',$3,$4,1,'ready')`, id, ws, name, kind); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM files WHERE id=$1`, id)
	})
}

func (th thumbnailHarness) post(t *testing.T, user, fileID string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/files/"+fileID+"/thumbnail", bytes.NewReader(body))
	req.Header.Set("Content-Type", "image/webp")
	if user != "" {
		req.Header.Set(auth.HeaderE2EUserID, user)
		req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	}
	rec := httptest.NewRecorder()
	th.h.ServeHTTP(rec, req)
	return rec
}

func (th thumbnailHarness) key(t *testing.T, fileID string) string {
	t.Helper()
	var key string
	if err := th.st.Pool().QueryRow(context.Background(),
		`SELECT COALESCE(thumbnail_key, '') FROM files WHERE id=$1`, fileID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	return key
}

func captureKey(fileID string, body []byte) string {
	sum := sha256.Sum256(body)
	return "thumbs/" + fileID + "/" + hex.EncodeToString(sum[:]) + ".webp"
}

// stored reports whether the bucket holds key as a WebP.
func (th thumbnailHarness) stored(t *testing.T, key string) bool {
	t.Helper()
	info, err := th.blobs.Head(context.Background(), key)
	if err != nil {
		return false
	}
	if info.ContentType != "image/webp" {
		t.Errorf("%s stored as %q", key, info.ContentType)
	}
	return true
}

func expectStatus(t *testing.T, rec *httptest.ResponseRecorder, want int, what string) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("%s = %d %s, want %d", what, rec.Code, rec.Body.String(), want)
	}
}

func TestThumbnailCaptureStoresAnEditorsWebP(t *testing.T) {
	th := openThumbnailHarness(t)
	th.file(t, "f_capture_deck", "ws_e2e_private", "deck.pptx", "slides")

	expectStatus(t, th.post(t, "u_editor", "f_capture_deck", webpCapture), http.StatusNoContent, "editor capture")
	key := captureKey("f_capture_deck", webpCapture)
	if got := th.key(t, "f_capture_deck"); got != key {
		t.Fatalf("thumbnail_key = %q, want %q", got, key)
	}
	if !th.stored(t, key) {
		t.Fatal("the capture was not written to the bucket")
	}
	// The same bytes again write nothing, so the interval does not refuse them.
	expectStatus(t, th.post(t, "u_owner", "f_capture_deck", webpCapture), http.StatusNoContent, "unchanged capture")

	// Only Office files that open in an editor take captures.
	th.file(t, "f_capture_pdf", "ws_e2e_private", "notes.pdf", "pdf")
	th.file(t, "f_capture_legacy", "ws_e2e_private", "old.ppt", "slides")
	for _, id := range []string{"f_capture_pdf", "f_capture_legacy"} {
		expectStatus(t, th.post(t, "u_owner", id, webpCapture), http.StatusUnprocessableEntity, id)
		if got := th.key(t, id); got != "" {
			t.Errorf("%s took thumbnail_key %q", id, got)
		}
	}
}

// TestThumbnailCaptureRefusesNonEditors (security regression: browser
// captures are editors only, human authorization-permissions-lifecycles
// 2026-10-11). A viewer member, a link reader and a signed-out caller write
// nothing.
func TestThumbnailCaptureRefusesNonEditors(t *testing.T) {
	th := openThumbnailHarness(t)
	th.file(t, "f_capture_private", "ws_e2e_private", "deck.pptx", "slides")
	th.file(t, "f_capture_link", "ws_e2e_link", "sheet.xlsx", "sheet")

	expectStatus(t, th.post(t, "u_viewer", "f_capture_private", webpCapture), http.StatusNotFound, "viewer member")
	expectStatus(t, th.post(t, "u_other", "f_capture_link", webpCapture), http.StatusNotFound, "link reader")
	expectStatus(t, th.post(t, "", "f_capture_private", webpCapture), http.StatusUnauthorized, "signed out")
	for _, id := range []string{"f_capture_private", "f_capture_link"} {
		if got := th.key(t, id); got != "" {
			t.Errorf("%s took thumbnail_key %q", id, got)
		}
		if th.stored(t, captureKey(id, webpCapture)) {
			t.Errorf("%s capture reached the bucket", id)
		}
	}
}

// TestThumbnailCaptureRefusesAnotherWorkspace (security regression: editors
// only). An editor of one workspace cannot capture a file of another.
func TestThumbnailCaptureRefusesAnotherWorkspace(t *testing.T) {
	th := openThumbnailHarness(t)
	th.file(t, "f_capture_elsewhere", "ws_e2e_mutate", "deck.pptx", "slides")

	expectStatus(t, th.post(t, "u_editor", "f_capture_elsewhere", webpCapture), http.StatusNotFound, "editor of another workspace")
	if got := th.key(t, "f_capture_elsewhere"); got != "" {
		t.Errorf("thumbnail_key = %q", got)
	}
	if th.stored(t, captureKey("f_capture_elsewhere", webpCapture)) {
		t.Error("the capture reached the bucket")
	}
}

// TestThumbnailCaptureRefusesBadBodies (security regression: browser captures
// are WebP only, at most 64 KB and 200x400). Each body is refused and writes
// nothing: not WebP, bytes after the RIFF size, a RIFF size past the end, a
// body over 64 KB (413 from the cap, 422 without it), and images one pixel
// too wide or too tall. Chunks inside the RIFF size are checkThumbnailWebP's
// unit tests (thumbnail_webp_test.go).
func TestThumbnailCaptureRefusesBadBodies(t *testing.T) {
	th := openThumbnailHarness(t)
	th.file(t, "f_capture_bodies", "ws_e2e_private", "deck.pptx", "slides")
	png := append([]byte("\x89PNG\r\n\x1a\n"), webpCapture[8:]...)
	trailing := append(append([]byte(nil), webpCapture...), 0, 0)
	short := webpCapture[:len(webpCapture)-2]
	oversized := append(append([]byte(nil), webpCapture...), make([]byte, 64<<10)...)
	cases := []struct {
		name   string
		body   []byte
		status int
	}{
		{"png", png, http.StatusUnprocessableEntity},
		{"trailing bytes", trailing, http.StatusUnprocessableEntity},
		{"truncated", short, http.StatusUnprocessableEntity},
		{"over 64 KB", oversized, http.StatusRequestEntityTooLarge},
		{"201 wide", webpTooWide, http.StatusUnprocessableEntity},
		{"401 tall", webpTooTall, http.StatusUnprocessableEntity},
	}
	for _, c := range cases {
		expectStatus(t, th.post(t, "u_editor", "f_capture_bodies", c.body), c.status, c.name)
		if th.stored(t, captureKey("f_capture_bodies", c.body)) {
			t.Errorf("%s reached the bucket", c.name)
		}
	}
	if got := th.key(t, "f_capture_bodies"); got != "" {
		t.Errorf("thumbnail_key = %q after refused bodies", got)
	}
}

// TestThumbnailCaptureEnforcesTheInterval (security regression: Go enforces a
// minimum interval per item). A second capture of a file within 60 s is
// refused before the bucket; once the interval passed it lands.
func TestThumbnailCaptureEnforcesTheInterval(t *testing.T) {
	th := openThumbnailHarness(t)
	th.file(t, "f_capture_interval", "ws_e2e_private", "sheet.xlsx", "sheet")

	expectStatus(t, th.post(t, "u_editor", "f_capture_interval", webpCapture), http.StatusNoContent, "first capture")
	first := captureKey("f_capture_interval", webpCapture)
	expectStatus(t, th.post(t, "u_owner", "f_capture_interval", webpLossless), http.StatusTooManyRequests, "capture within 60 s")
	if got := th.key(t, "f_capture_interval"); got != first {
		t.Fatalf("thumbnail_key = %q, want the first capture's", got)
	}
	if th.stored(t, captureKey("f_capture_interval", webpLossless)) {
		t.Fatal("the refused capture reached the bucket")
	}
	if _, err := th.st.Pool().Exec(context.Background(), `UPDATE files
		SET thumbnail_captured_at = now() - interval '61 seconds' WHERE id=$1`, "f_capture_interval"); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, th.post(t, "u_owner", "f_capture_interval", webpLossless), http.StatusNoContent, "capture after 60 s")
	if got, want := th.key(t, "f_capture_interval"), captureKey("f_capture_interval", webpLossless); got != want {
		t.Fatalf("thumbnail_key = %q, want %q", got, want)
	}
}

// A put that fails may still have written the object: its key goes to the
// deletion outbox, and the file keeps no key (review T3 S6).
func TestThumbnailCaptureQueuesAFailedPut(t *testing.T) {
	th := openThumbnailHarnessWith(t, failingPuts{blob.NewMemory()})
	th.file(t, "f_capture_failed_put", "ws_e2e_private", "deck.pptx", "slides")

	expectStatus(t, th.post(t, "u_editor", "f_capture_failed_put", webpCapture), http.StatusServiceUnavailable, "failed put")
	if got := th.key(t, "f_capture_failed_put"); got != "" {
		t.Fatalf("thumbnail_key = %q after a failed put", got)
	}
	key := captureKey("f_capture_failed_put", webpCapture)
	var queued bool
	if err := th.st.Pool().QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM pending_blob_deletions WHERE object_path=$1)`, key).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if !queued {
		t.Fatal("the failed put's key was not queued for deletion")
	}
	t.Cleanup(func() {
		_, _ = th.st.Pool().Exec(context.Background(), `DELETE FROM pending_blob_deletions WHERE object_path=$1`, key)
	})
}

// cancellingPuts is a bucket whose put fails because the browser left: the
// request context is cancelled mid-put, after the object may have landed.
type cancellingPuts struct {
	*blob.Memory
	cancel context.CancelFunc
}

func (c cancellingPuts) PutObjectOnce(ctx context.Context, key string, body []byte, contentType, cacheControl string) error {
	_ = c.Memory.PutObjectOnce(ctx, key, body, contentType, cacheControl)
	c.cancel()
	return ctx.Err()
}

type thumbnailSentryTransport struct{ events []*sentry.Event }

func (t *thumbnailSentryTransport) Configure(sentry.ClientOptions)        {}
func (t *thumbnailSentryTransport) SendEvent(e *sentry.Event)             { t.events = append(t.events, e) }
func (t *thumbnailSentryTransport) Flush(time.Duration) bool              { return true }
func (t *thumbnailSentryTransport) FlushWithContext(context.Context) bool { return true }
func (t *thumbnailSentryTransport) Close()                                {}

// A put the browser cancelled by leaving is not a storage failure: no Sentry
// event, though its key is still queued for deletion. A put that fails while
// the browser waits stays a reported 503.
func TestThumbnailCaptureReportsOnlyLiveFailedPuts(t *testing.T) {
	previous := sentry.CurrentHub().Client()
	defer sentry.CurrentHub().BindClient(previous)
	transport := &thumbnailSentryTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	queued := func(th thumbnailHarness, key string) bool {
		t.Helper()
		var queued bool
		if err := th.st.Pool().QueryRow(context.Background(),
			`SELECT EXISTS (SELECT 1 FROM pending_blob_deletions WHERE object_path=$1)`, key).Scan(&queued); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = th.st.Pool().Exec(context.Background(), `DELETE FROM pending_blob_deletions WHERE object_path=$1`, key)
		})
		return queued
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	left := openThumbnailHarnessWith(t, cancellingPuts{blob.NewMemory(), cancel})
	left.file(t, "f_capture_left", "ws_e2e_private", "deck.pptx", "slides")
	req := httptest.NewRequest(http.MethodPost, "/api/files/f_capture_left/thumbnail", bytes.NewReader(webpCapture)).WithContext(ctx)
	req.Header.Set("Content-Type", "image/webp")
	req.Header.Set(auth.HeaderE2EUserID, "u_editor")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	left.h.ServeHTTP(rec, req)
	if rec.Code == http.StatusServiceUnavailable || len(transport.events) != 0 {
		t.Fatalf("a cancelled put: status=%d events=%d", rec.Code, len(transport.events))
	}
	if !queued(left, captureKey("f_capture_left", webpCapture)) {
		t.Fatal("the cancelled put's key was not queued for deletion")
	}

	live := openThumbnailHarnessWith(t, failingPuts{blob.NewMemory()})
	live.file(t, "f_capture_live_failure", "ws_e2e_private", "deck.pptx", "slides")
	expectStatus(t, live.post(t, "u_editor", "f_capture_live_failure", webpCapture), http.StatusServiceUnavailable, "live failed put")
	if len(transport.events) != 1 {
		t.Fatalf("a live failed put sent %d events", len(transport.events))
	}
	queued(live, captureKey("f_capture_live_failure", webpCapture))
}

// Without a bucket a capture is refused before it claims the interval, so the
// next capture once storage is back is not refused as too soon.
func TestThumbnailCaptureWithoutABucketClaimsNothing(t *testing.T) {
	th := openThumbnailHarnessWith(t, nil)
	th.file(t, "f_capture_no_bucket", "ws_e2e_private", "deck.pptx", "slides")

	expectStatus(t, th.post(t, "u_editor", "f_capture_no_bucket", webpCapture), http.StatusServiceUnavailable, "no bucket")
	var claimed bool
	if err := th.st.Pool().QueryRow(context.Background(),
		`SELECT thumbnail_captured_at IS NOT NULL FROM files WHERE id=$1`, "f_capture_no_bucket").Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	if claimed {
		t.Fatal("a capture with nowhere to go claimed the interval")
	}
}
