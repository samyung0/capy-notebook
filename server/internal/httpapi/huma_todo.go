package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type todoOutput struct {
	Body store.TodoList
}

type todoDoneInput struct {
	Dir    string `query:"dir" enum:"asc,desc" default:"desc"`
	Type   string `query:"type" doc:"Comma-separated: quiz, task"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}

type todoDoneOutput struct {
	Body store.TodoDonePage
}

type todoTaskInput struct {
	Body apimodel.AssignmentFormReq
}

type todoHideInput struct {
	Body struct {
		IDs []string `json:"ids" minItems:"1" maxItems:"200" doc:"Assignment ids to take off the caller's Done tab"`
	}
}

// todoDonePage is the Done tab's page size.
const todoDonePage = 30

func (a *api) registerTodo(api huma.API) {
	reg(api, http.MethodGet, "/api/todo", "getTodo", "Assignments", "The To do page: what each of the caller's classes holds for them", http.StatusOK, a.getTodo)
	reg(api, http.MethodPost, "/api/todo/tasks", "createTodoTask", "Assignments", "Set oneself a task that belongs to no workspace", http.StatusCreated, a.createTodoTask)
	reg(api, http.MethodPost, "/api/todo/done/hide", "hideTodoDone", "Assignments", "Take rows off the caller's Done tab, changing nothing else", http.StatusNoContent, a.hideTodoDone)
	reg(api, http.MethodGet, "/api/todo/done", "getTodoDone", "Assignments", "The To do page's Done tab: what was given to the caller that they finished or that closed, a page at a time", http.StatusOK, a.getTodoDone)
}

func (a *api) getTodo(ctx context.Context, _ *struct{}) (*todoOutput, error) {
	res, err := a.s.ListTodo(ctx, userID(ctx), time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &todoOutput{Body: res}, nil
}

// createTodoTask makes the caller a task with no workspace (Epo 2026-11-11),
// theirs alone; the store holds the form to a task for oneself.
func (a *api) createTodoTask(ctx context.Context, in *todoTaskInput) (*assignmentOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	form := assignmentForm(in.Body)
	if err := a.formQuiz(ctx, &form); err != nil {
		return nil, err
	}
	res, err := a.s.CreateAssignment(ctx, userID(ctx), "", form, time.Now())
	if err != nil {
		return nil, assignmentError(err)
	}
	a.publishTodo(ctx, userID(ctx))
	return &assignmentOutput{Body: res}, nil
}

func (a *api) getTodoDone(ctx context.Context, in *todoDoneInput) (*todoDoneOutput, error) {
	offset := 0
	if in.Cursor != "" {
		n, err := strconv.Atoi(in.Cursor)
		if err != nil || n < 0 {
			return nil, hErr(store.ErrInvalidCursor)
		}
		offset = n
	}
	var kinds []string
	for _, t := range commaValues(in.Type) {
		switch t {
		case "quiz":
			kinds = append(kinds, store.AssignmentMarked)
		case "task":
			kinds = append(kinds, store.AssignmentUnmarked)
		default:
			return nil, huma.Error422UnprocessableEntity("type is quiz or task")
		}
	}
	res, err := a.s.ListTodoDone(ctx, userID(ctx), time.Now(), store.TodoDoneParams{
		Ascending: in.Dir == "asc", Kinds: kinds,
		Offset: offset, Limit: todoDonePage,
	})
	if err != nil {
		return nil, hErr(err)
	}
	return &todoDoneOutput{Body: res}, nil
}

func (a *api) hideTodoDone(ctx context.Context, in *todoHideInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.s.HideTodoDone(ctx, userID(ctx), in.Body.IDs, time.Now()); err != nil {
		return nil, hErr(err)
	}
	// The caller's other tabs and devices.
	a.publishTodo(ctx, userID(ctx))
	return &Empty{}, nil
}
