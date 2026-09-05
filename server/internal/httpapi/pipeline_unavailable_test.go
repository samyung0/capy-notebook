package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

func TestChatErrorsWhenPipelineMissing(t *testing.T) {
	h := openShareHTTP(t)
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream",
		"u_editor", map[string]any{"text": "hello"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "Pipeline offline") {
		t.Fatal("placeholder tokens must not be streamed")
	}
	if !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, "ai_unavailable") {
		t.Fatalf("want ai_unavailable error event, got %s", body)
	}
	if !strings.Contains(body, `"status":"error"`) {
		t.Fatalf("want done status error, got %s", body)
	}
}

func TestChatErrorsWhenPipelineHTTPFails(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	t.Cleanup(down.Close)

	h := openShareAPI(t, pipeline.New(down.URL, ""))
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream",
		"u_editor", map[string]any{"text": "hello"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "Pipeline offline") {
		t.Fatal("placeholder tokens must not be streamed")
	}
	if !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, "ai_unavailable") {
		t.Fatalf("want ai_unavailable error event, got %s", body)
	}
}

func TestGenerateErrorsWhenPipelineMissing(t *testing.T) {
	h := openShareHTTP(t)
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", generateBody("quiz", "No pipe quiz"))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if errorCode(t, rec) != "ai_unavailable" {
		t.Fatalf("code = %q body=%s", errorCode(t, rec), rec.Body.String())
	}
}

func TestGenerateErrorsWhenPipelineHTTPFails(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	t.Cleanup(down.Close)

	h := openShareAPI(t, pipeline.New(down.URL, ""))
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", generateBody("quiz", "Down pipe quiz"))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGenerateRejectsEmptyMaterial(t *testing.T) {
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Kind string `json:"kind"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		w.Header().Set("Content-Type", "application/json")
		switch in.Kind {
		case "mindmap", "diagram":
			_, _ = fmt.Fprintf(w, `{"kind":%q,"title":"t","content":""}`, in.Kind)
		case "flashcards":
			_, _ = w.Write([]byte(`{"kind":"flashcards","cards":[]}`))
		case "quiz":
			_, _ = w.Write([]byte(`{"kind":"quiz","questions":[]}`))
		default:
			http.Error(w, "unsupported", http.StatusBadRequest)
		}
	}))
	t.Cleanup(empty.Close)

	h := openShareAPI(t, pipeline.New(empty.URL, ""))
	for _, kind := range []string{"mindmap", "diagram", "flashcards", "quiz"} {
		rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
			"u_editor", generateBody(kind, kind+" empty"))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("%s status = %d body=%s", kind, rec.Code, rec.Body.String())
		}
		if errorCode(t, rec) != "generate_empty" {
			t.Fatalf("%s code = %s body=%s", kind, errorCode(t, rec), rec.Body.String())
		}
	}
}

func TestGenerateMapsPipelineEmptyCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"code":"generate_empty","message":"The model returned no usable mindmap."}`))
	}))
	t.Cleanup(srv.Close)

	h := openShareAPI(t, pipeline.New(srv.URL, ""))
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", generateBody("mindmap", "Empty from pipeline"))
	if rec.Code != http.StatusBadGateway || errorCode(t, rec) != "generate_empty" {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}
