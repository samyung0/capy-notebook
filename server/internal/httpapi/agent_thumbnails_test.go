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
	"time"

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
	// during runs while a file renders (a browser upload landing then).
	during func(fileID string)
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
	if f.during != nil {
		f.during(t.FileID)
	}
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
// and a drawing Go's check refuses is not stored. A browser capture claimed
// before the turn ended is waited out, never kept; one landing while the
// agent's drawing renders came after the edits and stands.
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
	pool := st.Pool()
	var waits []time.Duration
	a := &api{s: st, blob: bucket, thumbnailWait: func(ctx context.Context, d time.Duration) error {
		waits = append(waits, d)
		// The interval passes.
		_, err := pool.Exec(ctx, `UPDATE files SET thumbnail_captured_at = thumbnail_captured_at - interval '60 seconds'
			WHERE id LIKE 'f_agent_%' AND thumbnail_captured_at IS NOT NULL`)
		return err
	}}
	message := "msg_agent_thumbs"
	turn := func() {
		t.Helper()
		files, err := st.TurnThumbnails(ctx, message)
		if err != nil {
			t.Fatal(err)
		}
		a.captureAgentThumbnails(ctx, files)
	}
	browser := func(fileID string) string {
		t.Helper()
		key := "thumbs/" + fileID + "/browser.webp"
		if err := st.ClaimThumbnailCapture(ctx, fileID); err != nil {
			t.Fatal(err)
		}
		if err := st.SetFileThumbnail(ctx, fileID, key); err != nil {
			t.Fatal(err)
		}
		return key
	}
	thumbnail := func(fileID string) string {
		t.Helper()
		var got string
		if err := pool.QueryRow(ctx, `SELECT COALESCE(thumbnail_key,'') FROM files WHERE id=$1`, fileID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}
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

	turn()

	if fakes.captures["f_agent_plan"] != 1 || fakes.captures["f_agent_deck"] != 1 || len(fakes.captures) != 2 {
		t.Fatalf("captures asked = %v, want one each for the edited plan and deck", fakes.captures)
	}
	if len(waits) != 0 {
		t.Fatalf("waited %v for files never captured", waits)
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

	// A browser upload claimed 10 s before the turn ended holds a drawing
	// older than the turn's edit: the capture waits out the rest of the
	// interval once, then stores the agent's drawing over it.
	message = "msg_agent_thumbs_wait"
	file("f_agent_recent", "recent.docx")
	edit("f_agent_recent", "succeeded", `[]`)
	browser("f_agent_recent")
	if _, err := pool.Exec(ctx, `UPDATE files SET thumbnail_captured_at = now() - interval '10 seconds' WHERE id='f_agent_recent'`); err != nil {
		t.Fatal(err)
	}
	turn()
	if len(waits) != 1 || waits[0] <= 40*time.Second || waits[0] > 50*time.Second {
		t.Fatalf("waits = %v, want one of about 50 s", waits)
	}
	recentKey := "thumbs/f_agent_recent/" + hex.EncodeToString(sum[:]) + ".webp"
	if fakes.captures["f_agent_recent"] != 1 || thumbnail("f_agent_recent") != recentKey {
		t.Fatalf("recent: captures %d, thumbnail %q", fakes.captures["f_agent_recent"], thumbnail("f_agent_recent"))
	}

	// A browser upload that lands while the agent's drawing renders came
	// after the edit: it wins the claim and stands.
	message = "msg_agent_thumbs_race"
	file("f_agent_race", "race.docx")
	edit("f_agent_race", "succeeded", `[]`)
	landed := "thumbs/f_agent_race/browser.webp"
	fakes.during = func(fileID string) {
		// On the fake server's goroutine: no t.Fatal here.
		if err := st.ClaimThumbnailCapture(ctx, fileID); err != nil {
			t.Error(err)
		}
		if err := st.SetFileThumbnail(ctx, fileID, landed); err != nil {
			t.Error(err)
		}
	}
	turn()
	fakes.during = nil
	if fakes.captures["f_agent_race"] != 1 || thumbnail("f_agent_race") != landed || len(waits) != 1 {
		t.Fatalf("race: captures %d, thumbnail %q, waits %v", fakes.captures["f_agent_race"], thumbnail("f_agent_race"), waits)
	}

	// A drawing that is not one plain WebP image is refused before storage.
	message = "msg_agent_thumbs_bad"
	file("f_agent_bad", "bad.docx")
	edit("f_agent_bad", "succeeded", `[]`)
	fakes.image = []byte("RIFF....WEBPVP8 not an image")
	turn()
	if got := thumbnail("f_agent_bad"); got != "" {
		t.Fatalf("a refused drawing was stored: %q", got)
	}
}
