package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// paperStub stands in for the pipeline's /paper: it finds every part on page
// 1, reads the choice part as B and grades the open part full when asked to.
type paperStub struct {
	calls atomic.Int32
	fail  atomic.Bool
	// unreadable answers as the pipeline does for a PDF it can't open (Q730).
	unreadable atomic.Bool
	// openFails answers each open part graded with an error.
	openFails atomic.Bool
	// gate, while set, holds each call until it is closed (Q729).
	gate   atomic.Pointer[chan struct{}]
	mu     sync.Mutex
	grades []bool
}

// hold makes the next calls wait until the returned release.
func (stub *paperStub) hold(t *testing.T) (release func()) {
	gate := make(chan struct{})
	stub.gate.Store(&gate)
	var once sync.Once
	release = func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	return release
}

func openPaperAPI(t *testing.T) (http.Handler, *store.Store, *paperStub) {
	t.Helper()
	stub := &paperStub{}
	pipe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/paper" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		stub.calls.Add(1)
		if gate := stub.gate.Load(); gate != nil {
			select {
			case <-*gate:
			case <-r.Context().Done():
				return
			}
		}
		var body struct {
			Parts []struct {
				ID    string `json:"id"`
				Type  string `json:"type"`
				Items []any  `json:"items"`
			} `json:"parts"`
			Grade bool `json:"grade"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		stub.mu.Lock()
		stub.grades = append(stub.grades, body.Grade)
		stub.mu.Unlock()
		if stub.unreadable.Load() {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"file_unreadable","message":"a.pdf can't be opened."}`))
			return
		}
		if stub.fail.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		parts := []map[string]any{}
		for _, p := range body.Parts {
			part := map[string]any{"id": p.ID, "pages": []int{1}}
			switch {
			case p.Type == "choice":
				part["answer"] = []string{"B"}
			case p.Type == "open" && body.Grade && stub.openFails.Load():
				part["error"] = "error"
			case p.Type == "open" && body.Grade:
				shares := make([]float64, len(p.Items))
				for i := range shares {
					shares[i] = 1
				}
				part["shares"] = shares
			}
			parts = append(parts, part)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"pageCount": 1, "parts": parts})
	}))
	t.Cleanup(pipe.Close)
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
	h := httpapi.New(st, blob.NewMemory(), pipeline.New(pipe.URL, "secret"), nil, "docling", httpapi.Config{
		E2EAuth: true, E2ESecret: "e2e-test-secret", E2EUserIDs: []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		ModelRegistry: reg,
	})
	return h, st, stub
}

// paperAssignment gives the seeded class's members a choice and an open
// question that they may answer on paper, marked as marking says.
func paperAssignment(t *testing.T, h http.Handler, marking string, timeLimit int) string {
	t.Helper()
	const ws = "/api/workspaces/ws_e2e_private"
	if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "class"}); rec.Code != http.StatusOK {
		t.Fatalf("set kind: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "personal"}) })
	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Paper %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []map[string]any{{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": "q1:part:1", "blocks": []map[string]any{{"type": "text", "text": "Pick"}},
				"answer": map[string]any{"type": "mcq", "options": []string{"a", "b"}, "correct": []int{1}}, "marks": 1, "solution": []any{},
			}},
		}, {
			"id": "q2", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": "q2:part:1", "blocks": []map[string]any{{"type": "text", "text": "Explain."}},
				"answer": map[string]any{"type": "open", "accepted": []string{}, "hints": []string{}}, "marks": 2,
				"markscheme": []map[string]any{{"text": "Point one", "marks": 2}}, "solution": []any{},
			}},
		}},
	})
	if quiz.Code != http.StatusCreated {
		t.Fatalf("create quiz: status = %d body=%s", quiz.Code, quiz.Body.String())
	}
	var made struct{ ID string }
	_ = json.Unmarshal(quiz.Body.Bytes(), &made)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_owner", nil) })
	body := map[string]any{
		"kind": "marked", "title": "On paper", "quizId": made.ID, "dueAt": time.Now().Add(time.Hour).Format(time.RFC3339),
		"attempts": 1, "noLate": false, "latePenaltyPct": 0, "assignAll": true, "assignees": []string{}, "draft": false,
		"marking": marking, "showAnswers": "submitted", "showGrades": "automatic", "shuffle": false, "files": []any{},
		"allowUploads": true,
	}
	if timeLimit > 0 {
		body["timeLimitMin"] = timeLimit
	}
	rec := doReq(t, h, http.MethodPost, ws+"/assignments", "u_owner", body)
	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("create assignment: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var assignment struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &assignment)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/assignments/"+assignment.ID, "u_owner", nil) })
	return assignment.ID
}

