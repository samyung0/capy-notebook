package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
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

type assignmentTodoCheckInput struct {
	ID   string `path:"id"`
	Body struct {
		Checked bool `json:"checked"`
		// Approvals: staff's tick on the answers waiting, not their own work.
		Approvals bool `json:"approvals,omitempty"`
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
type assignmentGradeInput struct {
	ID     string `path:"id"`
	UserID string `path:"userId"`
	Body   struct {
		// Points is the grade; absent clears it.
		Points *apimodel.AssignmentGrade `json:"points,omitempty"`
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
	reg(api, http.MethodGet, "/api/workspaces/{id}/assignments", "listAssignments", tag, "A class's assignments, a page at a time: all of them for its owner and teaching assistants, a member's own otherwise", http.StatusOK, a.listAssignments)
	reg(api, http.MethodPost, "/api/workspaces/{id}/assignments", "createAssignment", tag, "Give a class an unmarked assignment, or set oneself a task; a graded quiz is made with its questions", http.StatusCreated, a.createAssignment)
	reg(api, http.MethodPost, "/api/quizzes/{id}/graded-copy", "copyQuizToGradedQuiz", tag, "Make a graded quiz from a copy of a practice quiz in the same workspace, images and all", http.StatusCreated, a.copyQuizToGradedQuiz)
	reg(api, http.MethodPost, "/api/files/{id}/graded-quiz", "makeFileGradedQuiz", tag, "Make a graded quiz whose question paper is a file of the workspace, answered by upload and marked by hand", http.StatusCreated, a.makeFileGradedQuiz)
	reg(api, http.MethodGet, "/api/assignments/{id}", "getAssignment", tag, "An assignment", http.StatusOK, a.getAssignment)
	reg(api, http.MethodPut, "/api/assignments/{id}", "updateAssignment", tag, "Change an assignment's settings", http.StatusOK, a.updateAssignment)
	reg(api, http.MethodDelete, "/api/assignments/{id}", "deleteAssignment", tag, "Delete an assignment with its results", http.StatusNoContent, a.deleteAssignment)
	reg(api, http.MethodPost, "/api/assignments/{id}/publish", "publishAssignment", tag, "Give a draft to its members", http.StatusOK, a.publishAssignment)
	reg(api, http.MethodPut, "/api/assignments/{id}/paper-file", "changeAssignmentPaperFile", tag, "Point a graded quiz from a file at another file of its workspace, keeping answers and marks", http.StatusOK, a.changeAssignmentPaperFile)
	reg(api, http.MethodPost, "/api/assignments/{id}/republish", "republishAssignment", tag, "Replace an open assignment's questions with its quiz as it is now", http.StatusOK, a.republishAssignment)
	reg(api, http.MethodPut, "/api/assignments/{id}/closed", "setAssignmentClosed", tag, "Close an assignment to late submissions, or reopen it", http.StatusOK, a.setAssignmentClosed)
	reg(api, http.MethodPost, "/api/assignments/{id}/release-grades", "releaseAssignmentGrades", tag, "Show members their grades on an assignment whose grades are released by hand", http.StatusOK, a.releaseAssignmentGrades)
	reg(api, http.MethodPut, "/api/assignments/{id}/done", "setAssignmentDone", tag, "A member's tick on an unmarked assignment", http.StatusNoContent, a.setAssignmentDone)
	reg(api, http.MethodPut, "/api/assignments/{id}/todo-check", "setAssignmentTodoCheck", tag, "Tick an assignment, or the answers waiting on it, off the caller's To do without doing it", http.StatusNoContent, a.setAssignmentTodoCheck)
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
	reg(api, http.MethodPut, "/api/assignments/{id}/grades/{userId}", "setAssignmentGrade", tag, "Set or clear a member's grade on an assignment graded on points", http.StatusNoContent, a.setAssignmentGrade)
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
	case errors.Is(err, store.ErrPaperTotalBelowMark):
		return conflictError("total_below_mark", err.Error())
	}
	return hErr(err)
}

// assignmentPage is Study → Assignments' and a member's To do's page size.
const assignmentPage = 50

type assignmentListInput struct {
	ID     string `path:"id"`
	Closed bool   `query:"closed" doc:"Keep the closed ones"`
	Done   bool   `query:"done" doc:"Keep the ones the caller has done"`
	Topic  string `query:"topic" doc:"Comma-separated topic ids: only those on one of them"`
	Kind   string `query:"kind" enum:"marked,unmarked" doc:"Only graded quizzes (marked) or only assignments (unmarked); none keeps both"`
	Sort   string `query:"sort" enum:"title,kind,topic,posted,due" doc:"A column to order by, open ones still first; none is the page's own order"`
	Dir    string `query:"dir" enum:"asc,desc" default:"asc"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}

func (a *api) listAssignments(ctx context.Context, in *assignmentListInput) (*assignmentListOutput, error) {
	offset := 0
	if in.Cursor != "" {
		n, err := strconv.Atoi(in.Cursor)
		if err != nil || n < 0 {
			return nil, hErr(store.ErrInvalidCursor)
		}
		offset = n
	}
	res, err := a.s.ListAssignments(ctx, userID(ctx), in.ID, time.Now(), store.AssignmentListParams{
		Closed: in.Closed, Done: in.Done, TopicIDs: commaValues(in.Topic), Kind: in.Kind,
		Sort: in.Sort, Ascending: in.Dir == "asc", Offset: offset, Limit: assignmentPage,
	})
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
		ShowAnswers: b.ShowAnswers, ShowGrades: b.ShowGrades, Shuffle: b.Shuffle, AllowUploads: b.AllowUploads, UploadOnly: b.UploadOnly, Files: b.Files,
		Points: (*int)(b.Points), TotalMarks: (*int)(b.TotalMarks),
	}
}

// gradedQuizForm is a question maker's graded quiz (Epo 2026-11-16): the
// New graded quiz dialog's settings, made with the quiz. Nil: none.
func gradedQuizForm(b *apimodel.AssignmentFormReq) *store.AssignmentForm {
	if b == nil {
		return nil
	}
	form := assignmentForm(*b)
	return &form
}

// gradedQuizMade tells a new graded quiz's members and staff (createAssignment).
func (a *api) gradedQuizMade(ctx context.Context, assignmentID string) {
	if assignmentID != "" {
		a.publishTodo(ctx, a.todoAudience(ctx, assignmentID, false)...)
	}
}

func (a *api) createAssignment(ctx context.Context, in *createAssignmentInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	// Any member: a class's staff make an assignment, anyone else a task for
	// themself (the store holds it to that).
	role, err := a.s.WorkspaceRole(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if role == "" {
		return nil, hErr(store.ErrNotFound)
	}
	res, err := a.s.CreateAssignment(ctx, userID(ctx), in.ID, assignmentForm(in.Body), time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, a.todoAudience(ctx, res.ID, false)...)
	return &assignmentOutput{Body: res}, nil
}

type copyQuizToGradedQuizInput struct {
	ID   string `path:"id" maxLength:"64" doc:"The quiz to copy: a practice quiz, or another graded quiz's own"`
	Body apimodel.CopyQuizToGradedQuizReq
}

// copyQuizToGradedQuiz makes a graded quiz from a copy of a quiz of the
// workspace the caller edits (Epo 2026-11-16): a practice quiz, hidden or not,
// or another graded quiz's own, last term's reused. The copy is the source as
// it is now, live edits projected.
func (a *api) copyQuizToGradedQuiz(ctx context.Context, in *copyQuizToGradedQuizInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	source, err := a.s.GetMaterial(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	// A practice quiz of a workspace: a graded quiz's own quiz is an assignment
	// already, not one to start another from (Epo 2026-11-16).
	if source.Kind != store.MaterialQuiz || source.WorkspaceID == "" || source.AssignmentID != "" {
		return nil, hErr(store.ErrNotFound)
	}
	if err := a.assertWorkspaceEditor(ctx, source.WorkspaceID); err != nil {
		return nil, hErr(err)
	}
	ws, err := a.s.GetWorkspaceShared(ctx, source.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	qs, err := a.quizForFreezing(ctx, source.ID)
	if err != nil {
		return nil, err
	}
	// Its own quiz is never listed, so its name stands as given.
	form := assignmentForm(in.Body.GradedQuiz)
	res, err := a.s.CopyQuizToGradedQuiz(ctx, store.QuizCopy{
		ActorID: userID(ctx), WorkspaceID: ws.ID, WorkspaceName: ws.Name,
		SourceID: source.ID, Questions: qs, Title: form.Title, Form: form,
	}, time.Now())
	if errors.Is(err, materialdoc.ErrInvalid) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err != nil {
		return nil, bankError(err)
	}
	a.gradedQuizMade(ctx, res.ID)
	return &assignmentOutput{Body: res}, nil
}

type makeFileGradedQuizInput struct {
	ID   string `path:"id" maxLength:"64" doc:"The file: its question paper"`
	Body apimodel.FileGradedQuizReq
}

// makeFileGradedQuiz makes a graded quiz from a file of a workspace the caller
// edits (Epo 2026-11-20). The file stays where it is and is read live.
func (a *api) makeFileGradedQuiz(ctx context.Context, in *makeFileGradedQuizInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	file, err := a.s.GetFile(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if file.WorkspaceID == "" {
		return nil, hErr(store.ErrNotFound)
	}
	if err := a.assertWorkspaceEditor(ctx, file.WorkspaceID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.MakeFileGradedQuiz(ctx, userID(ctx), file.WorkspaceID, file.ID, assignmentForm(in.Body.GradedQuiz), time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.gradedQuizMade(ctx, res.ID)
	return &assignmentOutput{Body: res}, nil
}

type changePaperFileInput struct {
	ID   string `path:"id" maxLength:"64"`
	Body apimodel.PaperFileReq
}

// changeAssignmentPaperFile is its staff's Change file (Epo 2026-11-20); open
// pages reread, so a running attempt shows the new file.
func (a *api) changeAssignmentPaperFile(ctx context.Context, in *changePaperFileInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.ChangePaperFile(ctx, userID(ctx), in.ID, in.Body.FileID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.publishAssignmentUpdated(ctx, in.ID)
	return &assignmentOutput{Body: res}, nil
}

func (a *api) getAssignment(ctx context.Context, in *assignmentIDInput) (*assignmentOutput, error) {
	res, err := a.s.GetAssignment(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	// Its files are the ones the caller may open, so their cards may show.
	for i := range res.Files {
		if res.Files[i].ThumbnailURL, err = a.thumbnailURL(ctx, res.Files[i].ThumbnailKey); err != nil {
			return nil, err
		}
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
	// A task's maker who can no longer open its quiz has none to freeze.
	if quizID != "" && current.Own {
		if _, err := a.materialRead(ctx, quizID); errors.Is(err, store.ErrNotFound) {
			quizID = ""
		} else if err != nil {
			return nil, hErr(err)
		}
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

func (a *api) setAssignmentTodoCheck(ctx context.Context, in *assignmentTodoCheckInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.s.SetAssignmentTodoCheck(ctx, userID(ctx), in.ID, in.Body.Approvals, in.Body.Checked, time.Now()); err != nil {
		return nil, assignmentError(err)
	}
	// The caller's other tabs and devices.
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

// setAssignmentGrade is staff entering a member's grade on a graded Assignment
// (Epo 2026-11-14); the member's To do and staff's lists refresh.
func (a *api) setAssignmentGrade(ctx context.Context, in *assignmentGradeInput) (*Empty, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.s.SetAssignmentGrade(ctx, userID(ctx), in.ID, in.UserID, (*float64)(in.Body.Points), time.Now()); err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, append(a.todoAudience(ctx, in.ID, true), in.UserID)...)
	return &Empty{}, nil
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
