package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func creditBody(id, license string) map[string]any {
	return map[string]any{"books": []map[string]any{{
		"id": id, "title": "Book " + id, "license": license, "excerptIds": []string{"e_" + id}, "version": 1,
	}}}
}

func creditedBooks(p *store.Provenance) string {
	if p == nil {
		return ""
	}
	ids := []string{}
	for _, book := range p.Books {
		ids = append(ids, book.ID)
	}
	return strings.Join(ids, " ")
}

const embedQuestion = `{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}`

const quizFence = "```quiz\n{\"questions\":[" + embedQuestion + "]}\n```"

// An agent edit that is one quiz fence and nothing else records its sources
// on the quiz it creates and leaves the note's own record alone. An edit with
// anything beside the fence keeps them on the note, which cannot tell them
// apart (create_material always does: a note needs text).
func TestFenceSourcesGoToTheirItem(t *testing.T) {
	h, st := openInternalHTTP(t)
	var sent []*store.Provenance
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Provenance *store.Provenance `json:"provenance"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		sent = append(sent, body.Provenance)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document"}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	ctx := context.Background()

	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	create := noteBody(msgID, "call_fence_note", "Fence "+msgID, "# Lecture\n\nBody.")
	create["provenance"] = creditBody("own", "CC BY 4.0")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, create)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	noteID := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, noteID)
	edit := func(call, markdown, book string) {
		t.Helper()
		rec := doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": "u_editor",
			"assistantMessageId": msgID, "toolCallId": call,
			"target":     map[string]any{"kind": "material", "id": noteID},
			"commands":   []map[string]any{{"type": "insert_markdown", "after_block_id": nil, "markdown": markdown}},
			"provenance": creditBody(book, "CC BY 4.0"),
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("edit %s status = %d body=%s", call, rec.Code, rec.Body.String())
		}
	}
	credit := func(id string) string {
		t.Helper()
		mt, err := st.GetMaterial(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return creditedBooks(mt.Provenance)
	}

	edit("call_fence_only", quizFence, "fence")
	only := store.ChatMaterialID(msgID, "call_fence_only/0/embedded/0")
	if len(sent) != 1 || sent[0] != nil {
		t.Fatalf("authority provenance = %+v, want the note's record untouched", sent)
	}
	if got := credit(only); got != "fence" {
		t.Fatalf("quiz credits = %q, want the write's source", got)
	}

	edit("call_fence_prose", "Check yourself.\n\n"+quizFence, "mixed")
	beside := store.ChatMaterialID(msgID, "call_fence_prose/0/embedded/0")
	if len(sent) != 2 || creditedBooks(sent[1]) != "own mixed" {
		t.Fatalf("authority provenance = %+v, want the note's own plus the write's", sent[1])
	}
	if got := credit(beside); got != "" {
		t.Fatalf("quiz beside prose credits = %q, want none", got)
	}

}

// A note read credits its own sources plus its live embeds', computed for the
// read: the app's material read, and the public note with each embed's own
// credits. A trashed embed drops out and returns on restore; the note's stored
// record never changes.
func TestNoteReadsCreditLiveEmbeds(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	own := &store.Provenance{Books: []store.ProvenanceBook{{ID: "own", Title: "Own", Authors: []string{}, License: "CC BY-SA 4.0", ExcerptIDs: []string{"e_own"}, Version: 1}}, License: "CC BY-SA 4.0"}
	note, err := st.CreateMaterial(ctx, store.Material{CreatedBy: "u_owner", Kind: "note", Title: "Credited embeds", Content: "# Embeds\n\nbody", Provenance: own})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, note.ID)
	quizCredit := &store.Provenance{Books: []store.ProvenanceBook{{ID: "quiz", Title: "Quiz book", Authors: []string{}, License: "CC BY 4.0", ExcerptIDs: []string{"e_quiz"}, Version: 1}}}
	quiz, err := st.CreateEmbeddedMaterial(ctx, "u_owner", note.ID, store.EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[` + embedQuestion + `]`), Provenance: quizCredit,
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, quiz.ID)
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
		materialdoc.ParagraphNode("intro"), materialdoc.MaterialRefNode(quiz.ID, "quiz"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateMaterial(ctx, note.ID, store.MaterialPatch{Content: &content, UpdatedBy: "u_owner"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateStandaloneMaterialPrivacy(ctx, "u_owner", note.ID, "", store.PrivacyLink); err != nil {
		t.Fatal(err)
	}
	read := func() *store.Provenance {
		t.Helper()
		rec := doAsUser(t, h, http.MethodGet, "/api/materials/"+note.ID, "u_owner", nil)
		var body struct {
			Provenance *store.Provenance `json:"provenance"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &body) != nil {
			t.Fatalf("material read → %d %s", rec.Code, rec.Body.String())
		}
		return body.Provenance
	}
	if got := read(); creditedBooks(got) != "own quiz" || got.License != "CC BY-SA 4.0" {
		t.Fatalf("note read credits = %+v, want its own then its quiz's, under its own licence", got)
	}
	rec := doReq(t, h, http.MethodGet, "/api/public/notes/"+store.ShareToken(nil, note.ID), "", nil)
	var shared struct {
		Provenance *store.Provenance `json:"provenance"`
		Embeds     []struct {
			ID         string            `json:"id"`
			Provenance *store.Provenance `json:"provenance"`
		} `json:"embeds"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &shared) != nil {
		t.Fatalf("public note → %d %s", rec.Code, rec.Body.String())
	}
	if creditedBooks(shared.Provenance) != "own quiz" || len(shared.Embeds) != 1 || creditedBooks(shared.Embeds[0].Provenance) != "quiz" {
		t.Fatalf("public note credits = %s", rec.Body.String())
	}

	if _, err := st.Pool().Exec(ctx, `UPDATE materials SET trashed_at=now(), trash_episode_id='trash_embed_credit',
		purge_after=now() + interval '1 day' WHERE id=$1`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	if got := creditedBooks(read()); got != "own" {
		t.Fatalf("with its quiz trashed the note credits %q, want its own only", got)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE materials SET trashed_at=NULL, trash_episode_id=NULL, purge_after=NULL WHERE id=$1`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	if got := creditedBooks(read()); got != "own quiz" {
		t.Fatalf("restored quiz: the note credits %q", got)
	}
	stored, err := st.GetMaterial(ctx, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if creditedBooks(stored.Provenance) != "own" {
		t.Fatalf("stored note record = %+v, want its own book only", stored.Provenance)
	}
}
