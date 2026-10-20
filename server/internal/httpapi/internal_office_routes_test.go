package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// officeAuthority stands in for the collaboration server's document routes
// (built separately): it records each request and answers per path.
type officeAuthority struct {
	mu       sync.Mutex
	requests map[string][]map[string]json.RawMessage
}

func newOfficeAuthority(t *testing.T, st *store.Store, answers map[string]string) *officeAuthority {
	t.Helper()
	a := &officeAuthority{requests: map[string][]map[string]json.RawMessage{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		a.mu.Lock()
		a.requests[r.URL.Path] = append(a.requests[r.URL.Path], body)
		a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(answers[r.URL.Path]))
	}))
	t.Cleanup(server.Close)
	st.ConfigureCollaboration(server.URL, "collab-test-secret")
	return a
}

func (a *officeAuthority) sent(path string) []map[string]json.RawMessage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.requests[path]
}

func officeSource(t *testing.T, fx deckFileFixture, name string) string {
	t.Helper()
	file, err := uploadSource(context.Background(), fx.st, fx.ws, fx.editor, name, 64, "sources/office_"+fx.ws+"_"+name)
	if err != nil {
		t.Fatal(err)
	}
	return file.ID
}

// inspect_office_document's query reaches the engine as the inspect body's
// office object and its scoped answer comes back unchanged; DOCX reads its
// entries a page at a time until the engine's scoped DOCX read lands, and
// inspect_document points an Office file at the Office tools.
func TestOfficeInspectPassesTheQueryThrough(t *testing.T) {
	fx := openDeckFiles(t)
	scoped := `{"sheet":"0","name":"Grades","range":"A1:B2","cells":[{"address":"A1","input":"=1+1","value":"2"}]}`
	authority := newOfficeAuthority(t, fx.st, map[string]string{
		"/internal/documents/inspect": `{"format":"xlsx","access":"edit","epoch":2,"checkpoint":5,"scoped":` + scoped +
			`,"entries":[{"id":"p1","label":"Paragraph 1","value":"One"},{"id":"p2","label":"Paragraph 2","value":"Two"}]}`,
	})
	xlsx, docx := officeSource(t, fx, "grades.xlsx"), officeSource(t, fx, "essay.docx")
	inspect := func(file string, office any) *httptest.ResponseRecorder {
		body := map[string]any{
			"workspaceId": fx.ws, "userId": fx.editor, "target": map[string]any{"kind": "source_file", "id": file},
		}
		if office != nil {
			body["office"] = office
		}
		return doInternal(t, fx.h, http.MethodPost, "/api/internal/documents/inspect", pipeSecret, body)
	}

	rec := inspect(xlsx, map[string]any{"sheet": "Grades", "range": "A1:B2"})
	var read struct {
		Format string          `json:"format"`
		Title  string          `json:"title"`
		Scoped json.RawMessage `json:"scoped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &read); err != nil || rec.Code != http.StatusOK ||
		read.Format != "xlsx" || read.Title != "grades.xlsx" || string(read.Scoped) != scoped {
		t.Fatalf("xlsx read = %d %s", rec.Code, rec.Body.String())
	}
	if sent := authority.sent("/internal/documents/inspect"); len(sent) != 1 || string(sent[0]["office"]) != `{"sheet":"Grades","range":"A1:B2"}` {
		t.Fatalf("authority got %v", sent)
	}

	rec = inspect(docx, map[string]any{"start": 1, "count": 1})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"entries":[{"id":"p2","label":"Paragraph 2","value":"Two"}]`) ||
		!strings.Contains(rec.Body.String(), `"supportedOperations":["replace_text"]`) {
		t.Fatalf("docx read = %d %s", rec.Code, rec.Body.String())
	}
	if sent := authority.sent("/internal/documents/inspect"); len(sent) != 2 || sent[1]["office"] != nil {
		t.Fatalf("a DOCX page sent an office query: %v", sent)
	}

	rec = inspect(xlsx, nil)
	if rec.Code != http.StatusUnprocessableEntity || errorCode(t, rec) != "unsupported_operation" ||
		!strings.Contains(rec.Body.String(), `read_skill(\"office_building\")`) {
		t.Fatalf("inspect_document on an Office file = %d %s", rec.Code, rec.Body.String())
	}
}

