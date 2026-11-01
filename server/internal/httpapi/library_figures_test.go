package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// A chat answer's library figure: a signed-in user reads what the retrieval
// service renders, cacheable, and the service's refusals keep their meaning.
func TestLibraryFigureAnswersFromTheRetrievalService(t *testing.T) {
	replies := map[string]struct {
		status int
		body   string
	}{
		"fig_shown":  {http.StatusOK, `{"credit":"Fig. credit","height":2,"id":"fig_shown","image":"/9g=","label":"Fig. 1","width":3}`},
		"fig_hidden": {http.StatusNotFound, `{"code":"not_found"}`},
		"fig_broken": {http.StatusServiceUnavailable, `{"code":"unavailable"}`},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ID string `json:"id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		reply := replies[in.ID]
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.status)
		_, _ = w.Write([]byte(reply.body))
	}))
	t.Cleanup(srv.Close)
	h := openShareAPI(t, pipeline.New(srv.URL, ""))

	rec := doReq(t, h, http.MethodGet, "/api/library/figures/fig_shown", "u_editor", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("shown figure: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=86400, immutable" {
		t.Errorf("Cache-Control = %q", got)
	}
	var figure struct {
		Credit string `json:"credit"`
		Height int    `json:"height"`
		ID     string `json:"id"`
		Image  string `json:"image"`
		Label  string `json:"label"`
		Width  int    `json:"width"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &figure); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if figure.ID != "fig_shown" || figure.Label != "Fig. 1" || figure.Credit != "Fig. credit" ||
		figure.Image != "/9g=" || figure.Width != 3 || figure.Height != 2 {
		t.Errorf("figure = %+v", figure)
	}

	if rec := doReq(t, h, http.MethodGet, "/api/library/figures/fig_hidden", "u_editor", nil); rec.Code != http.StatusNotFound {
		t.Errorf("hidden figure: status = %d, want 404", rec.Code)
	}
	if rec := doReq(t, h, http.MethodGet, "/api/library/figures/fig_broken", "u_editor", nil); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("failed render: status = %d, want 503", rec.Code)
	}

	signedOut := httptest.NewRecorder()
	h.ServeHTTP(signedOut, httptest.NewRequest(http.MethodGet, "/api/library/figures/fig_shown", nil))
	if signedOut.Code != http.StatusUnauthorized {
		t.Errorf("signed out: status = %d, want 401", signedOut.Code)
	}
}
