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

// An agent write cannot say which of its sources went into which quiz or
// flashcards fence, so every fence's item records all of them, and the note
// keeps them only when the write put anything else in it (Epo 2026-10-10:
// over-credit): edit_document in every shape, and create_material, whose note
// always has text.
func TestAgentWriteSourcesReachEveryFence(t *testing.T) {
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
	run := func(call, book string, commands ...map[string]any) {
		t.Helper()
		rec := doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": "u_editor",
			"assistantMessageId": msgID, "toolCallId": call,
			"target":     map[string]any{"kind": "material", "id": noteID},
			"commands":   commands,
			"provenance": creditBody(book, "CC BY 4.0"),
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("edit %s status = %d body=%s", call, rec.Code, rec.Body.String())
		}
	}
	insert := func(markdown string) map[string]any {
		return map[string]any{"type": "insert_markdown", "after_block_id": nil, "markdown": markdown}
	}
	edit := func(call, markdown, book string) { t.Helper(); run(call, book, insert(markdown)) }
	credit := func(id string) string {
		t.Helper()
		mt, err := st.GetMaterial(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return creditedBooks(mt.Provenance)
	}

	// Nothing but fences: the items hold the sources, the note's record is
	// untouched (the authority gets no provenance for it).
	edit("call_fence_only", quizFence, "fence")
	if len(sent) != 1 || sent[0] != nil || credit(store.ChatMaterialID(msgID, "call_fence_only/0/embedded/0")) != "fence" {
		t.Fatalf("lone fence: authority %+v", sent)
	}
	run("call_fence_replace", "replaced", map[string]any{"type": "replace_block", "block_id": "b1", "expected_text": "Body.", "markdown": quizFence})
	if len(sent) != 2 || sent[1] != nil || credit(store.ChatMaterialID(msgID, "call_fence_replace/0/embedded/0")) != "replaced" {
		t.Fatalf("replace_block with one fence: authority %+v", sent[1])
	}
	edit("call_fence_two_fences", quizFence+"\n\n"+quizFence, "twofence")
	if len(sent) != 3 || sent[2] != nil ||
		credit(store.ChatMaterialID(msgID, "call_fence_two_fences/0/embedded/0")) != "twofence" ||
		credit(store.ChatMaterialID(msgID, "call_fence_two_fences/0/embedded/1")) != "twofence" {
		t.Fatalf("two fences: authority %+v", sent[2])
	}

	// Anything else in the write: the items and the note both hold them.
	edit("call_fence_prose", "Check yourself.\n\n"+quizFence, "mixed")
	if len(sent) != 4 || creditedBooks(sent[3]) != "own mixed" || credit(store.ChatMaterialID(msgID, "call_fence_prose/0/embedded/0")) != "mixed" {
		t.Fatalf("prose beside a fence: authority %+v", sent[3])
	}
	run("call_fence_two_commands", "twocmd", insert(quizFence), map[string]any{"type": "replace_text", "target_id": "b1", "expected_text": "Body.", "text": "Changed."})
	if len(sent) != 5 || creditedBooks(sent[4]) != "own twocmd" || credit(store.ChatMaterialID(msgID, "call_fence_two_commands/0/embedded/0")) != "twocmd" {
		t.Fatalf("fence plus replace_text: authority %+v", sent[4])
	}
	created := noteBody(msgID, "call_fence_create", "Created "+msgID, "# Lecture\n\nBody.\n\n"+quizFence)
	created["provenance"] = creditBody("created", "CC BY 4.0")
	rec = doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, created)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	createdID := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, createdID)
	if credit(createdID) != "created" || credit(store.ChatMaterialID(msgID, "call_fence_create/embedded/0")) != "created" {
		t.Fatalf("create_material with a fence: note %q, quiz %q", credit(createdID), credit(store.ChatMaterialID(msgID, "call_fence_create/embedded/0")))
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

// The note's footer licence covers the note's sources and its live embeds',
// so a lone fence cannot bring a second copyleft family into it (refused as on
// a plain note), and a plain note embedding a ShareAlike quiz reads as
// ShareAlike.
func TestFooterLicenceCoversNoteAndEmbeds(t *testing.T) {
	h, st := openInternalHTTP(t)
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document"}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	ctx := context.Background()
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	note := func(call, license string) string {
		t.Helper()
		body := noteBody(msgID, call, "Licence "+call+" "+msgID, "# Lecture\n\nBody.")
		body["provenance"] = creditBody("own_"+call, license)
		rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
		}
		id := decodeReceipt(t, rec).Effect.Resource.ID
		cleanupMaterial(t, st, id)
		return id
	}
	edit := func(noteID, call, markdown, book, license string) *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": "u_editor",
			"assistantMessageId": msgID, "toolCallId": call,
			"target":     map[string]any{"kind": "material", "id": noteID},
			"commands":   []map[string]any{{"type": "insert_markdown", "after_block_id": nil, "markdown": markdown}},
			"provenance": creditBody(book, license),
		})
	}

	sa := note("call_lic_sa", "CC BY-SA 4.0")
	for _, c := range []struct{ call, markdown string }{{"call_lic_prose", "Prose.\n\n" + quizFence}, {"call_lic_lone", quizFence}} {
		rec := edit(sa, c.call, c.markdown, "ncsa", "CC BY-NC-SA 4.0")
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "lifecycle_rejected") {
			t.Fatalf("%s: NonCommercial beside ShareAlike = %d %s, want lifecycle_rejected", c.call, rec.Code, rec.Body.String())
		}
	}
	if _, err := st.GetMaterial(ctx, store.ChatMaterialID(msgID, "call_lic_lone/0/embedded/0")); err == nil {
		t.Fatal("the refused fence left its quiz behind")
	}

	plain := note("call_lic_plain", "CC BY 4.0")
	if rec := edit(plain, "call_lic_embed", quizFence, "sa_quiz", "CC BY-SA 4.0"); rec.Code != http.StatusOK {
		t.Fatalf("ShareAlike quiz in a plain note = %d %s", rec.Code, rec.Body.String())
	}
	quiz := store.ChatMaterialID(msgID, "call_lic_embed/0/embedded/0")
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
		materialdoc.ParagraphNode("Body."), materialdoc.MaterialRefNode(quiz, "quiz"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	// What the authority's projection would store (the stub stores nothing).
	if _, err := st.Pool().Exec(ctx, `UPDATE materials SET content=$2 WHERE id=$1`, plain, content); err != nil {
		t.Fatal(err)
	}
	rec := doAsUser(t, h, http.MethodGet, "/api/materials/"+plain, "u_editor", nil)
	var body struct {
		Provenance *store.Provenance `json:"provenance"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &body) != nil ||
		creditedBooks(body.Provenance) != "own_call_lic_plain sa_quiz" || body.Provenance.License != "CC BY-SA 4.0" {
		t.Fatalf("plain note with a ShareAlike quiz reads %d %s", rec.Code, rec.Body.String())
	}
}
