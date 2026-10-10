package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// Signed-in viewers watch notes and live items through read-only rooms (Epo,
// 2026-10-10): their token says read, an editor's write, and a stranger gets
// none. The collaboration server closes a read channel that writes.
func TestViewersGetReadOnlyCollaborationTokens(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(st.Close)
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{
		AuthDisabled:        true,
		E2EAuth:             true,
		E2ESecret:           "e2e-test-secret",
		E2EUserIDs:          []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		CollaborationSecret: "collab-test-secret",
	})
	for _, material := range []string{"note_e2e_private", "dk_e2e_private"} {
		for _, c := range []struct {
			user   string
			status int
			access string
		}{
			{"u_viewer", http.StatusCreated, "read"},
			{"u_editor", http.StatusCreated, "write"},
			{"u_other", http.StatusNotFound, ""},
		} {
			rec := doReq(t, h, http.MethodPost, "/api/materials/"+material+"/collaboration-token", c.user, nil)
			if rec.Code != c.status {
				t.Fatalf("%s on %s = %d body=%s, want %d", c.user, material, rec.Code, rec.Body.String(), c.status)
			}
			if c.status != http.StatusCreated {
				continue
			}
			var token struct {
				Access string `json:"access"`
				Room   string `json:"room"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &token); err != nil || token.Access != c.access {
				t.Fatalf("%s on %s: access %q (%v), want %q", c.user, material, token.Access, err, c.access)
			}
		}
	}
}

// Security regression (live-items D1/D3, Epo 2026-10-10): a quiz's keys
// document goes to editors who can write only. A viewer asking for it is
// refused, an editor gets the keys room, and a material that is not a quiz
// has none.
func TestQuizKeysTokensGoToEditorsOnly(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(st.Close)
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{
		AuthDisabled:        true,
		E2EAuth:             true,
		E2ESecret:           "e2e-test-secret",
		E2EUserIDs:          []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		CollaborationSecret: "collab-test-secret",
	})
	keys := map[string]any{"document": "keys"}
	for _, c := range []struct {
		user     string
		material string
		status   int
	}{
		{"u_viewer", "qz_e2e_private", http.StatusForbidden},
		{"u_other", "qz_e2e_private", http.StatusNotFound},
		{"u_editor", "note_e2e_private", http.StatusNotFound},
		{"u_editor", "qz_e2e_private", http.StatusCreated},
	} {
		rec := doReq(t, h, http.MethodPost, "/api/materials/"+c.material+"/collaboration-token", c.user, keys)
		if rec.Code != c.status {
			t.Fatalf("%s keys of %s = %d body=%s, want %d", c.user, c.material, rec.Code, rec.Body.String(), c.status)
		}
		if c.status != http.StatusCreated {
			continue
		}
		var token struct {
			Access string `json:"access"`
			Room   string `json:"room"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &token); err != nil {
			t.Fatal(err)
		}
		if token.Access != "write" || !strings.HasPrefix(token.Room, "keys:qz_e2e_private:schema:") {
			t.Fatalf("editor keys token: %+v", token)
		}
	}
}
