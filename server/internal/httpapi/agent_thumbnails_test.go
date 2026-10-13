package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// agentThumbnails stands in for the collaboration server's capture route,
// counting what a turn asks of it.
type agentThumbnails struct {
	mu        sync.Mutex
	captures  map[string]int
	targets   map[string]store.AgentThumbnail
	unchanged map[string]bool // files whose page 1 it reports unchanged
	image     []byte
}

func (f *agentThumbnails) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/internal/source-thumbnails/capture" || r.Header.Get("X-Collaboration-Secret") != "secret" {
		http.Error(w, "unexpected request", http.StatusBadRequest)
		return
	}
	var t store.AgentThumbnail
	_ = json.NewDecoder(r.Body).Decode(&t)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.captures[t.FileID]++
	f.targets[t.FileID] = t
	if f.unchanged[t.FileID] {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "image/webp")
	_, _ = w.Write(f.image)
}

// A finished turn captures each Office file whose page 1 its committed edits
// may have changed exactly once: the collaboration server draws it and the
// WebP is stored and recorded with the capture time. A "page 1 unchanged"
// answer stores nothing, a refused edit (no committed row) asks for nothing,
// a drawing Go's check refuses is not stored, and the turn's second run finds
// the captured file inside the 60 s interval.
func TestAgentTurnCapturesEachOfficeFileOnce(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	capture, err := base64.StdEncoding.DecodeString("UklGRi4AAABXRUJQVlA4TCIAAAAvE8ACAA/wrf9//D/5f/7jAYTZRv3N3/QkziGi/wEA6wAA")
	if err != nil {
		t.Fatal(err)
	}
	fakes := &agentThumbnails{captures: map[string]int{}, targets: map[string]store.AgentThumbnail{}, unchanged: map[string]bool{}, image: capture}
	collaboration := httptest.NewServer(fakes)
	t.Cleanup(collaboration.Close)
	st.ConfigureCollaboration(collaboration.URL, "secret")
	bucket := blob.NewMemory()
	a := &api{s: st, blob: bucket}

	pool := st.Pool()
	message := "msg_agent_thumbs"
	file := func(id, name string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO files (id, workspace_id, user_id, name, kind, size_bytes, status)
			VALUES ($1,'ws_e2e_private','u_owner',$2,'doc',1,'ready')`, id, name); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM files WHERE id=$1`, id) })
	}
	edits := 0
	edit := func(fileID, outcome, guards string) {
		t.Helper()
		edits++
		op := "op_agent_thumbs_" + hex.EncodeToString([]byte{byte(edits)})
		if _, err := pool.Exec(ctx, `INSERT INTO agent_operations (id, kind, request_hash, actor_user_id, workspace_id, message_id, outcome, effect)
			VALUES ($1,'edit_document','h','u_owner','ws_e2e_private',$2,$3,
			        CASE WHEN $3='succeeded' THEN jsonb_build_object('operation','edited','resource',jsonb_build_object('kind','source_file','id',$4::text)) END)`,
			op, message, outcome, fileID); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM agent_operations WHERE id=$1`, op) })
		if outcome != "succeeded" {
			return // a refusal commits no inverse
		}
		if _, err := pool.Exec(ctx, `INSERT INTO agent_edit_inverses (operation_id, resource_kind, resource_id, actor_user_id, owner_user_id, workspace_id, incarnation, revision, inverse, guards)
			VALUES ($1,'source_file',$2,'u_owner','u_owner','ws_e2e_private',1,$3,
			        '{"commands":[{"type":"replace_text","targetId":"p","expectedText":"a","text":"b"}]}',$4::jsonb)`,
			op, fileID, edits, guards); err != nil {
			t.Fatal(err)
		}
	}
	file("f_agent_plan", "plan.docx")
	file("f_agent_deck", "deck.pptx")
	file("f_agent_refused", "other.docx")
	edit("f_agent_plan", "succeeded", `[]`)
	edit("f_agent_deck", "succeeded", `[{"kind":"office","id":"p","path":["pptx:stories","story:3"]}]`)
	edit("f_agent_plan", "succeeded", `[]`)
	edit("f_agent_refused", "refused", `[]`)
	fakes.unchanged["f_agent_deck"] = true

	a.captureAgentThumbnails(ctx, message)

	if fakes.captures["f_agent_plan"] != 1 || fakes.captures["f_agent_deck"] != 1 || len(fakes.captures) != 2 {
		t.Fatalf("captures asked = %v, want one each for the edited plan and deck", fakes.captures)
	}
	if got := fakes.targets["f_agent_deck"].Stories; len(got) != 1 || got[0] != "story:3" {
		t.Fatalf("deck stories sent = %v", got)
	}
	sum := sha256.Sum256(capture)
	key := "thumbs/f_agent_plan/" + hex.EncodeToString(sum[:]) + ".webp"
	var got string
	var captured bool
	if err := pool.QueryRow(ctx, `SELECT COALESCE(thumbnail_key,''), thumbnail_captured_at IS NOT NULL FROM files WHERE id='f_agent_plan'`).Scan(&got, &captured); err != nil {
		t.Fatal(err)
	}
	if got != key || !captured {
		t.Fatalf("plan thumbnail = %q captured = %v, want %q", got, captured, key)
	}
	if info, err := bucket.Head(ctx, key); err != nil || info.ContentType != "image/webp" {
		t.Fatalf("stored capture = %+v %v", info, err)
	}
	for _, id := range []string{"f_agent_deck", "f_agent_refused"} {
		if err := pool.QueryRow(ctx, `SELECT COALESCE(thumbnail_key,'') FROM files WHERE id=$1`, id).Scan(&got); err != nil || got != "" {
			t.Fatalf("%s thumbnail = %q %v", id, got, err)
		}
	}

	// The plan was captured just now: a second run of the turn asks for it no
	// more; the deck, never captured, is asked again.
	a.captureAgentThumbnails(ctx, message)
	if fakes.captures["f_agent_plan"] != 1 || fakes.captures["f_agent_deck"] != 2 {
		t.Fatalf("second run: captures asked = %v", fakes.captures)
	}

	// A drawing that is not one plain WebP image is refused before storage.
	file("f_agent_bad", "bad.docx")
	edit("f_agent_bad", "succeeded", `[]`)
	fakes.image = []byte("RIFF....WEBPVP8 not an image")
	a.captureAgentThumbnails(ctx, message)
	if err := pool.QueryRow(ctx, `SELECT COALESCE(thumbnail_key,'') FROM files WHERE id='f_agent_bad'`).Scan(&got); err != nil || got != "" {
		t.Fatalf("a refused drawing was stored: %q %v", got, err)
	}
}
