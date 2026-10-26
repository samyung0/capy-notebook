package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestRecentListsOpensNewestFirst(t *testing.T) {
	h, st := openInternalHTTP(t)
	create := func(title string) string {
		t.Helper()
		rec := doAsUser(t, h, http.MethodPost, "/api/materials", "u_owner",
			map[string]any{"kind": "note", "title": title})
		if rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
			t.Fatalf("create %s: status = %d body=%s", title, rec.Code, rec.Body.String())
		}
		var out struct{ ID string }
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, out.ID)
		})
		return out.ID
	}
	first := create("Recent first " + t.Name())
	second := create("Recent second " + t.Name())
	// Both creations count as opens; an hour-old one moves up when opened.
	if _, err := st.Pool().Exec(t.Context(),
		`UPDATE item_opens SET opened_at=now()-interval '1 hour' WHERE user_id='u_owner' AND material_id=$1`, first); err != nil {
		t.Fatal(err)
	}
	if rec := doAsUser(t, h, http.MethodPost, "/api/materials/"+first+"/open", "u_owner", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("open: status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec := doAsUser(t, h, http.MethodGet, "/api/recent?limit=50", "u_owner", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("recent: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var page struct {
		Items []struct {
			Material *struct{ ID string } `json:"material"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, item := range page.Items {
		if item.Material != nil && (item.Material.ID == first || item.Material.ID == second) {
			order = append(order, item.Material.ID)
		}
	}
	if len(order) != 2 || order[0] != first || order[1] != second {
		t.Fatalf("recent order = %v, want [%s %s]", order, first, second)
	}
}
