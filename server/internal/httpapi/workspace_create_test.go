package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

func TestWorkspaceCreateGeneralFields(t *testing.T) {
	h := openShareHTTP(t)
	for _, selected := range []bool{false, true} {
		body := map[string]string{"name": "Creation metadata"}
		if selected {
			body["iconId"] = "critters-16"
			body["description"] = strings.Repeat("学", 500)
		}
		rec := doReq(t, h, http.MethodPost, "/api/workspaces", "u_owner", body)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
		}
		var created struct {
			ID          string `json:"id"`
			IconID      string `json:"iconId"`
			Description string `json:"description"`
			Privacy     string `json:"privacy"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/workspaces/"+created.ID, "u_owner", nil) })
		if created.Privacy != "private" || created.Description != body["description"] {
			t.Fatalf("unexpected creation metadata: %+v", created)
		}
		if selected && created.IconID != body["iconId"] {
			t.Fatalf("selected icon lost: %+v", created)
		}
		if !selected && (!strings.HasPrefix(created.IconID, "waves-") || !store.ValidIconID(created.IconID)) {
			t.Fatalf("invalid default icon: %s", created.IconID)
		}
		rec = doReq(t, h, http.MethodGet, "/api/workspaces/"+created.ID, "u_owner", nil)
		var loaded struct {
			IconID      string `json:"iconId"`
			Description string `json:"description"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &loaded); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusOK || loaded.IconID != created.IconID || loaded.Description != created.Description {
			t.Fatalf("metadata did not persist: %d %s", rec.Code, rec.Body.String())
		}
	}
}
