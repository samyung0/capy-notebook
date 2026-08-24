package ops

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRegistrySaveRejectsViewerBeforeWriterLookup(t *testing.T) {
	registry := NewLazyRegistryStore(nil, "not-a-database-url")
	handler := NewHandler(nil, registry, HandlerConfig{})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/ops/registry/save",
		strings.NewReader(`{}`),
	)
	request = request.WithContext(context.WithValue(
		request.Context(),
		principalContextKey{},
		Principal{UserID: "viewer", Role: RoleViewer},
	))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if !strings.Contains(response.Body.String(), "admin_required") {
		t.Fatalf("response did not identify the admin gate: %s", response.Body.String())
	}
	if registry.write != nil {
		t.Fatal("viewer request opened the registry writer")
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestOpsResponsesDisableIndexing(t *testing.T) {
	handler := NewHandler(nil, nil, HandlerConfig{})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if got := response.Header().Get("X-Robots-Tag"); got == "" {
		t.Fatal("X-Robots-Tag was not set")
	}
}

func TestRegistryConflictResponseIncludesCurrentSnapshot(t *testing.T) {
	response := httptest.NewRecorder()
	respond(response, nil, &ConflictError{
		Current: RegistrySnapshot{Version: 17, Configs: []CatalogConfig{}},
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, want conflict", response.Code)
	}
	var body struct {
		Code    string           `json:"code"`
		Current RegistrySnapshot `json:"current"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "registry_conflict" || body.Current.Version != 17 {
		t.Fatalf("conflict response = %+v", body)
	}
}

func TestRegistryConstraintErrorsMapToSafeBadRequest(t *testing.T) {
	response := httptest.NewRecorder()
	respond(response, nil, &pgconn.PgError{
		Code:           "23514",
		ConstraintName: "model_configs_reasoning_check",
	})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want bad request", response.Code)
	}
	if !strings.Contains(response.Body.String(), "model_configs_reasoning_check") {
		t.Fatalf("constraint response = %s", response.Body.String())
	}
}
