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
	Body assignmentReportBody
}

// assignmentReportBody is the report, and what the AI is marking right now.
type assignmentReportBody struct {
	store.AssignmentReport
	Marking *AssignmentMarkingProgress `json:"marking,omitempty"`
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
	reg(api, http.MethodPost, "/api/assignments/{id}/republish", "republishAssignment", tag, "Replace an open assignment's questions with its quiz as it is now", http.StatusOK, a.republishAssignment)
	reg(api, http.MethodPut, "/api/assignments/{id}/closed", "setAssignmentClosed", tag, "Close an assignment to late submissions, or reopen it", http.StatusOK, a.setAssignmentClosed)
	reg(api, http.MethodPost, "/api/assignments/{id}/release-grades", "releaseAssignmentGrades", tag, "Show members their grades on an assignment whose grades are released by hand", http.StatusOK, a.releaseAssignmentGrades)
	reg(api, http.MethodPut, "/api/assignments/{id}/done", "setAssignmentDone", tag, "A member's tick on an unmarked assignment", http.StatusNoContent, a.setAssignmentDone)
	reg(api, http.MethodPost, "/api/assignments/{id}/start", "startAssignment", tag, "Start an attempt, starting its clock, or return the one running", http.StatusOK, a.startAssignment)
	reg(api, http.MethodPost, "/api/assignments/{id}/mark-with-ai", "markAssignmentWithAI", tag, "Have the AI mark the answers still waiting, in the background", http.StatusOK, a.markAssignmentWithAI)
	reg(api, http.MethodPost, "/api/assignments/{id}/approve-ai-marks", "approveAssignmentAIMarks", tag, "Approve every AI mark on one question", http.StatusOK, a.approveAssignmentAIMarks)
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
		AssignAll: b.AssignAll, Assignees: b.Assignees, Draft: b.Draft, Marking: b.Marking,
		ShowAnswers: b.ShowAnswers, ShowGrades: b.ShowGrades, Shuffle: b.Shuffle, AllowUploads: b.AllowUploads, Files: b.Files,
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
	a.publishTodo(ctx, a.todoAudience(ctx, res.ID, false)...)
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
	// Those it was given to before the edit hear too, in case they were dropped.
	before := a.todoAudience(ctx, in.ID, false)
	res, err := a.s.UpdateAssignment(ctx, userID(ctx), in.ID, assignmentForm(in.Body), time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, append(before, a.todoAudience(ctx, in.ID, false)...)...)
	// A page taking it rereads: a moved or lifted No late due date moves its clock.
	a.publishAssignmentUpdated(ctx, in.ID)
	return &assignmentOutput{Body: res}, nil
}

func (a *api) deleteAssignment(ctx context.Context, in *assignmentIDInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	audience := a.todoAudience(ctx, in.ID, false)
	if err := a.s.DeleteAssignment(ctx, userID(ctx), in.ID); err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, audience...)
	return &Empty{}, nil
}

func (a *api) publishAssignment(ctx context.Context, in *assignmentIDInput) (*assignmentOutput, error) {
	return a.freezeAssignment(ctx, in.ID, a.s.PublishAssignment)
}

func (a *api) republishAssignment(ctx context.Context, in *assignmentIDInput) (*assignmentOutput, error) {
	out, err := a.freezeAssignment(ctx, in.ID, a.s.RepublishAssignment)
	if err == nil {
		a.publishAssignmentRepublished(ctx, in.ID)
	}
	return out, err
}

// freezeAssignment gives the store its quiz as it is now, to publish or republish.
func (a *api) freezeAssignment(ctx context.Context, id string, freeze func(context.Context, string, string, []map[string]any, time.Time) (store.Assignment, error)) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	// Who may publish is checked before the quiz is read, and again in the store.
	current, err := a.s.GetAssignment(ctx, userID(ctx), id, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	if current.Manage == nil {
		return nil, hErr(store.ErrNotFound)
	}
	quizID, err := a.s.AssignmentSourceQuiz(ctx, id)
	if err != nil {
		return nil, assignmentError(err)
	}
	var qs []map[string]any
	if quizID != "" {
		if qs, err = a.quizForFreezing(ctx, quizID); err != nil {
			return nil, err
		}
	}
	res, err := freeze(ctx, userID(ctx), id, qs, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, a.todoAudience(ctx, id, false)...)
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
	a.publishTodo(ctx, a.todoAudience(ctx, in.ID, false)...)
	return &assignmentOutput{Body: res}, nil
}