// An edit_office_document call reaches the engine in its commands, through
// the edit route's receipt; edit_document refuses an Office file.
func TestOfficeEditReachesTheEngineNormalized(t *testing.T) {
	fx := openDeckFiles(t)
	authority := newOfficeAuthority(t, fx.st, map[string]string{
		"/internal/documents/edit": `{"operationId":"op","outcome":"succeeded","kind":"edit_document","notice":"Removed 1 control character."}`,
	})
	xlsx := officeSource(t, fx, "grades.xlsx")
	msgID := seedAssistantMessage(t, fx.st, fx.editor, fx.ws)
	edit := func(call string, office bool, command map[string]any) *httptest.ResponseRecorder {
		return doInternal(t, fx.h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
			"workspaceId": fx.ws, "userId": fx.editor, "assistantMessageId": msgID, "toolCallId": call,
			"target": map[string]any{"kind": "source_file", "id": xlsx}, "office": office,
			"commands": []map[string]any{command},
		})
	}
	rec := edit("call_office_edit", true, map[string]any{
		"type": "rename_sheet", "sheet": "0", "expected_name": "Sheet1", "name": "Grades",
	})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notice":"Removed 1 control character."`) {
		t.Fatalf("office edit = %d %s", rec.Code, rec.Body.String())
	}
	sent := authority.sent("/internal/documents/edit")
	if len(sent) != 1 || string(sent[0]["commands"]) != `[{"expectedName":"Sheet1","name":"Grades","sheet":"0","type":"rename_sheet"}]` {
		t.Fatalf("authority got %v", sent)
	}

	rec = edit("call_document_edit", false, map[string]any{"type": "replace_text", "target_id": "x", "expected_text": "a", "text": "b"})
	if rec.Code != http.StatusUnprocessableEntity || errorCode(t, rec) != "unsupported_operation" || len(authority.sent("/internal/documents/edit")) != 1 {
		t.Fatalf("edit_document on an Office file = %d %s", rec.Code, rec.Body.String())
	}
}

// create builds the file in the engine from the call's other commands and
// stores it like the agent's deck: an upload with a receipt whose Undo trashes
// it, and a replay that neither builds nor stores it again.
func TestOfficeCreateStoresTheFileWithItsUndo(t *testing.T) {
	fx := openDeckFiles(t)
	content := []byte("PK\x03\x04 a workbook")
	encoded, _ := json.Marshal(content)
	authority := newOfficeAuthority(t, fx.st, map[string]string{
		"/internal/documents/create": `{"content":` + string(encoded) + `}`,
	})
	msgID := seedAssistantMessage(t, fx.st, fx.editor, fx.ws)
	body := map[string]any{
		"workspaceId": fx.ws, "userId": fx.editor, "assistantMessageId": msgID, "toolCallId": "call_create",
		"format": "xlsx", "title": "Term 1 / grades", "chapterId": fx.ch,
		"commands": []map[string]any{{"type": "set_range", "sheet": "Sheet1", "range": "A1", "expected": [][]string{{""}}, "values": [][]string{{"Name"}}}},
	}
	rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/documents/office/create", pipeSecret, body)
	var receipt receiptBody
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	if receipt.Effect == nil || receipt.Effect.Operation != "created" || receipt.Effect.Resource.Kind != "source_file" ||
		receipt.Effect.Resource.Title != "Term 1 grades.xlsx" {
		t.Fatalf("receipt = %s", rec.Body.String())
	}
	sent := authority.sent("/internal/documents/create")
	if len(sent) != 1 || string(sent[0]["format"]) != `"xlsx"` || string(sent[0]["actorUserId"]) != `"`+fx.editor+`"` ||
		string(sent[0]["commands"]) != `[{"expected":[[""]],"range":"A1","sheet":"Sheet1","type":"set_range","values":[["Name"]]}]` {
		t.Fatalf("authority got %v", sent)
	}
	file, err := fx.st.GetFile(context.Background(), receipt.Effect.Resource.ID)
	if err != nil || file.SizeBytes != int64(len(content)) || file.ChapterID == nil || *file.ChapterID != fx.ch {
		t.Fatalf("file = %+v err = %v", file, err)
	}
	step, _, err := fx.st.GetEditInverse(context.Background(), receipt.OperationID)
	if err != nil || step.Step != store.StepTrash {
		t.Fatalf("undo step = %+v err = %v", step, err)
	}

	replay := doInternal(t, fx.h, http.MethodPost, "/api/internal/documents/office/create", pipeSecret, body)
	if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), receipt.Effect.Resource.ID) ||
		len(authority.sent("/internal/documents/create")) != 1 || fx.blobs(t) != 1 {
		t.Fatalf("replay = %d %s", replay.Code, replay.Body.String())
	}
}
