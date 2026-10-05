package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// The chat agent's question-bank tools, for the retrieval service. It holds no
// bank credentials: it lists and reads the bank through these routes, and
// copy_questions copies questions into a quiz here, where each copy is
// credited from the bank's own sources.

const (
	internalBankPage = 50
	// maxBankCopy bounds one copy_questions call.
	maxBankCopy = 20
)

type internalBankListReq struct {
	UserID    string `json:"userId"`
	SubjectID string `json:"subjectId"`
	TopicID   string `json:"topicId"`
	Offset    int    `json:"offset"`
}

type internalBankReadReq struct {
	UserID     string `json:"userId"`
	QuestionID string `json:"questionId"`
}

type internalBankCopyReq struct {
	WorkspaceID        string   `json:"workspaceId"`
	UserID             string   `json:"userId"`
	AssistantMessageID string   `json:"assistantMessageId"`
	ToolCallID         string   `json:"toolCallId"`
	QuestionIDs        []string `json:"questionIds"`
	// Exactly one destination: Title (with an optional ChapterID) for a new
	// quiz, or QuizID for a quiz in the workspace.
	Title     string `json:"title"`
	ChapterID string `json:"chapterId"`
	QuizID    string `json:"quizId"`
}

// internalBankActor checks the pipeline secret, the actor and that a bank is
// configured. ok is false once a response has been written.
func (a *api) internalBankActor(w http.ResponseWriter, r *http.Request, userID string) bool {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return false
	}
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "userId is required"})
		return false
	}
	status, err := a.s.AccountAccess(r.Context(), userID)
	if err != nil {
		a.fail(w, err)
		return false
	}
	if !status.CanAuthenticate() {
		a.fail(w, status.Err())
		return false
	}
	if !a.cfg.Bank.Configured() {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "unavailable_target", "message": "The question bank is not configured."})
		return false
	}
	return true
}

func (a *api) failBank(w http.ResponseWriter, err error, missing string) {
	if errors.Is(err, bank.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "unavailable_target", "message": missing})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "unavailable_target", "message": "The question bank is unavailable."})
}

// internalBankList walks the syllabus: with nothing, every exam's subjects
// with question counts; with subjectId, its topics; with topicId, one page of
// its questions from offset.
func (a *api) internalBankList(w http.ResponseWriter, r *http.Request) {
	var req internalBankListReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.internalBankActor(w, r, req.UserID) {
		return
	}
	ctx := r.Context()
	if req.TopicID != "" {
		if req.Offset < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "offset must not be negative"})
			return
		}
		total, page, err := a.cfg.Bank.Page(ctx, req.TopicID, req.Offset, internalBankPage)
		if err != nil {
			a.failBank(w, err, "No bank topic "+req.TopicID+".")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"total": total, "questions": page})
		return
	}
	syllabus, err := a.cfg.Bank.Syllabus(ctx)
	if err != nil {
		a.failBank(w, err, "")
		return
	}
	type subject struct {
		Exam      string `json:"exam"`
		ExamLabel string `json:"examLabel"`
		ID        string `json:"id"`
		Label     string `json:"label"`
		Questions int    `json:"questions"`
	}
	type topic struct {
		ID        string `json:"id"`
		Label     string `json:"label"`
		Questions int    `json:"questions"`
	}
	subjects := []subject{}
	for _, e := range syllabus.Exams {
		for _, s := range e.Subjects {
			if s.ID == req.SubjectID {
				topics := []topic{}
				for _, t := range s.Topics {
					topics = append(topics, topic{ID: t.ID, Label: t.Label, Questions: t.Total})
				}
				writeJSON(w, http.StatusOK, map[string]any{"topics": topics})
				return
			}
			n := 0
			for _, t := range s.Topics {
				n += t.Total
			}
			subjects = append(subjects, subject{Exam: e.ID, ExamLabel: e.Label, ID: s.ID, Label: s.Label, Questions: n})
		}
	}
	if req.SubjectID != "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "unavailable_target", "message": "No bank subject " + req.SubjectID + "."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"subjects": subjects})
}

