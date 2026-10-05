package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/review"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Question-bank progress: signed-in learners record checked answers on /bank,
// which keeps each one's latest result, and copy questions into their quizzes.
// Read access to the bank is enough to record, and frozen accounts record, as
// in workspace review.

type bankAnswerInput struct {
	ID   string `path:"id"`
	Body struct {
		Score float64 `json:"score" minimum:"0" maximum:"1" doc:"The answer's awarded marks over the question's marks"`
	}
}
type bankRevealInput struct {
	ID   string `path:"id"`
	Body struct {
		Answers map[string]any `json:"answers" doc:"The learner's answers by part id, given before the key is shown"`
	}
}
type bankRevealOutput struct {
	Body struct {
		Question map[string]any `json:"question" doc:"The whole question: answer key, marking scheme and worked solution"`
	}
}
type bankMarksOutput struct {
	Body struct {
		Marks map[string]float64 `json:"marks" nullable:"false" doc:"Answered current questions by id: the latest answer's score, 0 to 1"`
	}
}
type bankProgressOutput struct {
	Body struct {
		Topics []bank.TopicProgress `json:"topics" nullable:"false" doc:"Topics with at least one answered current question, the most recently answered first"`
	}
}
type bankCopyInput struct {
	Body struct {
		QuestionIDs []string               `json:"questionIds" nullable:"false" minItems:"1" maxItems:"20" uniqueItems:"true" doc:"Bank questions to copy, in this order"`
		WorkspaceID string                 `json:"workspaceId" minLength:"1"`
		ChapterID   string                 `json:"chapterId,omitempty" doc:"Where a new quiz is filed; goes with quizName"`
		QuizID      string                 `json:"quizId,omitempty" doc:"An existing quiz in the workspace to append to; exclusive with quizName"`
		QuizName    apimodel.MaterialTitle `json:"quizName,omitempty" doc:"Name of a new quiz; exclusive with quizId"`
	}
}
type bankCopyOutput struct {
	Body struct {
		WorkspaceID string `json:"workspaceId"`
		QuizID      string `json:"quizId"`
	}
}

func (a *api) registerBankProgress(api huma.API) {
	tag := "Question bank"
	reg(api, http.MethodPost, "/api/bank/questions/{id}/reveal", "revealBankQuestion", tag, "Show one question's answer key once its answers are checked", http.StatusOK, a.bankReveal)
	reg(api, http.MethodPost, "/api/bank/questions/{id}/answers", "answerBankQuestion", tag, "Record a checked answer", http.StatusNoContent, a.bankAnswer)
	reg(api, http.MethodGet, "/api/bank/topics/{topicId}/marks", "bankTopicMarks", tag, "Latest scores for a topic's questions", http.StatusOK, a.bankMarks)
	reg(api, http.MethodGet, "/api/bank/progress", "bankProgress", tag, "Topics the learner has answered questions in", http.StatusOK, a.bankProgress)
	reg(api, http.MethodPost, "/api/bank/copy", "copyBankQuestions", tag, "Copy bank questions into a workspace quiz", http.StatusOK, a.bankCopy)
}

// bankReveal returns one question in full when the learner checks their
// answers; browsing stays answer-free (questions.LearnerView). The browser
// scores the answers against it and records the score through bankAnswer.
func (a *api) bankReveal(ctx context.Context, in *bankRevealInput) (*bankRevealOutput, error) {
	if _, err := a.bankAccess(ctx, false); err != nil {
		return nil, err
	}
	q, err := a.cfg.Bank.Get(ctx, in.ID)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	out := &bankRevealOutput{}
	out.Body.Question = q.Question
	return out, nil
}

func (a *api) bankAnswer(ctx context.Context, in *bankAnswerInput) (*Empty, error) {
	if _, err := a.bankAccess(ctx, false); err != nil {
		return nil, err
	}
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	q, err := a.cfg.Bank.Get(ctx, in.ID)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	err = a.s.RecordBankAnswer(ctx, userID(ctx), in.ID, q.TopicID, review.QuestionHash(q.Question), in.Body.Score, time.Now())
	return &Empty{}, hErr(err)
}

func (a *api) bankMarks(ctx context.Context, in *bankTopicInput) (*bankMarksOutput, error) {
	if _, err := a.bankAccess(ctx, false); err != nil {
		return nil, err
	}
	hashes, err := a.cfg.Bank.TopicHashes(ctx, in.TopicID)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	out := &bankMarksOutput{}
	out.Body.Marks, err = a.s.BankMarks(ctx, userID(ctx), in.TopicID, hashes)
	return out, hErr(err)
}

