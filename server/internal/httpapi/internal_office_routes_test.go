package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
// office object and its scoped answer comes back unchanged, a DOCX page's
// query being its start and count; PPTX reads its entries a page at a time
// until the engine's scoped PPTX read lands, and inspect_document points an
// Office file at the Office tools.
func TestOfficeInspectPassesTheQueryThrough(t *testing.T) {
	fx := openDeckFiles(t)
	scoped := `{"sheet":"0","name":"Grades","range":"A1:B2","cells":[{"address":"A1","input":"=1+1","value":"2"}]}`
	authority := newOfficeAuthority(t, fx.st, map[string]string{
		"/internal/documents/inspect": `{"format":"xlsx","access":"edit","epoch":2,"checkpoint":5,"scoped":` + scoped +
			`,"entries":[{"id":"p1","label":"Paragraph 1","value":"One"},{"id":"p2","label":"Paragraph 2","value":"Two"}]}`,
	})
	xlsx, docx, pptx := officeSource(t, fx, "grades.xlsx"), officeSource(t, fx, "essay.docx"), officeSource(t, fx, "lesson.pptx")
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

	operations := `"supportedOperations":["replace_text","insert_paragraph","delete_paragraph"]`
	rec = inspect(docx, map[string]any{"start": 1, "count": 1})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"scoped":`+scoped) ||
		!strings.Contains(rec.Body.String(), strings.TrimSuffix(operations, "]")+
			`,"set_list","insert_table","delete_table","format_text","set_alignment"]`) {
		t.Fatalf("docx read = %d %s", rec.Code, rec.Body.String())
	}
	if sent := authority.sent("/internal/documents/inspect"); len(sent) != 2 || string(sent[1]["office"]) != `{"start":1,"count":1}` {
		t.Fatalf("a DOCX page's query: %v", sent)
	}

	rec = inspect(pptx, map[string]any{"start": 1, "count": 1})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"entries":[{"id":"p2","label":"Paragraph 2","value":"Two"}]`) ||
		!strings.Contains(rec.Body.String(), operations) {
		t.Fatalf("pptx read = %d %s", rec.Code, rec.Body.String())
	}
	if sent := authority.sent("/internal/documents/inspect"); len(sent) != 3 || sent[2]["office"] != nil {
		t.Fatalf("a PPTX page sent an office query: %v", sent)
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
	if receipt.Effect.Undo == nil || receipt.Effect.Undo.OperationID != receipt.OperationID {
		t.Fatalf("undo ref = %s", rec.Body.String())
	}

	replay := doInternal(t, fx.h, http.MethodPost, "/api/internal/documents/office/create", pipeSecret, body)
	if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), receipt.Effect.Resource.ID) ||
		len(authority.sent("/internal/documents/create")) != 1 || fx.blobs(t) != 1 {
		t.Fatalf("replay = %d %s", replay.Code, replay.Body.String())
	}

	// A Word file is created the same way, its commands normalized.
	rec = doInternal(t, fx.h, http.MethodPost, "/api/internal/documents/office/create", pipeSecret, map[string]any{
		"workspaceId": fx.ws, "userId": fx.editor, "assistantMessageId": msgID, "toolCallId": "call_create_docx",
		"format": "docx", "title": "Lab report",
		"commands": []map[string]any{{"type": "insert_paragraph", "text": "Method", "style": "Heading1"}},
	})
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil || rec.Code != http.StatusOK ||
		receipt.Effect == nil || receipt.Effect.Resource.Title != "Lab report.docx" {
		t.Fatalf("docx create = %d %s", rec.Code, rec.Body.String())
	}
	sent = authority.sent("/internal/documents/create")
	if len(sent) != 2 || string(sent[1]["format"]) != `"docx"` ||
		string(sent[1]["commands"]) != `[{"style":"Heading1","text":"Method","type":"insert_paragraph"}]` {
		t.Fatalf("authority got %v", sent)
	}
}

