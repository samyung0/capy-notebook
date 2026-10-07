package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// A write to a note-embedded quiz or flashcard set tells the collaboration
// service which item changed and which note room to tell (Epo 2026-10-07);
// a standalone item sends nothing.
func TestEmbeddedWritesPublishEmbedChanged(t *testing.T) {
	url := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("no disposable Redis; run `pnpm test:go` from the repository root")
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	t.Cleanup(func() { _ = rdb.Close() })
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	h := httpapi.New(st, blob.NewMemory(), nil, rdb, "docling", httpapi.Config{
		E2EAuth: true, E2ESecret: "e2e-test-secret", E2EUserIDs: []string{"u_owner"},
	})
	sub := rdb.Subscribe(ctx, "capy:collaboration:embeds")
	t.Cleanup(func() { _ = sub.Close() })
	if _, err = sub.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	messages := sub.Channel()

	note, err := st.CreateMaterial(ctx, store.Material{CreatedBy: "u_owner", Kind: "note", Title: "Embeds", Content: "# Embeds\n\nbody"})
	if err != nil {
		t.Fatal(err)
	}
	room, err := st.MaterialRoom(ctx, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := st.CreateEmbeddedMaterial(ctx, "u_owner", note.ID, store.EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"front", "back"}}})
	if err != nil {
		t.Fatal(err)
	}
	standalone, err := st.CreateFlashcardSetWithCards(ctx, "u_owner", "Alone", "", "", [][2]string{{"front", "back"}}, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	edit := func(id string, revision int64) {
		t.Helper()
		rec := doReq(t, h, http.MethodPatch, "/api/flashcards/"+id+"/content", "u_owner", map[string]any{
			"expectedRevision": revision,
			"cards":            []any{map[string]any{"front": "new front", "back": "new back"}},
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("edit %s: %d %s", id, rec.Code, rec.Body.String())
		}
	}

	// The standalone set's write comes first: the only message is the embed's.
	edit(standalone.ID, standalone.Revision)
	edit(embedded.ID, embedded.Revision)
	select {
	case message := <-messages:
		var got map[string]any
		if err := json.Unmarshal([]byte(message.Payload), &got); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"id": embedded.ID, "kind": "flashcards", "materialId": note.ID, "room": room, "type": "embed-changed"}
		for key, value := range want {
			if got[key] != value {
				t.Fatalf("message %v, want %v", got, want)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no embed-changed message")
	}
	select {
	case message := <-messages:
		t.Fatalf("a second message: %s", message.Payload)
	case <-time.After(300 * time.Millisecond):
	}
}
