package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// deckFileFixture is a fresh Free workspace with an editor and a viewer, so a
// filled quota or a stored deck touches no other test's rows.
type deckFileFixture struct {
	h                             http.Handler
	st                            *store.Store
	mem                           *blob.Memory
	ws, owner, editor, viewer, ch string
}

func openDeckFiles(t *testing.T) deckFileFixture {
	t.Helper()
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	stamp := time.Now().UnixNano()
	fx := deckFileFixture{h: h, st: st, mem: mem}
	ids := []*string{&fx.owner, &fx.editor, &fx.viewer}
	for i, role := range []string{"own", "edit", "view"} {
		*ids[i] = fmt.Sprintf("u_deck_%s_%d", role, stamp)
		if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
			VALUES ($1, 'Deck Test', $2, 'free')`, *ids[i], *ids[i]+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	ws, err := st.CreateWorkspace(ctx, fx.owner, store.WorkspaceCreate{Name: "Decks"})
	if err != nil {
		t.Fatal(err)
	}
	fx.ws = ws.ID
	for user, role := range map[string]string{fx.editor: "editor", fx.viewer: "viewer"} {
		if _, err := st.Pool().Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
			VALUES ($1, $2, $3)`, fx.ws, user, role); err != nil {
			t.Fatal(err)
		}
	}
	chapter, err := st.AddChapter(ctx, fx.ws, fx.owner, "Circles")
	if err != nil {
		t.Fatal(err)
	}
	fx.ch = chapter.ID
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = st.Pool().Exec(ctx, `DELETE FROM jobs WHERE payload->>'workspaceId'=$1`, fx.ws)
		_, _ = st.Pool().Exec(ctx, `DELETE FROM provider_sessions WHERE actor_user_id = ANY($1)`, []string{fx.owner, fx.editor, fx.viewer})
		_, _ = st.Pool().Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, fx.ws)
		_, _ = st.Pool().Exec(ctx, `DELETE FROM users WHERE id = ANY($1)`, []string{fx.owner, fx.editor, fx.viewer})
	})
	return fx
}

func (fx deckFileFixture) body(msgID, userID string) map[string]any {
	return map[string]any{
		"workspaceId": fx.ws, "userId": userID, "assistantMessageId": msgID, "toolCallId": "call_last_slide",
		"name": "Tangents.pptx", "chapterId": fx.ch, "content": []byte("PK\x03\x04 a deck"),
		"provenance": map[string]any{"books": []map[string]any{{
			"id": "b_circles", "title": "Circles", "authors": []string{"A. Author"},
			"license": "CC BY-SA 4.0", "excerptIds": []string{"exc_1"}, "version": 1,
		}}},
	}
}

func (fx deckFileFixture) blobs(t *testing.T) int {
	t.Helper()
	listing, err := fx.mem.ListObjects(context.Background(), "sources/", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	return len(listing.Keys)
}

// The deck lands like an upload: charged to the owner, filed in its chapter,
// with its provenance and a parse job, and a replay returns the same file.
func TestInternalFileStoresTheDeckLikeAnUpload(t *testing.T) {
	fx := openDeckFiles(t)
	ctx := context.Background()
	msgID := seedAssistantMessage(t, fx.st, fx.editor, fx.ws)
	rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/files", pipeSecret, fx.body(msgID, fx.editor))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var receipt receiptBody
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Effect == nil || receipt.Effect.Operation != "created" || receipt.Effect.Resource.Kind != "source_file" ||
		receipt.Effect.Resource.Title != "Tangents.pptx" || receipt.OperationID != store.ChatOperationID(msgID, "call_last_slide") {
		t.Fatalf("receipt = %s", rec.Body.String())
	}
	fileID := receipt.Effect.Resource.ID
	file, err := fx.st.GetFile(ctx, fileID)
	if err != nil {
		t.Fatal(err)
	}
	if file.Kind != "slides" || file.ChapterID == nil || *file.ChapterID != fx.ch || file.SizeBytes != int64(len("PK\x03\x04 a deck")) {
		t.Fatalf("file = %+v", file)
	}
	if file.Provenance == nil || len(file.Provenance.Books) != 1 || file.Provenance.License != "CC BY-SA 4.0" {
		t.Fatalf("provenance = %+v", file.Provenance)
	}
	var payer, jobType string
	if err := fx.st.Pool().QueryRow(ctx, `SELECT user_id FROM files WHERE id=$1`, fileID).Scan(&payer); err != nil {
		t.Fatal(err)
	}
	if payer != fx.owner {
		t.Fatalf("charged %s, want the workspace owner", payer)
	}
	if err := fx.st.Pool().QueryRow(ctx, `SELECT type FROM jobs WHERE payload->>'fileId'=$1`, fileID).Scan(&jobType); err != nil || jobType != "parse" {
		t.Fatalf("job = %q, %v", jobType, err)
	}

	replay := doInternal(t, fx.h, http.MethodPost, "/api/internal/files", pipeSecret, fx.body(msgID, fx.editor))
	var again receiptBody
	if err := json.Unmarshal(replay.Body.Bytes(), &again); err != nil || replay.Code != http.StatusOK || again.Effect.Resource.ID != fileID {
		t.Fatalf("replay = %d %s", replay.Code, replay.Body.String())
	}
	var files int
	if err := fx.st.Pool().QueryRow(ctx, `SELECT count(*) FROM files WHERE workspace_id=$1`, fx.ws).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if files != 1 || fx.blobs(t) != 1 {
		t.Fatalf("files = %d blobs = %d after a replay", files, fx.blobs(t))
	}
}

func TestInternalFileRefusesAFullOwnerQuota(t *testing.T) {
	fx := openDeckFiles(t)
	ctx := context.Background()
	limit := mustPlanLimits(t, fx.st, store.PlanFree).StorageBytes
	if _, err := fx.st.CreateSourceReady(ctx, fx.ws, fx.owner, "ballast.pdf", "pdf", nil, "", limit, "sources/ballast_"+fx.owner); err != nil {
		t.Fatal(err)
	}
	msgID := seedAssistantMessage(t, fx.st, fx.editor, fx.ws)
	rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/files", pipeSecret, fx.body(msgID, fx.editor))
	if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if fx.blobs(t) != 0 {
		t.Fatal("a refused deck left its blob behind")
	}
}

// The upload's editor check gates the route, and the actor and workspace must
// be the assistant message's own.
func TestInternalFileNeedsAnEditorOnTheMessagesWorkspace(t *testing.T) {
	fx := openDeckFiles(t)
	viewerMsg := seedAssistantMessage(t, fx.st, fx.viewer, fx.ws)
	if rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/files", pipeSecret, fx.body(viewerMsg, fx.viewer)); rec.Code != http.StatusNotFound {
		t.Fatalf("viewer: %d %s", rec.Code, rec.Body.String())
	}
	editorMsg := seedAssistantMessage(t, fx.st, fx.editor, fx.ws)
	otherActor := fx.body(editorMsg, fx.owner)
	if rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/files", pipeSecret, otherActor); rec.Code != http.StatusNotFound {
		t.Fatalf("another actor on the editor's message: %d %s", rec.Code, rec.Body.String())
	}
	otherWS := fx.body(editorMsg, "u_editor")
	otherWS["workspaceId"] = "ws_e2e_private"
	if rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/files", pipeSecret, otherWS); rec.Code != http.StatusNotFound {
		t.Fatalf("another workspace: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/files", "wrong", fx.body(editorMsg, fx.editor)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad secret: %d", rec.Code)
	}
	if fx.blobs(t) != 0 {
		t.Fatal("a refused deck left a blob behind")
	}
}
