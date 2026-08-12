package pipeline

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPostRawSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type = %q, want application/json", ct)
		}
		// Echo the body back so we can assert it was marshalled.
		body, _ := io.ReadAll(r.Body)
		var in map[string]any
		if err := json.Unmarshal(body, &in); err != nil {
			t.Errorf("server got invalid JSON: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := New(srv.URL + "/") // trailing slash should be trimmed
	raw, err := c.PostRaw(context.Background(), "/retrieve", map[string]any{"query": "atp", "k": 5})
	if err != nil {
		t.Fatalf("PostRaw: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if out["ok"] != true {
		t.Errorf("unexpected response: %v", out)
	}
}

func TestPostRawErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL)
	if _, err := c.PostRaw(context.Background(), "/error", map[string]any{}); err == nil {
		t.Errorf("expected error on 500 response")
	}
}

func TestPostRawUnmarshalableBody(t *testing.T) {
	c := New("http://localhost:0")
	// channels can't be marshalled to JSON → error before any network call.
	if _, err := c.PostRaw(context.Background(), "/x", make(chan int)); err == nil {
		t.Errorf("expected marshal error")
	}
}

func TestPostRawConnRefused(t *testing.T) {
	// Nothing listening → transport error surfaces.
	c := New("http://127.0.0.1:1")
	if _, err := c.PostRaw(context.Background(), "/x", map[string]any{"a": 1}); err == nil {
		t.Errorf("expected connection error")
	}
}
