package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Assignments (openwiki/study-progress.md#assignments): the store keeps who may
// do what. A class's owner and editor members make them, read every result and
// change marks; whoever one went to takes it and reads their own result. A
// frozen account's own answers and ticks are study data and go through, as its
// ratings do; making or marking an assignment is editing and does not. No route
// here calls a model: an open answer waits for the owner.

type assignmentListOutput struct {
	Body store.AssignmentList
}
type assignmentOutput struct {
	Body store.Assignment
}
type assignmentIDInput struct {
	ID string `path:"id"`
}
type createAssignmentInput struct {
	ID   string `path:"id"`
	Body apimodel.AssignmentFormReq
}
type updateAssignmentInput struct {
	ID   string `path:"id"`
	Body apimodel.AssignmentFormReq
}
type assignmentClosedInput struct {
	ID   string `path:"id"`
	Body struct {
		Closed bool `json:"closed"`
	}
}
type assignmentDoneInput struct {
	ID   string `path:"id"`
	Body struct {
		Done bool `json:"done"`
	}
}
type assignmentReportOutput struct {
	Body store.AssignmentReport
}
type assignmentAttemptOutput struct {
	Body store.AssignmentAttempt
}
type assignmentAnswersInput struct {
	ID   string `path:"id"`
	Body struct {
		Answers map[string]any `json:"answers"`
	}
}
type assignmentMarkInput struct {
	ID   string `path:"id"`
	Body store.AssignmentMark
}
type sharingNoticeOutput struct {
	Body store.SharingNotice
}

func (a *api) registerAssignments(api huma.API) {
	const tag = "Assignments"
	reg(api, http.MethodGet, "/api/workspaces/{id}/assignments", "listAssignments", tag, "A class's assignments: all of them for its owner and teaching assistants, a member's own otherwise", http.StatusOK, a.listAssignments)
	reg(api, http.MethodPost, "/api/workspaces/{id}/assignments", "createAssignment", tag, "Give a class an assignment, freezing its quiz", http.StatusCreated, a.createAssignment)
	reg(api, http.MethodGet, "/api/assignments/{id}", "getAssignment", tag, "An assignment", http.StatusOK, a.getAssignment)
	reg(api, http.MethodPut, "/api/assignments/{id}", "updateAssignment", tag, "Change an assignment's settings", http.StatusOK, a.updateAssignment)
	reg(api, http.MethodDelete, "/api/assignments/{id}", "deleteAssignment", tag, "Delete an assignment with its results", http.StatusNoContent, a.deleteAssignment)
	reg(api, http.MethodPost, "/api/assignments/{id}/publish", "publishAssignment", tag, "Give a draft to its members", http.StatusOK, a.publishAssignment)
	reg(api, http.MethodPut, "/api/assignments/{id}/closed", "setAssignmentClosed", tag, "Close an assignment to late submissions, or reopen it", http.StatusOK, a.setAssignmentClosed)
	reg(api, http.MethodPut, "/api/assignments/{id}/done", "setAssignmentDone", tag, "A member's tick on an unmarked assignment", http.StatusNoContent, a.setAssignmentDone)
	reg(api, http.MethodPost, "/api/assignments/{id}/start", "startAssignment", tag, "Start an attempt, starting its clock, or return the one running", http.StatusOK, a.startAssignment)
	reg(api, http.MethodGet, "/api/assignments/{id}/report", "getAssignmentReport", tag, "An assignment's report: its questions, members and answers to mark", http.StatusOK, a.getAssignmentReport)
	reg(api, http.MethodGet, "/api/assignment-attempts/{id}", "getAssignmentAttempt", tag, "An attempt: running, or its results", http.StatusOK, a.getAssignmentAttempt)
	regWithMaxBody(api, http.MethodPut, "/api/assignment-attempts/{id}/answers", "saveAssignmentAnswers", tag, "Save a running attempt's answers", http.StatusNoContent, answersMaxBytes, a.saveAssignmentAnswers)
	regWithMaxBody(api, http.MethodPost, "/api/assignment-attempts/{id}/submit", "submitAssignmentAttempt", tag, "Submit a running attempt: closed parts marked, open parts left for the owner", http.StatusOK, answersMaxBytes, a.submitAssignmentAttempt)
	reg(api, http.MethodGet, "/api/workspaces/{id}/sharing-notice", "getSharingNotice", tag, "Whether a class member is yet to be told what they share", http.StatusOK, a.getSharingNotice)
	reg(api, http.MethodPut, "/api/workspaces/{id}/sharing-notice", "markSharingNoticeSeen", tag, "Record that a class member was told what they share", http.StatusNoContent, a.markSharingNoticeSeen)
	reg(api, http.MethodPost, "/api/assignment-attempts/{id}/marks", "markAssignmentAnswer", tag, "Set or change a question's marks and comment in a member's answers", http.StatusOK, a.markAssignmentAnswer)
}

// assignmentError answers a refused assignment with copy the browser shows.
func assignmentError(err error) error {
	var input *store.AssignmentInputError
	switch {
	case errors.As(err, &input):
		return huma.Error422UnprocessableEntity(input.Detail)
	case errors.Is(err, store.ErrAssignmentClosed):
		return conflictError("assignment_closed", err.Error())
	case errors.Is(err, store.ErrAssignmentNoAttempts):
		return conflictError("assignment_no_attempts", err.Error())
	case errors.Is(err, store.ErrAttemptFinished):
		return conflictError("attempt_finished", err.Error())
	case errors.Is(err, store.ErrAssignmentQuizGone):
		return conflictError("assignment_quiz_gone", err.Error())
	}
	return hErr(err)
}

func (a *api) listAssignments(ctx context.Context, in *workspaceIDInput) (*assignmentListOutput, error) {
	res, err := a.s.ListAssignments(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentListOutput{Body: res}, nil
}

// quizForFreezing reads a quiz's current questions, live edits projected first.
func (a *api) quizForFreezing(ctx context.Context, quizID string) ([]map[string]any, error) {
	a.projectLive(ctx, quizID)
	quiz, err := a.s.GetQuiz(ctx, quizID)
	if err != nil {
		return nil, storedContentError(ctx, quizID, err)
	}
	qs, err := decodeStoredQuestions(quiz.Questions)
	if err != nil {
		return nil, hErr(err)
	}
	return qs, nil
}

func assignmentForm(b apimodel.AssignmentFormReq) store.AssignmentForm {
	return store.AssignmentForm{
		Kind: b.Kind, Title: b.Title, QuizID: b.QuizID, DueAt: b.DueAt, TimeLimitMin: b.TimeLimitMin, Attempts: b.Attempts,
		NoLate: b.NoLate, LatePenaltyPct: b.LatePenaltyPct,
		AssignAll: b.AssignAll, Assignees: b.Assignees, Draft: b.Draft, ApproveAIMarks: b.ApproveAIMarks,
		ShowAnswers: b.ShowAnswers, Shuffle: b.Shuffle, Files: b.Files,
	}
}

func (a *api) createAssignment(ctx context.Context, in *createAssignmentInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.s.AssertWorkspaceMemberEditor(ctx, userID(ctx), in.ID); err != nil {
		if errors.Is(err, store.ErrForbidden) {
			err = store.ErrNotFound
		}
		return nil, hErr(err)
	}
	form := assignmentForm(in.Body)
	if form.Kind == store.AssignmentMarked {
		if form.QuizID == "" {
			return nil, huma.Error422UnprocessableEntity("choose a quiz")
		}
		if !form.Draft {
			qs, err := a.quizForFreezing(ctx, form.QuizID)
			if err != nil {
				return nil, err
			}
			form.Questions = qs
		}
	}
	res, err := a.s.CreateAssignment(ctx, userID(ctx), in.ID, form, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentOutput{Body: res}, nil
}

func (a *api) getAssignment(ctx context.Context, in *assignmentIDInput) (*assignmentOutput, error) {
	res, err := a.s.GetAssignment(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentOutput{Body: res}, nil
}

func (a *api) updateAssignment(ctx context.Context, in *updateAssignmentInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.UpdateAssignment(ctx, userID(ctx), in.ID, assignmentForm(in.Body), time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentOutput{Body: res}, nil
}

func (a *api) deleteAssignment(ctx context.Context, in *assignmentIDInput) (*Empty, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	return &Empty{}, assignmentError(a.s.DeleteAssignment(ctx, userID(ctx), in.ID))
}

func (a *api) publishAssignment(ctx context.Context, in *assignmentIDInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	// Who may publish is checked before the quiz is read, and again in the store.
	current, err := a.s.GetAssignment(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	if current.Manage == nil {
		return nil, hErr(store.ErrNotFound)
	}
	quizID, err := a.s.AssignmentSourceQuiz(ctx, in.ID)
	if err != nil {
		return nil, assignmentError(err)
	}
	var qs []map[string]any
	if quizID != "" {
		if qs, err = a.quizForFreezing(ctx, quizID); err != nil {
			return nil, err
		}
	}
	res, err := a.s.PublishAssignment(ctx, userID(ctx), in.ID, qs, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentOutput{Body: res}, nil
}

func (a *api) setAssignmentClosed(ctx context.Context, in *assignmentClosedInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.SetAssignmentClosed(ctx, userID(ctx), in.ID, in.Body.Closed, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	if in.Body.Closed {
		a.publishAssignmentClosed(ctx, in.ID)
	}
	return &assignmentOutput{Body: res}, nil
}

func (a *api) setAssignmentDone(ctx context.Context, in *assignmentDoneInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	return &Empty{}, assignmentError(a.s.SetAssignmentDone(ctx, userID(ctx), in.ID, in.Body.Done, time.Now()))
}

func (a *api) startAssignment(ctx context.Context, in *assignmentIDInput) (*assignmentAttemptOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.StartAssignment(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentAttemptOutput{Body: res}, nil
}

func (a *api) getAssignmentReport(ctx context.Context, in *assignmentIDInput) (*assignmentReportOutput, error) {
	res, err := a.s.GetAssignmentReport(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentReportOutput{Body: res}, nil
}

func (a *api) getAssignmentAttempt(ctx context.Context, in *assignmentIDInput) (*assignmentAttemptOutput, error) {
	res, err := a.s.GetAssignmentAttempt(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentAttemptOutput{Body: res}, nil
}

func (a *api) saveAssignmentAnswers(ctx context.Context, in *assignmentAnswersInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	return &Empty{}, assignmentError(a.s.SaveAssignmentAnswers(ctx, userID(ctx), in.ID, in.Body.Answers, time.Now()))
}

func (a *api) submitAssignmentAttempt(ctx context.Context, in *assignmentAnswersInput) (*assignmentAttemptOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.SubmitAssignmentAttempt(ctx, userID(ctx), in.ID, in.Body.Answers, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentAttemptOutput{Body: res}, nil
}

func (a *api) markAssignmentAnswer(ctx context.Context, in *assignmentMarkInput) (*assignmentAttemptOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.MarkAssignmentAnswer(ctx, userID(ctx), in.ID, in.Body, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentAttemptOutput{Body: res}, nil
}

// getSharingNotice reads the caller's own flag, so it needs no access check.
func (a *api) getSharingNotice(ctx context.Context, in *assignmentIDInput) (*sharingNoticeOutput, error) {
	notice, err := a.s.SharingNoticeFor(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &sharingNoticeOutput{Body: notice}, nil
}

func (a *api) markSharingNoticeSeen(ctx context.Context, in *assignmentIDInput) (*Empty, error) {
	if err := a.s.MarkSharingNoticeSeen(ctx, userID(ctx), in.ID, time.Now()); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