// A viewer, an editor of another workspace, and a chapter not in the
// workspace are refused before the collaboration server builds anything, and
// nothing is stored.
func TestOfficeCreateRefusalsBuildAndStoreNothing(t *testing.T) {
	fx := openDeckFiles(t)
	ctx := context.Background()
	authority := newOfficeAuthority(t, fx.st, map[string]string{
		"/internal/documents/create": `{"content":"UEsDBA=="}`,
	})
	stranger := fmt.Sprintf("u_office_stranger_%d", time.Now().UnixNano())
	if _, err := fx.st.Pool().Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
		VALUES ($1, 'Stranger', $2, 'free')`, stranger, stranger+"@example.test"); err != nil {
		t.Fatal(err)
	}
	elsewhere, err := fx.st.CreateWorkspace(ctx, stranger, store.WorkspaceCreate{Name: "Elsewhere"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = fx.st.Pool().Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, elsewhere.ID)
		_, _ = fx.st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, stranger)
	})
	for _, tc := range []struct {
		name, user, ws, chapter string
		status                  int
	}{
		{"viewer", fx.viewer, fx.ws, "", http.StatusForbidden},
		{"editor of another workspace", fx.editor, elsewhere.ID, "", http.StatusForbidden},
		{"chapter not in the workspace", fx.editor, fx.ws, "ch_elsewhere", http.StatusBadRequest},
	} {
		msgID := seedAssistantMessage(t, fx.st, tc.user, tc.ws)
		rec := doInternal(t, fx.h, http.MethodPost, "/api/internal/documents/office/create", pipeSecret, map[string]any{
			"workspaceId": tc.ws, "userId": tc.user, "assistantMessageId": msgID, "toolCallId": "call_create",
			"format": "xlsx", "title": "Grades", "chapterId": tc.chapter, "commands": []map[string]any{},
		})
		if rec.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	var files int
	if err := fx.st.Pool().QueryRow(ctx, `SELECT count(*) FROM files WHERE workspace_id = ANY($1)`,
		[]string{fx.ws, elsewhere.ID}).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if built := len(authority.sent("/internal/documents/create")); built != 0 || files != 0 || fx.blobs(t) != 0 {
		t.Fatalf("built %d, files %d, blobs %d", built, files, fx.blobs(t))
	}
}

// A retried edit or create whose first attempt is still running waits for
// it (Epo 2026-10-20, review finding 3): the retrieval service gave up on the
// first attempt, which still finishes, and the retry answers the receipt that
// attempt stored, from one collaboration call.
func TestOfficeRetryWaitsForTheRunningAttempt(t *testing.T) {
	fx := openDeckFiles(t)
	xlsx := officeSource(t, fx, "grades.xlsx")
	msgID := seedAssistantMessage(t, fx.st, fx.editor, fx.ws)
	arrived, release := make(chan string, 4), make(chan struct{})
	var calls sync.Map
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Operation store.DocumentOperation `json:"operation"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		count, _ := calls.LoadOrStore(r.URL.Path, new(atomic.Int32))
		count.(*atomic.Int32).Add(1)
		arrived <- r.URL.Path
		<-release
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/internal/documents/create" {
			_, _ = w.Write([]byte(`{"content":"UEsDBA=="}`))
			return
		}
		// The collaboration server commits an edit's receipt through Go's
		// checkpoint route; here it is written directly.
		op := body.Operation
		if _, err := fx.st.Pool().Exec(context.Background(), `INSERT INTO agent_operations
			(id, kind, request_hash, actor_user_id, workspace_id, message_id, call_id, outcome)
			VALUES ($1, 'edit_document', $2, $3, $4, $5, $6, 'succeeded')`,
			op.ID, op.RequestHash, fx.editor, fx.ws, op.MessageID, op.CallID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		receipt, _ := fx.st.GetAgentOperation(context.Background(), op.ID)
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	t.Cleanup(server.Close)
	t.Cleanup(sync.OnceFunc(func() { close(release) }))
	fx.st.ConfigureCollaboration(server.URL, "collab-test-secret")

	post := func(ctx context.Context, path string, body map[string]any) <-chan *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Pipeline-Secret", pipeSecret)
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			rec := httptest.NewRecorder()
			fx.h.ServeHTTP(rec, req)
			done <- rec
		}()
		return done
	}
	for _, tc := range []struct {
		route, authority string
		body             map[string]any
	}{
		{"/api/internal/documents/edit", "/internal/documents/edit", map[string]any{
			"workspaceId": fx.ws, "userId": fx.editor, "assistantMessageId": msgID, "toolCallId": "call_slow_edit",
			"target": map[string]any{"kind": "source_file", "id": xlsx}, "office": true,
			"commands": []map[string]any{{"type": "rename_sheet", "sheet": "0", "expected_name": "Sheet1", "name": "Grades"}},
		}},
		{"/api/internal/documents/office/create", "/internal/documents/create", map[string]any{
			"workspaceId": fx.ws, "userId": fx.editor, "assistantMessageId": msgID, "toolCallId": "call_slow_create",
			"format": "xlsx", "title": "Grades", "commands": []map[string]any{},
		}},
	} {
		gaveUp, cancel := context.WithCancel(context.Background())
		first := post(gaveUp, tc.route, tc.body)
		<-arrived
		cancel()
		retry := post(context.Background(), tc.route, tc.body)
		select {
		case path := <-arrived:
			t.Fatalf("%s: the retry reached %s while the first attempt ran", tc.route, path)
		case <-time.After(300 * time.Millisecond):
		}
		release <- struct{}{}
		one, two := <-first, <-retry
		var receipts [2]receiptBody
		for i, rec := range []*httptest.ResponseRecorder{one, two} {
			if err := json.Unmarshal(rec.Body.Bytes(), &receipts[i]); err != nil || rec.Code != http.StatusOK {
				t.Fatalf("%s: answer %d = %d %s", tc.route, i+1, rec.Code, rec.Body.String())
			}
		}
		count, _ := calls.Load(tc.authority)
		if receipts[0].OperationID == "" || receipts[0].Outcome != "succeeded" || !reflect.DeepEqual(receipts[0], receipts[1]) ||
			count.(*atomic.Int32).Load() != 1 {
			t.Fatalf("%s: first %s, retry %s, %d calls", tc.route, one.Body.String(), two.Body.String(), count.(*atomic.Int32).Load())
		}
	}
}
