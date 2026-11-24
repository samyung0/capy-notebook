package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Item banks (Epo 2026-11-14, todo-graded-quizzes.md): the caller's own bank
// (`me`) and a class workspace's (its id), which only its owner and editor
// members reach; anyone else is answered not found. Every route names the
// bank the same way, so a picker lists /api/item-banks and then reads one.

type itemBanksInput struct {
	WorkspaceID string `query:"workspaceId" maxLength:"64" doc:"The workspace the caller is in: its class bank comes first when they are its staff"`
}

type itemBanksOutput struct {
	Body struct {
		Items []store.ItemBank `json:"items" nullable:"false"`
	}
}

type itemBankListInput struct {
	Bank   string `path:"bank" maxLength:"64" doc:"me, or a class workspace's id"`
	Q      string `query:"q" maxLength:"200" doc:"Words the question's text or answers hold"`
	Tags   string `query:"tags" maxLength:"2000" doc:"Comma-separated: questions holding any of these tags"`
	Topics string `query:"topics" maxLength:"2000" doc:"Comma-separated topic ids: a class bank's questions with any of these as a topic of their own"`
	Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}

type itemBankListOutput struct {
	Body store.ItemBankPage
}

type itemBankTagsInput struct {
	Bank string `path:"bank" maxLength:"64" doc:"me, or a class workspace's id"`
}

type itemBankTagsOutput struct {
	Body struct {
		Tags []string `json:"tags" nullable:"false"`
	}
}

// ItemBankQuestionReq is a bank question's content and tags. Images it names
// that the caller may read are copied into the bank. Each of its `topicIds`
// counts in a class's bank while the workspace holds that topic; it reads as
// left out otherwise.
type ItemBankQuestionReq struct {
	Question map[string]any `json:"question" doc:"A question in the shared question format, as a quiz holds it"`
	// maxItems is fieldlimits.BankQuestionTags.
	Tags []apimodel.TagValue `json:"tags" maxItems:"10" nullable:"false" doc:"Free-text tags, without commas"`
}

type createItemBankQuestionInput struct {
	Bank string `path:"bank" maxLength:"64" doc:"me, or a class workspace's id"`
	Body ItemBankQuestionReq
}

type updateItemBankQuestionInput struct {
	Bank string `path:"bank" maxLength:"64" doc:"me, or a class workspace's id"`
	ID   string `path:"id" maxLength:"64"`
	Body ItemBankQuestionReq
}

type deleteItemBankQuestionInput struct {
	Bank string `path:"bank" maxLength:"64" doc:"me, or a class workspace's id"`
	ID   string `path:"id" maxLength:"64"`
}

type itemBankQuestionOutput struct {
	Body store.ItemBankQuestion
}

// BankQuizReq makes a quiz from picked bank questions (Add quiz's From the
// bank).
type BankQuizReq struct {
	WorkspaceID string `json:"workspaceId" minLength:"1" maxLength:"64" doc:"The workspace the quiz is made in; the caller edits it"`
	// maxItems is fieldlimits.QuizParts: every question holds a part.
	QuestionIDs []string                    `json:"questionIds" nullable:"false" minItems:"1" maxItems:"150" uniqueItems:"true" doc:"Bank questions to copy, in this order"`
	Title       apimodel.MaterialTitle      `json:"title" minLength:"1"`
	GradedQuiz  *apimodel.AssignmentFormReq `json:"gradedQuiz,omitempty" doc:"The New graded quiz dialog's settings (CreateMaterialReq.gradedQuiz): the quiz is made with the graded quiz that owns it (assignmentId)"`
}

type createBankQuizInput struct {
	Bank string `path:"bank" maxLength:"64" doc:"me, or a class workspace's id"`
	Body BankQuizReq
}

