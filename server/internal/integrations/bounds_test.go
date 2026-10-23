package integrations

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// gatedBody sends its first piece, then holds the rest until the reader's
// destination has received bytes (or a few seconds pass).
type gatedBody struct {
	first, rest []byte
	received    chan struct{}
	sentFirst   bool
}

func (g *gatedBody) Read(p []byte) (int, error) {
	if !g.sentFirst {
		g.sentFirst = true
		return copy(p, g.first), nil
	}
	select {
	case <-g.received:
	case <-time.After(3 * time.Second):
		return 0, errors.New("the object was held whole before any byte went out")
	}
	if len(g.rest) == 0 {
		return 0, io.EOF
	}
	n := copy(p, g.rest)
	g.rest = g.rest[n:]
	return n, nil
}

func (g *gatedBody) Close() error { return nil }

// signalWriter counts what it is sent and signals the first byte; it has no
// ReadFrom, so a copy into it goes through Write.
type signalWriter struct {
	n        int
	received chan struct{}
}

func (w *signalWriter) Write(p []byte) (int, error) {
	if w.n == 0 && len(p) > 0 {
		close(w.received)
	}
	w.n += len(p)
	return len(p), nil
}

// TestDownloadImportFileStreams (security regression: rate-limit audit M10).
// The provider object reaches the destination while the provider is still
// sending it, so the gateway never holds a whole file.
func TestDownloadImportFileStreams(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	usePublicImportHostResolver(t)
	received := make(chan struct{})
	body := &gatedBody{first: []byte("%PDF-1.7"), rest: bytes.Repeat([]byte{'a'}, 256<<10), received: received}
	calls := 0
	providerHTTP = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(
				`{"name":"Notes","mimeType":"application/vnd.google-apps.document","capabilities":{"canDownload":true}}`))}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/pdf"}}, Body: body, Request: req}, nil
	})}
	dst := &signalWriter{received: received}
	if _, err := DownloadImportFile(context.Background(), ProviderGoogle, "token", ImportRef{ID: "file_1"}, 1<<20, dst); err != nil {
		t.Fatal(err)
	}
	if dst.n != 8+256<<10 {
		t.Fatalf("streamed %d bytes", dst.n)
	}
}

// TestProviderReadsAreBounded (security regression: rate-limit audit L11).
// Every whole-body read of a provider response in this package goes through
// a size bound.
func TestProviderReadsAreBounded(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	readAll := regexp.MustCompile(`io\.ReadAll\(([^)]*)\)`)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		source, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, call := range readAll.FindAllStringSubmatch(string(source), -1) {
			if !strings.HasPrefix(call[1], "io.LimitReader(") {
				t.Errorf("%s: %s reads a provider body without a bound", name, call[0])
			}
		}
	}
}

// slowWriter takes each write after a pause, as a slow browser does.
type slowWriter struct {
	n     int
	pause time.Duration
}

func (w *slowWriter) Write(p []byte) (int, error) {
	time.Sleep(w.pause)
	w.n += len(p)
	return len(p), nil
}

// ctxBody hands its bytes out 1 KiB at a time and fails once the request's
// context ends, as a connection does.
type ctxBody struct {
	ctx  context.Context
	data []byte
}

func (b *ctxBody) Read(p []byte) (int, error) {
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p[:min(len(p), 1<<10)], b.data)
	b.data = b.data[n:]
	return n, nil
}

func (b *ctxBody) Close() error { return nil }

// TestDownloadImportFileOutlastsTheProviderTimeout (security regression:
// rate-limit audit M10, review M-1). The provider client's total timeout
// (50 ms here) does not cut a download that a slow reader is still taking
// (ten writes of 25 ms); the caller's context bounds it instead.
func TestDownloadImportFileOutlastsTheProviderTimeout(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	usePublicImportHostResolver(t)
	data := bytes.Repeat([]byte{'a'}, 10<<10)
	calls := 0
	providerHTTP = &http.Client{Timeout: 50 * time.Millisecond, Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(
				`{"name":"Notes","mimeType":"application/vnd.google-apps.document","capabilities":{"canDownload":true}}`))}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/pdf"}},
			Body: &ctxBody{ctx: req.Context(), data: data}, Request: req}, nil
	})}
	dst := &slowWriter{pause: 25 * time.Millisecond}
	if _, err := DownloadImportFile(context.Background(), ProviderGoogle, "token", ImportRef{ID: "file_1"}, 1<<20, dst); err != nil {
		t.Fatalf("a slow reader's download failed: %v", err)
	}
	if dst.n != len(data) {
		t.Fatalf("streamed %d of %d bytes", dst.n, len(data))
	}
}