// internalBankRead returns one question in full, with its sources and labels.
func (a *api) internalBankRead(w http.ResponseWriter, r *http.Request) {
	var req internalBankReadReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.internalBankActor(w, r, req.UserID) {
		return
	}
	detail, err := a.cfg.Bank.Get(r.Context(), req.QuestionID)
	if err != nil {
		a.failBank(w, err, "No bank question "+req.QuestionID+".")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": req.QuestionID, "question": detail.Question, "sources": detail.Sources,
		"exam": detail.ExamLabel, "subject": detail.SubjectLabel, "topic": detail.TopicLabel,
	})
}

// internalBankCopy copies bank questions, unchanged, into a new quiz or one in
// the workspace, through the same writes the chat's create and edit tools use.
// Each question's credit is resolved here from the bank's sources and kept in
// the quiz's provenance under the question's id.
func (a *api) internalBankCopy(w http.ResponseWriter, r *http.Request) {
	var req internalBankCopyReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.internalBankActor(w, r, req.UserID) {
		return
	}
	invalid := func(message string) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": message})
	}
	ids := slices.Compact(slices.Sorted(slices.Values(req.QuestionIDs)))
	switch {
	case len(req.QuestionIDs) == 0 || len(req.QuestionIDs) > maxBankCopy:
		invalid("copy one to 20 questions at a time")
		return
	case len(ids) != len(req.QuestionIDs):
		invalid("question ids repeat")
		return
	case (strings.TrimSpace(req.Title) == "") == (req.QuizID == ""):
		invalid("give exactly one destination: title for a new quiz, or quiz_id")
		return
	case req.ChapterID != "" && req.QuizID != "":
		invalid("chapter_id files a new quiz; it goes with title")
		return
	}
	ctx := r.Context()
	details, err := a.cfg.Bank.GetMany(ctx, req.QuestionIDs)
	if err != nil {
		a.failBank(w, err, "A question id is not in the bank; list_question_bank shows them.")
		return
	}
	copied := make([]map[string]any, 0, len(details))
	credits := map[string]store.QuestionCredit{}
	for _, d := range details {
		copied = append(copied, d.Question)
		sources, err := a.cfg.Bank.Provenance(ctx, d.Sources)
		if err != nil {
			a.failBank(w, err, "")
			return
		}
		if sources != nil {
			id, _ := d.Question["id"].(string)
			credits[id] = store.QuestionCredit{Books: sources.Books, Web: sources.Web}
		}
	}
	var provenance *store.Provenance
	if len(credits) > 0 {
		provenance = &store.Provenance{Books: []store.ProvenanceBook{}, Questions: credits}
	}

	if req.QuizID == "" {
		raw, err := json.Marshal(copied)
		if err != nil {
			a.fail(w, err)
			return
		}
		a.createAgentMaterial(w, r, internalMaterialReq{
			WorkspaceID: req.WorkspaceID, UserID: req.UserID, AssistantMessageID: req.AssistantMessageID,
			ToolCallID: req.ToolCallID, Kind: "quiz", Title: req.Title, ChapterID: req.ChapterID,
			Questions: raw, Provenance: provenance,
		})
		return
	}
	quiz, err := a.s.GetMaterial(ctx, req.QuizID)
	if err != nil || quiz.Kind != "quiz" || quiz.WorkspaceID != req.WorkspaceID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "unavailable_target", "message": "quiz_id is not a quiz in this workspace"})
		return
	}
	existing, _, err := materialdoc.ExtractQuiz(quiz.Content)
	if err != nil {
		a.fail(w, err)
		return
	}
	var present []map[string]any
	if err := json.Unmarshal(existing, &present); err != nil {
		a.fail(w, err)
		return
	}
	// Appended in order after the quiz's last question.
	var after *string
	if n := len(present); n > 0 {
		if id, ok := present[n-1]["id"].(string); ok {
			after = &id
		}
	}
	commands := make([]json.RawMessage, 0, len(copied))
	for _, q := range copied {
		command, err := json.Marshal(map[string]any{"type": "add_question", "question": q, "after_question_id": after})
		if err != nil {
			a.fail(w, err)
			return
		}
		commands = append(commands, command)
		if id, ok := q["id"].(string); ok {
			after = &id
		}
	}
	a.editAgentDocument(w, r, internalDocumentsEditReq{
		WorkspaceID: req.WorkspaceID, UserID: req.UserID, AssistantMessageID: req.AssistantMessageID,
		ToolCallID: req.ToolCallID, Target: agenttools.ResourceRef{Kind: agenttools.KindMaterial, ID: req.QuizID},
		Commands: commands, Provenance: provenance,
	})
}