func (a *api) releaseAssignmentGrades(ctx context.Context, in *assignmentIDInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	res, sent, err := a.s.ReleaseAssignmentGrades(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	for i := range sent {
		a.publishNotificationEvent(ctx, sent[i].UserID, notificationEvent{Type: "created", Notification: &sent[i]})
	}
	return &assignmentOutput{Body: res}, nil
}

func (a *api) setAssignmentDone(ctx context.Context, in *assignmentDoneInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.s.SetAssignmentDone(ctx, userID(ctx), in.ID, in.Body.Done, time.Now()); err != nil {
		return nil, paperError(err)
	}
	// The member's other tabs and devices.
	a.publishTodo(ctx, userID(ctx))
	return &Empty{}, nil
}

type startAssignmentInput struct {
	ID   string `path:"id"`
	Body struct {
		// Upload starts an attempt answered on paper (Upload file, mock S4).
		Upload bool `json:"upload,omitempty"`
	}
}

func (a *api) startAssignment(ctx context.Context, in *startAssignmentInput) (*assignmentAttemptOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.StartAssignment(ctx, userID(ctx), in.ID, in.Body.Upload, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentAttemptOutput{Body: a.withMarking(res)}, nil
}

func (a *api) getAssignmentReport(ctx context.Context, in *assignmentIDInput) (*assignmentReportOutput, error) {
	res, err := a.s.GetAssignmentReport(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentReportOutput{Body: assignmentReportBody{AssignmentReport: a.reportMarking(res), Marking: a.marking.progress(in.ID)}}, nil
}

type markAssignmentWithAIOutput struct {
	Body struct {
		// Total counts the answers and the papers to read it runs over.
		Total int `json:"total"`
	}
}

// markAssignmentWithAI runs the AI over what still waits, as credits come back or
// after a failure (Epo 2026-11-03), each attempt on its member's credits. Staff only: reading the report checks that.
func (a *api) markAssignmentWithAI(ctx context.Context, in *assignmentIDInput) (*markAssignmentWithAIOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if _, err := a.s.GetAssignmentReport(ctx, userID(ctx), in.ID, time.Now()); err != nil {
		return nil, assignmentError(err)
	}
	_, answers, err := a.s.AnswersToMark(ctx, in.ID, "")
	if err != nil {
		return nil, assignmentError(err)
	}
	// A paper still to read (its read failed, waited out its ingest, or was
	// never started) is read first; its parts then join (finding 2).
	papers, err := a.s.PapersToRead(ctx, in.ID, "")
	if err != nil {
		return nil, assignmentError(err)
	}
	out := &markAssignmentWithAIOutput{}
	out.Body.Total = len(answers) + len(papers)
	if out.Body.Total == 0 {
		return out, nil
	}
	// Refused here while the page waits only when grading is not set up: each
	// member pays for their own, and one without credits shows No credits.
	if _, err := a.gradingLLM(ctx, userID(ctx)); err != nil {
		return nil, hErr(err)
	}
	// Held before the reply, so the report the page reads next shows them
	// being marked (Q729).
	var held []func()
	for _, answer := range answers {
		held = append(held, a.marking.hold(answer.AttemptID, false, answer.PartID))
	}
	for _, id := range papers {
		held = append(held, a.marking.hold(id, true))
	}
	a.markAnswersAfter(in.ID, "", func() {
		for _, release := range held {
			release()
		}
	})
	return out, nil
}

type approveAIMarksInput struct {
	ID   string `path:"id"`
	Body struct {
		QuestionID string `json:"questionId"`
	}
}

type approveAIMarksOutput struct {
	Body struct {
		Approved int `json:"approved"`
	}
}

func (a *api) approveAssignmentAIMarks(ctx context.Context, in *approveAIMarksInput) (*approveAIMarksOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	approved, err := a.s.ApproveAIMarks(ctx, userID(ctx), in.ID, in.Body.QuestionID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, a.todoAudience(ctx, in.ID, false)...)
	out := &approveAIMarksOutput{}
	out.Body.Approved = approved
	return out, nil
}

func (a *api) getAssignmentAttempt(ctx context.Context, in *assignmentIDInput) (*assignmentAttemptOutput, error) {
	res, err := a.s.GetAssignmentAttempt(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	return &assignmentAttemptOutput{Body: a.withMarking(res)}, nil
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
	// Only the submit that did it, read from the attempt as stored: the
	// member's view shows nothing waiting while grades wait for release.
	if res.NeedsMarking {
		a.markAnswersSoon(res.AssignmentID, res.ID)
	}
	// The class's staff, for answers to approve, and the member's other tabs.
	a.publishTodo(ctx, append(a.todoAudience(ctx, res.AssignmentID, true), userID(ctx))...)
	return &assignmentAttemptOutput{Body: a.withMarking(res)}, nil
}

func (a *api) markAssignmentAnswer(ctx context.Context, in *assignmentMarkInput) (*assignmentAttemptOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.MarkAssignmentAnswer(ctx, userID(ctx), in.ID, in.Body, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, append(a.todoAudience(ctx, res.AssignmentID, true), res.UserID)...)
	return &assignmentAttemptOutput{Body: a.withMarking(res)}, nil
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
