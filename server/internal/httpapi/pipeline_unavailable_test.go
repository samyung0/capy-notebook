package httpapi_test

import (
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
		"u_editor", generateBody("No pipe quiz"))
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
		"u_editor", generateBody("Down pipe quiz"))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGenerateRejectsEmptyQuiz(t *testing.T) {
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"questions":[]}`))
	}))
	t.Cleanup(empty.Close)

	h := openShareAPI(t, pipeline.New(empty.URL, ""))
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", generateBody("Empty quiz"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if errorCode(t, rec) != "generate_empty" {
		t.Fatalf("code = %s body=%s", errorCode(t, rec), rec.Body.String())
	}
}

func TestGenerateMapsPipelineEmptyCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"code":"generate_empty","message":"The model returned no usable quiz."}`))
	}))
	t.Cleanup(srv.Close)

	h := openShareAPI(t, pipeline.New(srv.URL, ""))
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", generateBody("Empty from pipeline"))
	if rec.Code != http.StatusBadGateway || errorCode(t, rec) != "generate_empty" {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}