// startPaperWithFile starts u_viewer's paper and adds one page to it.
func startPaperWithFile(t *testing.T, h http.Handler, st *store.Store, id string) string {
	t.Helper()
	run := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/start", "u_viewer", map[string]any{"upload": true})
	if run.Code != http.StatusOK && run.Code != http.StatusCreated {
		t.Fatalf("start: status = %d body=%s", run.Code, run.Body.String())
	}
	var attempt struct{ ID string }
	_ = json.Unmarshal(run.Body.Bytes(), &attempt)
	ctx := context.Background()
	upload, err := st.CreateUploadSession(ctx, store.NewUploadSession{
		ID: fmt.Sprintf("up_%d", time.Now().UnixNano()), CreatedBy: "u_viewer", ObjectPath: "sources/paper-object",
		FinalPath: fmt.Sprintf("sources/paper-%d", time.Now().UnixNano()), Name: "paper.pdf", Kind: "pdf",
		ContentType: "application/pdf", DeclaredSize: 2048, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
		AttemptID: attempt.ID, PaperMaxBytes: 10 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinalizeUploadSession(ctx, "u_viewer", upload.ID, "etag", "", ""); err != nil {
		t.Fatal(err)
	}
	return attempt.ID
}

func waitForPaper(t *testing.T, st *store.Store, attemptID, want string) store.AssignmentAttempt {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got, err := st.GetAssignmentAttempt(context.Background(), "u_owner", attemptID, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if got.Paper == want {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("paper %s, want %s", got.Paper, want)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A paper whose read failed stays to read: its rows show Grade Error, and Mark
// with AI reads it, marking the choice part from the read and the open part
// on its page (finding 2).
func TestMarkWithAIReadsAPaperWhoseReadFailed(t *testing.T) {
	h, st, stub := openPaperAPI(t)
	stub.fail.Store(true)
	id := paperAssignment(t, h, "ai", 0)
	attemptID := startPaperWithFile(t, h, st, id)
	if rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attemptID+"/submit", "u_viewer",
		map[string]any{"answers": map[string]any{}}); rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if row := waitForAIError(t, h, id); row.AIError != "error" {
		t.Fatalf("row = %+v", row)
	}
	stub.fail.Store(false)
	rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/mark-with-ai", "u_owner", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("mark with AI: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct{ Total int }
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Total != 1 {
		t.Fatalf("total = %d, want the one paper", out.Total)
	}
	read := waitForPaper(t, st, attemptID, store.PaperRead)
	deadline := time.Now().Add(10 * time.Second)
	for read.Correct != 3 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		read = waitForPaper(t, st, attemptID, store.PaperRead)
	}
	if read.Correct != 3 || read.WaitingAnswers != 0 {
		t.Fatalf("marked %v, waiting %d", read.Correct, read.WaitingAnswers)
	}
}

// A paper the sweep submits when its time runs out starts its read, as a
// submit does (finding 2).
func TestSweptPaperIsRead(t *testing.T) {
	h, st, stub := openPaperAPI(t)
	id := paperAssignment(t, h, "ai", 1)
	attemptID := startPaperWithFile(t, h, st, id)
	if _, _, err := st.SweepAssignments(context.Background(), 200, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	waitForPaper(t, st, attemptID, store.PaperRead)
	if stub.calls.Load() == 0 {
		t.Fatal("no read call")
	}
}

// Under manual marking a paper is still read, on the member's credits: the
// read grades no open part, the choice part is marked from it, and the open
// part waits for staff on its page (Q716).
func TestManualMarkingReadsThePaperWithoutGrading(t *testing.T) {
	h, st, stub := openPaperAPI(t)
	id := paperAssignment(t, h, "manual", 0)
	attemptID := startPaperWithFile(t, h, st, id)
	if rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attemptID+"/submit", "u_viewer",
		map[string]any{"answers": map[string]any{}}); rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	read := waitForPaper(t, st, attemptID, store.PaperRead)
	if read.Correct != 1 || read.WaitingAnswers != 1 {
		t.Fatalf("marked %v, waiting %d", read.Correct, read.WaitingAnswers)
	}
	stub.mu.Lock()
	grades := append([]bool{}, stub.grades...)
	stub.mu.Unlock()
	if len(grades) != 1 || grades[0] {
		t.Fatalf("read calls grading = %v, want one read that grades nothing", grades)
	}
	var payer string
	if err := st.Pool().QueryRow(context.Background(), `SELECT actor_user_id FROM provider_sessions
		WHERE surface='quiz' AND workspace_id='ws_e2e_private' ORDER BY created_at DESC LIMIT 1`).Scan(&payer); err != nil {
		t.Fatal(err)
	}
	if payer != "u_viewer" {
		t.Fatalf("read paid by %s", payer)
	}
}

// A paper file the pipeline can't open leaves Can't read file on every part's
// row, which Mark with AI still retries (Q730).
func TestPaperFileThatCannotBeReadSaysSo(t *testing.T) {
	h, st, stub := openPaperAPI(t)
	stub.unreadable.Store(true)
	id := paperAssignment(t, h, "ai", 0)
	attemptID := startPaperWithFile(t, h, st, id)
	if rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attemptID+"/submit", "u_viewer",
		map[string]any{"answers": map[string]any{}}); rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	waitForAIError(t, h, id)
	rec := doReq(t, h, http.MethodGet, "/api/assignments/"+id+"/report", "u_owner", nil)
	var report struct{ Answers []answerRow }
	_ = json.Unmarshal(rec.Body.Bytes(), &report)
	if len(report.Answers) != 2 {
		t.Fatalf("rows = %+v", report.Answers)
	}
	for _, row := range report.Answers {
		if row.AIError != store.AIErrorFile {
			t.Fatalf("row = %+v, want Can't read file", row)
		}
	}
}

// Under manual marking a paper whose read failed counts in the report's
// papersToRead with no error on its rows, and Read papers again (mark-with-ai)
// reads it once more without grading, on the member's credits (Q725, Q730).
func TestReadPapersAgainUnderManualMarking(t *testing.T) {
	h, st, stub := openPaperAPI(t)
	stub.fail.Store(true)
	id := paperAssignment(t, h, "manual", 0)
	attemptID := startPaperWithFile(t, h, st, id)
	if rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attemptID+"/submit", "u_viewer",
		map[string]any{"answers": map[string]any{}}); rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	for stub.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if settledCalls(&stub.calls) != 1 {
		t.Fatal("no failed read")
	}
	report := func() (papersToRead int, rows []answerRow) {
		rec := doReq(t, h, http.MethodGet, "/api/assignments/"+id+"/report", "u_owner", nil)
		var got struct {
			PapersToRead int
			Answers      []answerRow
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		return got.PapersToRead, got.Answers
	}
	toRead, rows := report()
	if toRead != 1 || len(rows) == 0 {
		t.Fatalf("after the failed read: papersToRead %d, rows %+v", toRead, rows)
	}
	for _, row := range rows {
		if row.AIError != "" || !row.Waiting {
			t.Fatalf("row = %+v, want waiting with no error", row)
		}
	}
	stub.fail.Store(false)
	rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/mark-with-ai", "u_owner", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("read again: status = %d body=%s", rec.Code, rec.Body.String())
	}
	read := waitForPaper(t, st, attemptID, store.PaperRead)
	if read.Correct != 1 || read.WaitingAnswers != 1 {
		t.Fatalf("marked %v, waiting %d", read.Correct, read.WaitingAnswers)
	}
	if n, _ := report(); n != 0 {
		t.Fatalf("papersToRead after the read = %d", n)
	}
	stub.mu.Lock()
	grades := append([]bool{}, stub.grades...)
	stub.mu.Unlock()
	if len(grades) != 2 || grades[1] {
		t.Fatalf("read calls grading = %v, want a second read that grades nothing", grades)
	}
	var payer string
	if err := st.Pool().QueryRow(context.Background(), `SELECT actor_user_id FROM provider_sessions
		WHERE surface='quiz' AND workspace_id='ws_e2e_private' ORDER BY created_at DESC LIMIT 1`).Scan(&payer); err != nil {
		t.Fatal(err)
	}
	if payer != "u_viewer" {
		t.Fatalf("read paid by %s", payer)
	}
}

// Show grades Manual hides what waits from the member, and the submit still
// starts AI marking (finding 1).
func TestManualGradesStillMarkAtSubmit(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	id := markingAssignment(t, h)
	if _, err := st.Pool().Exec(context.Background(), `UPDATE assignments SET grades_shown='manual' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	startAndSubmit(t, h, id, map[string]any{"q1:part:1": "Because of reasons."})
	waitForAIMark(t, h, id)
}

// markingState is what the report and the member's attempt say is being
// marked (Q729).
type markingState struct {
	rows    map[string]bool // question id to its row's flag
	member  bool
	attempt bool
	parts   map[string]bool // part id to its flag in the attempt
}

func readMarking(t *testing.T, h http.Handler, id, attemptID string) markingState {
	t.Helper()
	var report struct {
		Answers []struct {
			QuestionID string
			Marking    bool
		}
		Members []struct{ Marking bool }
	}
	_ = json.Unmarshal(doReq(t, h, http.MethodGet, "/api/assignments/"+id+"/report", "u_owner", nil).Body.Bytes(), &report)
	var attempt struct {
		Marking   bool
		Questions []struct {
			Parts []struct {
				ID      string
				Marking bool
			}
		}
	}
	_ = json.Unmarshal(doReq(t, h, http.MethodGet, "/api/assignment-attempts/"+attemptID, "u_viewer", nil).Body.Bytes(), &attempt)
	out := markingState{rows: map[string]bool{}, attempt: attempt.Marking, parts: map[string]bool{}}
	for _, row := range report.Answers {
		out.rows[row.QuestionID] = out.rows[row.QuestionID] || row.Marking
	}
	for _, m := range report.Members {
		out.member = out.member || m.Marking
	}
	for _, q := range attempt.Questions {
		for _, p := range q.Parts {
			out.parts[p.ID] = p.Marking
		}
	}
	return out
}

// waitForMarking polls until done says the state has come.
func waitForMarking(t *testing.T, h http.Handler, id, attemptID string, done func(markingState) bool) markingState {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := readMarking(t, h, id, attemptID)
		if done(got) {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("marking state %+v", got)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A paper being read is marked whole: right after Submit its attempt says so,
// then every row of it, its member's row and every part, until the read ends,
// on failure as on success (Q729).
func TestAPaperReadIsMarkedWholeUntilItEnds(t *testing.T) {
	h, st, stub := openPaperAPI(t)
	id := paperAssignment(t, h, "ai", 0)
	attemptID := startPaperWithFile(t, h, st, id)
	release := stub.hold(t)
	stub.fail.Store(true)
	rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attemptID+"/submit", "u_viewer",
		map[string]any{"answers": map[string]any{}})
	if rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var submitted struct{ Marking bool }
	_ = json.Unmarshal(rec.Body.Bytes(), &submitted)
	if !submitted.Marking {
		t.Fatal("the submit's own reply doesn't say it is being marked")
	}
	whole := func(s markingState) bool {
		return s.attempt && s.member && s.rows["q1"] && s.rows["q2"] && s.parts["q1:part:1"] && s.parts["q2:part:1"]
	}
	cleared := func(s markingState) bool {
		return !s.attempt && !s.member && !s.rows["q1"] && !s.rows["q2"] && !s.parts["q1:part:1"] && !s.parts["q2:part:1"]
	}
	waitForMarking(t, h, id, attemptID, whole)
	release()
	waitForAIError(t, h, id)
	waitForMarking(t, h, id, attemptID, cleared)

	stub.fail.Store(false)
	release = stub.hold(t)
	if rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/mark-with-ai", "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("mark with AI: status = %d body=%s", rec.Code, rec.Body.String())
	}
	waitForMarking(t, h, id, attemptID, whole)
	release()
	waitForPaper(t, st, attemptID, store.PaperRead)
	waitForMarking(t, h, id, attemptID, cleared)
}

// Grading a read paper's open parts again holds exactly the parts sent: the
// choice part, marked by the read, is not being marked (Q729).
func TestARegradeMarksOnlyThePartsSent(t *testing.T) {
	h, st, stub := openPaperAPI(t)
	stub.openFails.Store(true)
	id := paperAssignment(t, h, "ai", 0)
	attemptID := startPaperWithFile(t, h, st, id)
	if rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attemptID+"/submit", "u_viewer",
		map[string]any{"answers": map[string]any{}}); rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	waitForPaper(t, st, attemptID, store.PaperRead)
	waitForAIError(t, h, id)
	stub.openFails.Store(false)
	release := stub.hold(t)
	if rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/mark-with-ai", "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("mark with AI: status = %d body=%s", rec.Code, rec.Body.String())
	}
	got := waitForMarking(t, h, id, attemptID, func(s markingState) bool { return s.parts["q2:part:1"] })
	if got.parts["q1:part:1"] || !got.rows["q2"] || !got.attempt || !got.member {
		t.Fatalf("while the open part is graded again: %+v", got)
	}
	release()
	waitForMarking(t, h, id, attemptID, func(s markingState) bool { return !s.attempt && !s.parts["q2:part:1"] })
}
