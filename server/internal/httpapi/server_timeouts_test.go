package httpapi_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// shortTimeouts serves h with the API server's settings, its read and write
// timeouts cut to 300 ms so a test can outlast them.
func shortTimeouts(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(h)
	configured := httpapi.NewServer("", h)
	if configured.ReadTimeout <= 0 || configured.WriteTimeout <= 0 || configured.IdleTimeout <= 0 {
		t.Fatalf("API server timeouts read %v write %v idle %v, want all set",
			configured.ReadTimeout, configured.WriteTimeout, configured.IdleTimeout)
	}
	server.Config.ReadTimeout, server.Config.WriteTimeout = 300*time.Millisecond, 300*time.Millisecond
	server.Start()
	t.Cleanup(server.Close)
	return server
}

// TestEventStreamOutlivesServerTimeouts (security regression: rate-limit
// audit L3). The API server has read and write timeouts, and /api/stream
// extends its own deadlines: an event published after both have passed still
// arrives.
func TestEventStreamOutlivesServerTimeouts(t *testing.T) {
	redisURL := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("no disposable Redis; run `pnpm test:go` from the repository root")
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	t.Cleanup(func() { _ = rdb.Close() })
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	const userID = "u_long_stream"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email) VALUES ($1, 'Long', 'long-stream@example.test')
		ON CONFLICT (id) DO NOTHING`, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })
	server := shortTimeouts(t, httpapi.New(st, blob.NewMemory(), nil, rdb, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID}))
	res, err := http.Get(server.URL + "/api/stream")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	lines := make(chan string, 64)
	go func() {
		scanner := bufio.NewScanner(res.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	expect := func(want string) {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("stream ended before %q", want)
				}
				if strings.Contains(line, want) {
					return
				}
			case <-deadline:
				t.Fatalf("no line containing %q", want)
			}
		}
	}
	expect(": connected")
	time.Sleep(900 * time.Millisecond)
	rdb.Publish(ctx, "notif:"+userID, `{"type":"created"}`)
	expect(`data: {"type":"created"}`)
}

// TestSlowAllowedUploadFinishesPastServerTimeouts (security regression:
// rate-limit audit L3). An upload sending within its own body deadline is
// answered even when it outlasts the server's read and write timeouts.
func TestSlowAllowedUploadFinishesPastServerTimeouts(t *testing.T) {
	httpapi.SetUploadQueueTimings(t, 30*time.Second, 10*time.Second, 25*time.Second)
	th := openThumbnailHarness(t)
	ws := uploadWorkspace(t, th)
	server := shortTimeouts(t, th.h)
	const chunks = 8
	meta := sourceMeta("slow.pdf", "application/pdf", chunks<<10)
	route := ticketed(t, th.h, sourceUploads(ws), "u_owner", meta)

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	metadata, _ := json.Marshal(meta)
	part, _ := form.CreatePart(textproto.MIMEHeader{"Content-Disposition": {`form-data; name="metadata"`}})
	_, _ = part.Write(metadata)
	part, _ = form.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="file"; filename="upload"`},
		"Content-Type":        {"application/pdf"},
	})
	_, _ = part.Write(append([]byte("%PDF-1.7"), bytes.Repeat([]byte{'a'}, chunks<<10-8)...))
	_ = form.Close()
	req, err := http.NewRequest(http.MethodPost, server.URL+route, &trickle{data: body.Bytes(), piece: body.Len()/chunks + 1})
	if err != nil {
		t.Fatal(err)
	}
	req.ContentLength = int64(body.Len())
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set(auth.HeaderE2EUserID, "u_owner")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("the slow upload got no answer: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("the slow upload = %d, want 201", res.StatusCode)
	}
}

// trickle sends data in pieces 120 ms apart, a slow but steady browser.
type trickle struct {
	data    []byte
	piece   int
	started bool
}

func (t *trickle) Read(p []byte) (int, error) {
	if len(t.data) == 0 {
		return 0, io.EOF
	}
	if t.started {
		time.Sleep(120 * time.Millisecond)
	}
	t.started = true
	n := copy(p, t.data[:min(t.piece, len(t.data))])
	t.data = t.data[n:]
	return n, nil
}