func (a *api) bankProgress(ctx context.Context, _ *struct{}) (*bankProgressOutput, error) {
	if _, err := a.bankAccess(ctx, false); err != nil {
		return nil, err
	}
	results, err := a.s.BankResults(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	out := &bankProgressOutput{}
	out.Body.Topics, err = a.cfg.Bank.Progress(ctx, results)
	return out, bankHTTPError(err)
}

// bankCopy copies bank questions, unchanged and credited like the chat's
// copy_questions, into a new quiz or the end of one in a workspace the
// learner edits.
func (a *api) bankCopy(ctx context.Context, in *bankCopyInput) (*bankCopyOutput, error) {
	if _, err := a.bankAccess(ctx, false); err != nil {
		return nil, err
	}
	b := in.Body
	name := strings.TrimSpace(string(b.QuizName))
	switch {
	case (name == "") == (b.QuizID == ""):
		return nil, huma.Error422UnprocessableEntity("give exactly one of quizId or quizName")
	case b.ChapterID != "" && b.QuizID != "":
		return nil, huma.Error422UnprocessableEntity("chapterId files a new quiz; it goes with quizName")
	}
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.assertWorkspaceEditor(ctx, b.WorkspaceID); err != nil {
		return nil, hErr(err)
	}
	copied, provenance, err := a.bankCopies(ctx, b.QuestionIDs)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	out := &bankCopyOutput{}
	out.Body.WorkspaceID = b.WorkspaceID
	if b.QuizID == "" {
		out.Body.QuizID, err = a.bankCopyToNewQuiz(ctx, b.WorkspaceID, b.ChapterID, name, copied, provenance)
	} else {
		out.Body.QuizID, err = b.QuizID, a.bankCopyIntoQuiz(ctx, b.WorkspaceID, b.QuizID, copied, provenance)
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (a *api) bankCopyToNewQuiz(ctx context.Context, workspaceID, chapterID, name string, copied []map[string]any, provenance *store.Provenance) (string, error) {
	ws, err := a.s.GetWorkspaceShared(ctx, workspaceID)
	if err != nil {
		return "", hErr(err)
	}
	var chapter *string
	if chapterID != "" {
		ok, err := a.s.ChapterInWorkspace(ctx, chapterID, workspaceID)
		if err != nil {
			return "", hErr(err)
		}
		if !ok {
			return "", huma.Error422UnprocessableEntity("chapterId is not a chapter of this workspace")
		}
		chapter = &chapterID
	}
	raw, err := json.Marshal(copied)
	if err != nil {
		return "", hErr(err)
	}
	mt, err := a.s.CreateMaterialDraft(ctx, store.MaterialDraft{
		ActorUserID: userID(ctx), WorkspaceID: workspaceID, WorkspaceName: ws.Name, Kind: "quiz",
		Title: name, Questions: raw, ChapterID: chapter, Provenance: provenance,
	})
	if errors.Is(err, materialdoc.ErrInvalid) {
		return "", huma.Error422UnprocessableEntity(err.Error())
	}
	return mt.ID, hErr(err)
}

// bankCopyIntoQuiz appends through the document authority, which writes the
// questions and the merged credits together, as the chat's edits do.
func (a *api) bankCopyIntoQuiz(ctx context.Context, workspaceID, quizID string, copied []map[string]any, provenance *store.Provenance) error {
	quiz, err := a.s.GetMaterial(ctx, quizID)
	if err != nil || quiz.Kind != "quiz" || quiz.WorkspaceID != workspaceID {
		return huma.Error404NotFound("quizId is not a quiz in this workspace")
	}
	// The learner's and the quiz owner's accounts, as for any content edit.
	if err := a.editErr(ctx, quiz.OwnerUserID); err != nil {
		return hErr(err)
	}
	if err := a.s.StorageFullErr(ctx, quiz.OwnerUserID); err != nil {
		return hErr(err)
	}
	commands, err := bankAppendCommands(quiz.Content, copied)
	if err != nil {
		return hErr(err)
	}
	normalized, err := normalizeMaterialCommands("quiz", commands, nil)
	if err != nil {
		return documentHTTPError(err)
	}
	if provenance != nil {
		var code string
		if provenance, code, err = mergeProvenance(quiz.Provenance, provenance); err != nil {
			return conflictError(code, err.Error())
		}
	}
	hash, err := store.RequestHash(map[string]any{"target": quizID, "commands": normalized, "provenance": provenance})
	if err != nil {
		return hErr(err)
	}
	_, err = a.s.EditDocument(ctx, userID(ctx), store.DocumentTarget{Kind: agenttools.KindMaterial, ID: quizID}, normalized, provenance,
		store.DocumentOperation{ID: "bank_copy_" + rand.Text(), RequestHash: hash, ToolVersion: 1})
	return documentHTTPError(err)
}

// documentHTTPError maps the document authority's answers for browser routes.
func documentHTTPError(err error) error {
	var refusal *store.EditRefusal
	switch {
	case err == nil:
		return nil
	case errors.As(err, &refusal):
		return conflictError(string(refusal.Code), refusal.Message)
	case errors.Is(err, store.ErrAuthorityUnavailable):
		return huma.Error503ServiceUnavailable("the document authority is unavailable")
	}
	return hErr(err)
}
