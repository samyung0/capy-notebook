package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/copytext"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type quizOutput struct {
	Body apimodel.Quiz
}
type quizIDInput struct {
	ID string `path:"id"`
}
type quizDeleteInput struct {
	ID        string `path:"id"`
	RequestID string `query:"requestId" maxLength:"64" doc:"Optional idempotency key for this trash action"`
}
type createQuizInput struct {
	Body apimodel.CreateQuizReq
}
type updateQuizContentInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateQuizContentReq
}
type updateQuizMetadataInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateQuizMetadataReq
}
type updateQuizSharingInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateStandaloneSharingReq
}
type createAttemptInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateAttemptReq
}
type attemptsInput struct {
	Sort        string `query:"sort" enum:"date,score" default:"date"`
	Dir         string `query:"dir" enum:"asc,desc" default:"desc"`
	WorkspaceID string `query:"workspaceId" doc:"Comma-separated workspace ids; the quiz's current workspace"`
	Offset      int    `query:"offset" minimum:"0"`
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"30"`
}
type attemptsOutput struct {
	Body struct {
		Items []apimodel.Attempt `json:"items" nullable:"false"`
		More  bool               `json:"more"`
	}
}
type attemptIDInput struct {
	ID string `path:"id"`
}
type attemptDetailOutput struct {
	Body apimodel.AttemptDetail
}

func (a *api) registerQuizzes(api huma.API) {
	const tag = "Quizzes"
	regWithMaxBody(api, http.MethodPost, "/api/quizzes", "createQuiz", tag, "Create a quiz", http.StatusCreated, materialRequestMaxBytes, a.createQuiz)
	reg(api, http.MethodGet, "/api/quizzes/{id}", "getQuiz", tag, "Get a quiz to view or take, without answers", http.StatusOK, a.getQuiz)
	reg(api, http.MethodGet, "/api/quizzes/{id}/edit", "getQuizForEdit", tag, "Get a quiz with its answers to edit it", http.StatusOK, a.getQuizForEdit)
	regWithMaxBody(api, http.MethodPatch, "/api/quizzes/{id}/content", "updateQuizContent", tag, "Update quiz content", http.StatusOK, materialRequestMaxBytes, a.updateQuizContent)
	reg(api, http.MethodPatch, "/api/quizzes/{id}/metadata", "updateQuizMetadata", tag, "Update quiz metadata", http.StatusOK, a.updateQuizMetadata)
	reg(api, http.MethodPatch, "/api/quizzes/{id}/sharing", "updateQuizSharing", tag, "Update standalone quiz sharing", http.StatusOK, a.updateQuizSharing)
	reg(api, http.MethodDelete, "/api/quizzes/{id}", "deleteQuiz", tag, "Delete a quiz", http.StatusNoContent, a.deleteQuiz)
	regWithMaxBody(api, http.MethodPost, "/api/quizzes/{id}/attempts", "createAttempt", tag, "Grade and record a quiz attempt", http.StatusCreated, answersMaxBytes, a.createAttempt)
	reg(api, http.MethodGet, "/api/attempts", "listAttempts", tag, "List attempts", http.StatusOK, a.listAttempts)
	reg(api, http.MethodGet, "/api/attempts/{id}", "getAttempt", tag, "Get an attempt's result breakdown", http.StatusOK, a.getAttempt)
	a.registerComputationCheck(api)
}

// getQuiz is the read for viewing and studying: owners, editors and
// link/public visitors alike get answer-free questions (questions.LearnerView).
func (a *api) getQuiz(ctx context.Context, in *quizIDInput) (*quizOutput, error) {
	if _, err := a.materialRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetQuiz(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	out, err := a.quizOutputWithAccess(ctx, in.ID, res)
	if err != nil {
		return nil, err
	}
	out.Body.Questions = questions.LearnerViews(out.Body.Questions)
	author, err := a.s.MaterialAuthorOf(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	out.Body.Author = &author
	return out, nil
}

// getQuizForEdit returns the questions with their keys to whoever may edit
// them, the same check as a content edit.
func (a *api) getQuizForEdit(ctx context.Context, in *quizIDInput) (*quizOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetQuiz(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.quizOutputWithAccess(ctx, in.ID, res)
}

func (a *api) createQuiz(ctx context.Context, in *createQuizInput) (*quizOutput, error) {
	b := in.Body
	name := string(b.Name)
	if name == "" {
		name = copytext.T(a.userLocale(ctx, userID(ctx)), copytext.UntitledQuiz)
	}
	privacy := b.Privacy
	if privacy == "" || b.WorkspaceID != "" {
		privacy = "private"
	}
	wsID, wsName := b.WorkspaceID, ""
	if wsID != "" {
		if err := a.assertWorkspaceEditor(ctx, wsID); err != nil {
			return nil, hErr(err)
		}
		ws, err := a.s.GetWorkspaceShared(ctx, wsID)
		if err != nil {
			return nil, hErr(err)
		}
		wsName = ws.Name
	}
	res, err := a.s.CreateQuiz(ctx, store.Quiz{
		UserID: userID(ctx), Name: name, WorkspaceID: wsID, WorkspaceName: wsName, Chapters: b.Chapters,
		Questions: apimodel.EncodeQuestions(b.Questions), Privacy: privacy, TimeLimitMin: nil,
	})
	if err != nil {
		return nil, hErr(err)
	}
	res.CanEdit, res.CanEditContent = true, true
	return &quizOutput{Body: apimodel.FromQuiz(res)}, nil
}

func (a *api) updateQuizContent(ctx context.Context, in *updateQuizContentInput) (*quizOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	p := store.QuizContentPatch{
		ExpectedRevision: in.Body.ExpectedRevision,
		TimeLimitMin:     nil, UpdatedBy: userID(ctx),
	}
	if in.Body.Questions != nil {
		raw := apimodel.EncodeQuestions(*in.Body.Questions)
		p.Questions = &raw
	}
	res, err := a.s.UpdateQuizContent(ctx, in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return a.quizOutputWithAccess(ctx, in.ID, res)
}

func (a *api) updateQuizMetadata(ctx context.Context, in *updateQuizMetadataInput) (*quizOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.UpdateQuizMetadata(ctx, in.ID, store.QuizMetadataPatch{
		Name: apimodel.Str(in.Body.Name), Chapters: in.Body.Chapters, UpdatedBy: userID(ctx),
	})
	if err != nil {
		return nil, hErr(err)
	}
	return a.quizOutputWithAccess(ctx, in.ID, res)
}

// Narrowing is a recovery action a frozen account keeps; the store refuses
// widening.
func (a *api) updateQuizSharing(ctx context.Context, in *updateQuizSharingInput) (*quizOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	material, err := a.s.UpdateStandaloneMaterialPrivacy(
		ctx, userID(ctx), in.ID, "quiz", in.Body.Privacy,
	)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetQuiz(ctx, material.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.quizOutputWithAccess(ctx, in.ID, res)
}

func (a *api) quizOutputWithAccess(ctx context.Context, id string, res store.Quiz) (*quizOutput, error) {
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), id)
	if err != nil {
		return nil, hErr(err)
	}
	res.IsOwner = role == store.RoleOwner
	if res.CanEdit, res.CanEditContent, err = a.canEditMaterial(ctx, id, role); err != nil {
		return nil, hErr(err)
	}
	return &quizOutput{Body: apimodel.FromQuiz(res)}, nil
}

// deleteQuiz moves the quiz material into the trash.
func (a *api) deleteQuiz(ctx context.Context, in *quizDeleteInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	op, err := trashOperation(ctx, in.RequestID, agenttools.KindMaterial, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if _, err := a.s.TrashMaterial(ctx, userID(ctx), in.ID, "quiz", op); err != nil {
		return nil, trashError(err)
	}
	return &Empty{}, nil
}

func (a *api) listAttempts(ctx context.Context, in *attemptsInput) (*attemptsOutput, error) {
	list, more, err := a.s.ListAttempts(ctx, userID(ctx), store.AttemptParams{
		Sort: in.Sort, Ascending: in.Dir == "asc", Workspaces: commaValues(in.WorkspaceID),
		Offset: in.Offset, Limit: in.Limit,
	})
	if err != nil {
		return nil, hErr(err)
	}
	out := &attemptsOutput{}
	out.Body.Items, out.Body.More = list, more
	return out, nil
}

// createAttempt grades every part of a submitted attempt on the server, stores
// the graded questions, rates review and marks progress, and returns the
// result with the keys. Retakes are unlimited.
func (a *api) createAttempt(ctx context.Context, in *createAttemptInput) (*attemptDetailOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	// The quiz must be readable (owner/member or link/public).
	if _, err := a.materialRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	quiz, err := a.s.GetQuiz(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	qs, err := decodeStoredQuestions(quiz.Questions)
	if err != nil {
		return nil, hErr(err)
	}
	plan, err := planGrading(qs, in.Body.Answers)
	if err != nil {
		return nil, gradeRequestError(err)
	}
	graded, correct, total, err := a.gradeSignedIn(ctx, plan, quiz.WorkspaceID, map[string]any{"quizId": quiz.ID})
	if err != nil {
		return nil, err
	}
	res, err := a.s.CreateAttempt(ctx, userID(ctx), in.ID, correct, total,
		apimodel.EncodeRaw(in.Body.Answers), apimodel.EncodeQuestions(graded))
	if err != nil {
		return nil, hErr(err)
	}
	return &attemptDetailOutput{Body: apimodel.AttemptDetail{Attempt: res, Answers: in.Body.Answers, Questions: graded}}, nil
}

func (a *api) getAttempt(ctx context.Context, in *attemptIDInput) (*attemptDetailOutput, error) {
	res, err := a.s.GetAttempt(ctx, in.ID, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &attemptDetailOutput{Body: apimodel.FromAttemptDetail(res)}, nil
}
