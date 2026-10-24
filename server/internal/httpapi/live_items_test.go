package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// Security regression (Epo 2026-10-24, Q236): a material token request that
// presents the session's previous token is offered its client id again, and
// another user's previous token gives nothing of its own. Fails if the
// endpoint ignores the previous token or re-grants another user's id.
func TestAMaterialTokenOffersThePreviousTokensClientIDAgain(t *testing.T) {
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
		E2EUserIDs:          []string{"u_owner", "u_editor"},
		CollaborationSecret: "collab-test-secret",
	})
	mint := func(user string, body any) (string, float64) {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/materials/note_e2e_private/collaboration-token", user, body)
		var out struct {
			Token string `json:"token"`
		}
		if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &out) != nil {
			t.Fatalf("%s token = %d body=%s", user, rec.Code, rec.Body.String())
		}
		payload, err := base64.RawURLEncoding.DecodeString(strings.Split(out.Token, ".")[1])
		var claims struct {
			ClientID float64 `json:"clientId"`
		}
		if err != nil || json.Unmarshal(payload, &claims) != nil {
			t.Fatalf("claims: %v", err)
		}
		return out.Token, claims.ClientID
	}
	previous, id := mint("u_editor", nil)
	if _, again := mint("u_editor", map[string]string{"previousToken": previous}); again != id {
		t.Fatalf("regranted id %v, previous %v", again, id)
	}
	if _, other := mint("u_owner", map[string]string{"previousToken": previous}); other == id {
		t.Fatalf("another user's previous token gave its id %v", id)
	}
}

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
		// A View asks for a read channel even for its owner or an editor
		// (live-items REVIEW5 N2).
		for _, user := range []string{"u_owner", "u_editor"} {
			rec := doReq(t, h, http.MethodPost, "/api/materials/"+material+"/collaboration-token", user, map[string]any{"access": "read"})
			var token struct {
				Access string `json:"access"`
			}
			if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &token) != nil || token.Access != "read" {
				t.Fatalf("%s asking to read %s = %d body=%s, want a read token", user, material, rec.Code, rec.Body.String())
			}
		}
	}
	// Security regression (Epo 2026-10-16): a suspended owner's materials are
	// not found for their viewers and editors, as a deleted owner's are; no
	// token, not even a read one.
	if _, err := st.Pool().Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id='u_owner'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id='u_owner'`)
	})
	for _, user := range []string{"u_viewer", "u_editor"} {
		rec := doReq(t, h, http.MethodPost, "/api/materials/note_e2e_private/collaboration-token", user, nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s token for a suspended owner's note = %d body=%s, want 404", user, rec.Code, rec.Body.String())
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
	// An editor narrowed to read (the owner's storage full) is refused the
	// keys too (live-items D1, REVIEW1 S5); a suspended owner's quiz is not
	// found (Epo 2026-10-16).
	exec := func(query string) {
		t.Helper()
		if _, err := st.Pool().Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	for _, narrow := range []struct {
		name, set, reset string
		status           int
	}{
		{
			"suspended owner",
			`UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id='u_owner'`,
			`UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id='u_owner'`,
			http.StatusNotFound,
		},
		{
			"full owner",
			`INSERT INTO user_storage_deltas (user_id, delta_bytes) VALUES ('u_owner', 1000000000000000)`,
			`DELETE FROM user_storage_deltas WHERE user_id='u_owner' AND delta_bytes=1000000000000000`,
			http.StatusForbidden,
		},
	} {
		exec(narrow.set)
		rec := doReq(t, h, http.MethodPost, "/api/materials/qz_e2e_private/collaboration-token", "u_editor", keys)
		exec(narrow.reset)
		if rec.Code != narrow.status {
			t.Fatalf("%s: editor keys = %d body=%s, want %d", narrow.name, rec.Code, rec.Body.String(), narrow.status)
		}
	}
}

// Embedded quizzes and sets sync inside their note's seat (Epo 2026-10-20):
// their tokens, the quiz keys' too, name the note, which the collaboration
// server checks against the channel the embed joins in. A note's own token
// names none.
func TestEmbeddedItemTokensNameTheirNote(t *testing.T) {
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
		E2EUserIDs:          []string{"u_owner", "u_editor"},
		CollaborationSecret: "collab-test-secret",
	})
	quiz, err := st.CreateEmbeddedMaterial(ctx, "u_owner", "note_e2e_private", store.EmbeddedDraft{
		Kind:      "quiz",
		Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	set, err := st.CreateEmbeddedMaterial(ctx, "u_owner", "note_e2e_private", store.EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"front", "back"}}})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, quiz.ID)
	cleanupMaterial(t, st, set.ID)
	parent := func(material string, body any) string {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/materials/"+material+"/collaboration-token", "u_editor", body)
		var token struct {
			Token string `json:"token"`
		}
		if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &token) != nil {
			t.Fatalf("token for %s = %d body=%s", material, rec.Code, rec.Body.String())
		}
		parts := strings.Split(token.Token, ".")
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			t.Fatal(err)
		}
		var claims struct {
			Parent *string `json:"parent"`
		}
		if err := json.Unmarshal(payload, &claims); err != nil {
			t.Fatal(err)
		}
		if claims.Parent == nil {
			return ""
		}
		return *claims.Parent
	}
	for _, c := range []struct {
		material string
		body     any
		want     string
	}{
		{quiz.ID, nil, "note_e2e_private"},
		{quiz.ID, map[string]any{"document": "keys"}, "note_e2e_private"},
		{set.ID, map[string]any{"access": "read"}, "note_e2e_private"},
		{"note_e2e_private", nil, ""},
	} {
		if got := parent(c.material, c.body); got != c.want {
			t.Fatalf("%s %v: parent %q, want %q", c.material, c.body, got, c.want)
		}
	}
}

// Security regression (Epo 2026-10-20, privacy): a room token names who the
// connection is for the room's presence by the verified name alone; nothing
// about the device (no browser or OS, no part of the User-Agent) goes in.
func TestCollaborationTokensCarryNoDevice(t *testing.T) {
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
		E2EUserIDs:          []string{"u_editor"},
		CollaborationSecret: "collab-test-secret",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/materials/note_e2e_private/collaboration-token", nil)
	req.Header.Set(auth.HeaderE2EUserID, "u_editor")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var token struct {
		Token string `json:"token"`
	}
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &token) != nil {
		t.Fatalf("token = %d body=%s", rec.Code, rec.Body.String())
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.Split(token.Token, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	_, hasBrowser := claims["browser"]
	_, hasOS := claims["os"]
	if hasBrowser || hasOS || claims["name"] == "" || strings.Contains(string(payload), "Safari") || strings.Contains(string(payload), "Mac") {
		t.Fatalf("claims = %s", payload)
	}
}
