package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// TestTrashedFileOpensForItsTrashReaders: a trashed file opens on the file
// page from the Trash (Epo 2026-11-12), so its normal reads answer its trash
// readers with its trash state and signed bytes; a member who only reads its
// workspace still finds nothing.
func TestTrashedFileOpensForItsTrashReaders(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	reg, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(reg)
	bucket := blob.NewMemory()
	if _, _, err := bucket.Put("sources/f_trash_open/plan.pdf", strings.NewReader("%PDF")); err != nil {
		t.Fatal(err)
	}
	h := httpapi.New(st, bucket, nil, nil, "docling", httpapi.Config{
		AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
		E2EUserIDs:    []string{"u_owner", "u_viewer"},
		ModelRegistry: reg,
	})
	const id = "f_trash_open"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, name, kind, size_bytes, status, blob_path,
		 trashed_at, trash_episode_id, purge_after)
		VALUES ($1,'ws_e2e_private','u_owner','plan.pdf','pdf',1,'ready','sources/f_trash_open/plan.pdf',
		 now(), 'ep_open', now() + interval '30 days')`, id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM files WHERE id=$1`, id)
	})

	rec := doReq(t, h, http.MethodGet, "/api/files/"+id, "u_owner", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner read = %d %s", rec.Code, rec.Body.String())
	}
	var file struct {
		PreviewURL *string `json:"previewUrl"`
		Trash      *struct {
			CanRestore bool   `json:"canRestore"`
			EpisodeID  string `json:"episodeId"`
		} `json:"trash"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil {
		t.Fatal(err)
	}
	if file.Trash == nil || file.Trash.EpisodeID != "ep_open" || !file.Trash.CanRestore || file.PreviewURL != nil {
		t.Fatalf("owner read = %s", rec.Body.String())
	}
	// Its bytes, and a ready PDF's own citation preview, come signed.
	rec = doReq(t, h, http.MethodGet, "/api/files/"+id+"/links", "u_owner", nil)
	var links struct {
		PreviewURL string `json:"previewUrl"`
		URL        string `json:"url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &links); rec.Code != http.StatusOK || err != nil || links.URL == "" || links.PreviewURL != links.URL {
		t.Fatalf("owner links = %d %s", rec.Code, rec.Body.String())
	}

	for _, path := range []string{"/api/files/" + id, "/api/files/" + id + "/links"} {
		if rec := doReq(t, h, http.MethodGet, path, "u_viewer", nil); rec.Code != http.StatusNotFound {
			t.Fatalf("viewer %s = %d %s", path, rec.Code, rec.Body.String())
		}
	}
}