// BankQuestionsCopyReq copies picked bank questions for a quiz's editor
// (the editor's From the bank).
type BankQuestionsCopyReq struct {
	Bank string `json:"bank" minLength:"1" maxLength:"64" doc:"me, or a class workspace's id"`
	// maxItems is fieldlimits.QuizParts: every question holds a part.
	QuestionIDs []string `json:"questionIds" nullable:"false" minItems:"1" maxItems:"150" uniqueItems:"true" doc:"Bank questions to copy, in this order"`
}

type copyBankQuestionsInput struct {
	ID   string `path:"id" maxLength:"64" doc:"The quiz the copies are for"`
	Body BankQuestionsCopyReq
}

type copyBankQuestionsOutput struct {
	Body struct {
		Questions []map[string]any `json:"questions" nullable:"false" doc:"The copies in the shared question format, in the order asked, for the editor to insert through the quiz's live rooms"`
	}
}

func (a *api) registerItemBanks(api huma.API) {
	const tag = "Item banks"
	reg(api, http.MethodGet, "/api/item-banks", "listItemBanks", tag,
		"Every bank the caller reaches: the class they are in first when they are its staff, then their own, then every other class they own or edit, A–Z", http.StatusOK, a.listItemBanks)
	reg(api, http.MethodGet, "/api/item-banks/{bank}/questions", "listItemBankQuestions", tag,
		"A bank's questions, newest first, a page at a time, with the filtered count", http.StatusOK, a.listItemBankQuestions)
	reg(api, http.MethodGet, "/api/item-banks/{bank}/tags", "listItemBankTags", tag,
		"Every tag a bank's questions hold", http.StatusOK, a.listItemBankTags)
	regWithMaxBody(api, http.MethodPost, "/api/item-banks/{bank}/questions", "createItemBankQuestion", tag,
		"Copy a question into a bank", http.StatusCreated, materialRequestMaxBytes, a.createItemBankQuestion)
	regWithMaxBody(api, http.MethodPut, "/api/item-banks/{bank}/questions/{id}", "updateItemBankQuestion", tag,
		"Replace a bank question and its tags", http.StatusOK, materialRequestMaxBytes, a.updateItemBankQuestion)
	reg(api, http.MethodDelete, "/api/item-banks/{bank}/questions/{id}", "deleteItemBankQuestion", tag,
		"Delete a bank question", http.StatusNoContent, a.deleteItemBankQuestion)
	reg(api, http.MethodPost, "/api/item-banks/{bank}/quizzes", "createBankQuiz", tag,
		"Copy picked bank questions, images and all, into a new quiz in a workspace the caller edits", http.StatusCreated, a.createBankQuiz)
	reg(api, http.MethodPost, "/api/quizzes/{id}/bank-questions", "copyBankQuestionsToQuiz", tag,
		"Copy picked bank questions, images and all, for a quiz the caller edits; the editor inserts the copies itself", http.StatusOK, a.copyBankQuestionsToQuiz)
}

