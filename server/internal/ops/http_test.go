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
	admin := NewLazyAdminStore("not-a-database-url")
	registry := NewRegistryStoreWithAdmin(nil, admin)
	handler := NewHandler(nil, registry, admin, HandlerConfig{})
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
	if !strings.Contains(response.Body.String(), "permission_denied") {
		t.Fatalf("response did not identify the permission gate: %s", response.Body.String())
	}
	if admin.pool != nil {
		t.Fatal("viewer request opened the registry writer")
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestAuditPageParamsValidateCursorAndLimit(t *testing.T) {
	tests := []struct {
		url     string
		before  int64
		limit   int
		wantErr bool
	}{
		{url: "/api/ops/audit", before: 0, limit: auditPageMax},
		{url: "/api/ops/audit?beforeId=42&limit=25", before: 42, limit: 25},
		{url: "/api/ops/audit?beforeId=0", wantErr: true},
		{url: "/api/ops/audit?beforeId=nope", wantErr: true},
		{url: "/api/ops/audit?limit=101", wantErr: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.url, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, testCase.url, nil)
			before, limit, err := auditPageParams(request)
			if (err != nil) != testCase.wantErr {
				t.Fatalf("auditPageParams error = %v, wantErr %v", err, testCase.wantErr)
			}
			if err == nil && (before != testCase.before || limit != testCase.limit) {
				t.Fatalf(
					"auditPageParams = %d/%d, want %d/%d",
					before, limit, testCase.before, testCase.limit,
				)
			}
		})
	}
}

func TestReconciliationRequestRejectsViewerBeforeWriterLookup(t *testing.T) {
	admin := NewLazyAdminStore("not-a-database-url")
	handler := NewHandler(nil, nil, admin, HandlerConfig{})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/ops/reconciliation/storage",
		nil,
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
	if !strings.Contains(response.Body.String(), "permission_denied") {
		t.Fatalf("response did not identify the permission gate: %s", response.Body.String())
	}
	if admin.pool != nil {
		t.Fatal("viewer request opened the actions writer")
	}
}

func TestRegistrySaveUsesPermissionNotRoleName(t *testing.T) {
	admin := NewLazyAdminStore("not-a-database-url")
	registry := NewRegistryStoreWithAdmin(nil, admin)
	handler := NewHandler(nil, registry, admin, HandlerConfig{})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/ops/registry/save",
		strings.NewReader(`{}`),
	)
	request = request.WithContext(context.WithValue(
		request.Context(),
		principalContextKey{},
		Principal{
			UserID:      "viewer",
			Role:        RoleViewer,
			Permissions: []string{PermWriteRegistry},
		},
	))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code == http.StatusForbidden {
		t.Fatalf("write_registry on viewer role was rejected: %s", response.Body.String())
	}
}

func TestReadEndpointsRequireReadAll(t *testing.T) {
	handler := NewHandler(nil, nil, nil, HandlerConfig{})
	request := httptest.NewRequest(http.MethodGet, "/api/ops/overview", nil)
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
	if !strings.Contains(response.Body.String(), "permission_denied") {
		t.Fatalf("response = %s", response.Body.String())
	}
}

func TestPrincipalHasMatchesTokens(t *testing.T) {
	principal := Principal{Permissions: []string{PermReadAll, PermWriteRegistry}}
	if !principal.Has(PermReadAll) || !principal.Has(PermWriteRegistry) {
		t.Fatal("expected granted tokens")
	}
	if principal.Has(PermExecuteReconciliation) {
		t.Fatal("missing token was granted")
	}
	if (Principal{}).Has(PermReadAll) {
		t.Fatal("empty principal must not have tokens")
	}
}

func TestOpsResponsesDisableIndexing(t *testing.T) {
	handler := NewHandler(nil, nil, nil, HandlerConfig{})
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
