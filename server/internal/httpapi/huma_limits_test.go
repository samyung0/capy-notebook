package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
)

func TestMaterialRequestBodyLimit(t *testing.T) {
	router := chi.NewRouter()
	api := humachi.New(router, humaConfig(false))
	type input struct {
		Body string
	}

	regWithMaxBody(
		api,
		http.MethodPost,
		"/body-limit",
		"bodyLimit",
		"Test",
		"Test body limit",
		http.StatusOK,
		materialRequestMaxBytes,
		func(context.Context, *input) (*struct{}, error) {
			return &struct{}{}, nil
		},
	)

	request := func(size int) *httptest.ResponseRecorder {
		body := []byte(`"` + strings.Repeat("x", size) + `"`)
		req := httptest.NewRequest(http.MethodPost, "/body-limit", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if got := request(materialRequestMaxBytes - 3).Code; got != http.StatusOK {
		t.Fatalf("body below material limit returned %d, want %d", got, http.StatusOK)
	}
	if got := request(materialRequestMaxBytes).Code; got != http.StatusRequestEntityTooLarge {
		t.Fatalf("body above material limit returned %d, want %d", got, http.StatusRequestEntityTooLarge)
	}
}