func (a *api) listItemBanks(ctx context.Context, in *itemBanksInput) (*itemBanksOutput, error) {
	banks, err := a.s.ItemBanks(ctx, userID(ctx), in.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	out := &itemBanksOutput{}
	out.Body.Items = banks
	return out, nil
}

func (a *api) listItemBankQuestions(ctx context.Context, in *itemBankListInput) (*itemBankListOutput, error) {
	page, err := a.s.ListItemBankQuestions(ctx, userID(ctx), in.Bank, store.ItemBankFilter{
		Query: in.Q, Tags: commaValues(in.Tags), Topics: commaValues(in.Topics), Limit: in.Limit, Cursor: in.Cursor,
	})
	if err != nil {
		return nil, hErr(err)
	}
	return &itemBankListOutput{Body: page}, nil
}

func (a *api) listItemBankTags(ctx context.Context, in *itemBankTagsInput) (*itemBankTagsOutput, error) {
	tags, err := a.s.ItemBankTags(ctx, userID(ctx), in.Bank)
	if err != nil {
		return nil, hErr(err)
	}
	out := &itemBankTagsOutput{}
	out.Body.Tags = tags
	return out, nil
}

func (a *api) createItemBankQuestion(ctx context.Context, in *createItemBankQuestionInput) (*itemBankQuestionOutput, error) {
	tags, err := checkBankQuestion(in.Body)
	if err != nil {
		return nil, err
	}
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	item, err := a.s.CreateItemBankQuestion(ctx, userID(ctx), in.Bank, in.Body.Question, tags)
	if err != nil {
		return nil, bankError(err)
	}
	return &itemBankQuestionOutput{Body: item}, nil
}

func (a *api) updateItemBankQuestion(ctx context.Context, in *updateItemBankQuestionInput) (*itemBankQuestionOutput, error) {
	tags, err := checkBankQuestion(in.Body)
	if err != nil {
		return nil, err
	}
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	item, err := a.s.UpdateItemBankQuestion(ctx, userID(ctx), in.Bank, in.ID, in.Body.Question, tags)
	if err != nil {
		return nil, bankError(err)
	}
	return &itemBankQuestionOutput{Body: item}, nil
}

func (a *api) deleteItemBankQuestion(ctx context.Context, in *deleteItemBankQuestionInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.s.DeleteItemBankQuestion(ctx, userID(ctx), in.Bank, in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) createBankQuiz(ctx context.Context, in *createBankQuizInput) (*materialOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.assertWorkspaceEditor(ctx, in.Body.WorkspaceID); err != nil {
		return nil, hErr(err)
	}
	ws, err := a.s.GetWorkspaceShared(ctx, in.Body.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.CreateQuizFromBank(ctx, store.BankQuiz{
		ActorID: userID(ctx), Bank: in.Bank, WorkspaceID: ws.ID, WorkspaceName: ws.Name,
		QuestionIDs: in.Body.QuestionIDs, Title: string(in.Body.Title), GradedQuiz: gradedQuizForm(in.Body.GradedQuiz),
		// Hidden from members until shown (Epo 2026-11-16, every quiz an
		// editor makes).
		Hidden: true,
	})
	if errors.Is(err, materialdoc.ErrInvalid) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err != nil {
		return nil, bankError(err)
	}
	a.gradedQuizMade(ctx, res.AssignmentID)
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), res.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.materialResponse(ctx, res, role, false, false)
}

func (a *api) copyBankQuestionsToQuiz(ctx context.Context, in *copyBankQuestionsInput) (*copyBankQuestionsOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	// The quiz editor's own check (getQuizForEdit).
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	copies, err := a.s.CopyBankQuestionsToQuiz(ctx, userID(ctx), in.ID, in.Body.Bank, in.Body.QuestionIDs)
	if errors.Is(err, materialdoc.ErrInvalid) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err != nil {
		return nil, bankError(err)
	}
	out := &copyBankQuestionsOutput{}
	out.Body.Questions = copies
	return out, nil
}

// checkBankQuestion validates the question as a quiz holds it and returns its
// tags trimmed, without blanks or repeats (case-insensitive, first spelling
// kept). A comma would split the Tags filter, so a tag holds none.
func checkBankQuestion(req ItemBankQuestionReq) ([]string, error) {
	if err := questions.Validate(req.Question, questions.Policy{}); err != nil {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, raw := range req.Tags {
		tag := strings.TrimSpace(string(raw))
		if strings.Contains(tag, ",") {
			return nil, huma.Error422UnprocessableEntity("a tag holds no comma")
		}
		if key := strings.ToLower(tag); tag != "" && !seen[key] {
			seen[key] = true
			tags = append(tags, tag)
		}
	}
	if len(tags) > fieldlimits.BankQuestionTags {
		return nil, huma.Error422UnprocessableEntity("too many tags")
	}
	return tags, nil
}

func bankError(err error) error {
	switch {
	case errors.Is(err, store.ErrTooManyBankQuestions):
		return conflictError("bank_question_limit", err.Error())
	case errors.Is(err, store.ErrBankQuestionAssets):
		return huma.Error422UnprocessableEntity(err.Error())
	}
	return assignmentError(err)
}
