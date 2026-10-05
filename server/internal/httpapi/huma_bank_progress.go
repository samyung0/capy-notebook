package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// Question-bank progress: signed-in learners record checked answers on /bank
// and review their mistakes per topic. Read access to the bank is enough, and
// frozen accounts record, as in workspace review.

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
		Marks map[string]bool `json:"marks" nullable:"false" doc:"Answered current questions by id: true when the last answer earned full marks"`
	}
}
type bankReviewOutput struct {
	Body struct {
		QuestionIDs []string `json:"questionIds" nullable:"false" doc:"Up to 20 questions missed at least once, least retained first; read them through bankQuestionBatch"`
	}
}

func (a *api) registerBankProgress(api huma.API) {
	tag := "Question bank"
	reg(api, http.MethodPost, "/api/bank/questions/{id}/reveal", "revealBankQuestion", tag, "Show one question's answer key once its answers are checked", http.StatusOK, a.bankReveal)
	reg(api, http.MethodPost, "/api/bank/questions/{id}/answers", "answerBankQuestion", tag, "Record a checked answer", http.StatusNoContent, a.bankAnswer)
	reg(api, http.MethodGet, "/api/bank/topics/{topicId}/marks", "bankTopicMarks", tag, "Right and wrong marks for a topic's questions", http.StatusOK, a.bankMarks)
	reg(api, http.MethodGet, "/api/bank/topics/{topicId}/review", "bankTopicReview", tag, "Next mistake review batch for a topic", http.StatusOK, a.bankReviewBatch)
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

func (a *api) bankReviewBatch(ctx context.Context, in *bankTopicInput) (*bankReviewOutput, error) {
	if _, err := a.bankAccess(ctx, false); err != nil {
		return nil, err
	}
	hashes, err := a.cfg.Bank.TopicHashes(ctx, in.TopicID)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	out := &bankReviewOutput{}
	out.Body.QuestionIDs, err = a.s.BankReview(ctx, userID(ctx), in.TopicID, hashes, time.Now())
	return out, hErr(err)
}
