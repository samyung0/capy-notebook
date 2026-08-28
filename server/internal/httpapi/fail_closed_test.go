package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/evonotes/server/internal/pipeline"
)

// The generate defaults are declared as Huma tags so OpenAPI and orval show
// them. That only helps if Huma actually fills them in before the handler runs:
// otherwise the request reaches the pipeline with an empty types list and the
// gateway is back to inventing a value somewhere downstream.
func TestGenerateSendsDeclaredDefaultsToThePipeline(t *testing.T) {
	seen := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		select {
		case seen <- in:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"quiz","name":"n","questions":[{"id":"q1","type":"mcq","level":"recall","prompt":"Q?","options":[{"value":"a"}],"correct":[0]}]}`))
	}))
	t.Cleanup(srv.Close)

	h := openShareAPI(t, pipeline.New(srv.URL, ""))
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", generateBody("quiz", "Default carrying quiz"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() {
		_ = doReq(t, h, http.MethodDelete,
			"/api/materials/"+generatedMaterialID(t, rec.Body.Bytes()), "u_owner", nil)
	})

	body := <-seen
	if got := body["types"]; !reflect.DeepEqual(got, []any{"mcq"}) {
		t.Errorf("types = %#v, want [mcq]", got)
	}
	if got := body["detail"]; got != "standard" {
		t.Errorf("detail = %#v, want standard", got)
	}
	if got := body["diagramType"]; got != "auto" {
		t.Errorf("diagramType = %#v, want auto", got)
	}
	if got, ok := body["fileIds"].([]any); !ok || len(got) == 0 {
		t.Errorf("omitted scope did not expand to workspace files: %#v", body["fileIds"])
	}
}

// An explicit empty list is a client statement, not an omission, so the default
// must not paper over it.
func TestGenerateRejectsAnExplicitlyEmptyTypesList(t *testing.T) {
	h := openShareAPI(t, stubRetrieval(t))
	body := generateBody("quiz", "Empty types quiz")
	body["types"] = []string{}
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", body)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty types = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGenerateRejectsUnknownScopeIDs(t *testing.T) {
	h := openShareAPI(t, stubRetrieval(t))

	unknownFile := generateBody("quiz", "Unknown file")
	unknownFile["fileIds"] = []string{"f_does_not_exist"}
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", unknownFile)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown file = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid or unavailable") {
		t.Fatalf("unknown file leaked a distinct error: %s", rec.Body.String())
	}

	unknownChapter := generateBody("quiz", "Unknown chapter")
	unknownChapter["chapters"] = []string{"ch_does_not_exist"}
	rec = doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", unknownChapter)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown chapter = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestMissingTagKindAndModelsSurfaceReturnEmpty(t *testing.T) {
	h := openShareHTTP(t)

	tags := doReq(t, h, http.MethodGet, "/api/tags", "u_owner", nil)
	if tags.Code != http.StatusOK {
		t.Fatalf("tags status = %d body=%s", tags.Code, tags.Body.String())
	}
	var tagList []any
	if err := json.Unmarshal(tags.Body.Bytes(), &tagList); err != nil {
		t.Fatal(err)
	}
	if len(tagList) != 0 {
		t.Fatalf("missing tag kind returned %d tags, want none", len(tagList))
	}

	models := doReq(t, h, http.MethodGet, "/api/models", "u_owner", nil)
	if models.Code != http.StatusOK {
		t.Fatalf("models status = %d body=%s", models.Code, models.Body.String())
	}
	var body struct {
		Models           []any  `json:"models"`
		SelectedKey      string `json:"selectedKey"`
		DefaultKey       string `json:"defaultKey"`
		SelectedThinking string `json:"selectedThinking"`
	}
	if err := json.Unmarshal(models.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Models) != 0 || body.SelectedKey != "" || body.DefaultKey != "" {
		t.Fatalf("missing surface leaked a chat selection: %+v", body)
	}
}

func TestListModelsResolvesEmptyReasoningPrefs(t *testing.T) {
	h := openShareHTTP(t)
	rec := doReq(t, h, http.MethodGet, "/api/models?surface=chat", "u_owner", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		SelectedThinking string `json:"selectedThinking"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.SelectedThinking != "instant" {
		t.Fatalf("resolved thinking = %+v, want instant", body)
	}
}
