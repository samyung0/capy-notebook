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
