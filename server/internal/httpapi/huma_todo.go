package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

type todoOutput struct {
	Body store.TodoList
}

type todoDoneInput struct {
	Sort   string `query:"sort" enum:"done,class" default:"done" doc:"done: the day it was done, or closed if it never was; class: by class name, then done"`
	Dir    string `query:"dir" enum:"asc,desc" default:"desc"`
	Class  string `query:"class" doc:"Comma-separated class workspace ids"`
	Type   string `query:"type" doc:"Comma-separated: quiz, task"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}

type todoDoneOutput struct {
	Body store.TodoDonePage
}

// todoDonePage is the Done tab's page size.
const todoDonePage = 30

func (a *api) registerTodo(api huma.API) {
	reg(api, http.MethodGet, "/api/todo", "getTodo", "Assignments", "The To do page: what each of the caller's classes holds for them", http.StatusOK, a.getTodo)
	reg(api, http.MethodGet, "/api/todo/done", "getTodoDone", "Assignments", "The To do page's Done tab: what was given to the caller that they finished or that closed, a page at a time", http.StatusOK, a.getTodoDone)
}

func (a *api) getTodo(ctx context.Context, _ *struct{}) (*todoOutput, error) {
	res, err := a.s.ListTodo(ctx, userID(ctx), time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &todoOutput{Body: res}, nil
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
		Sort: in.Sort, Ascending: in.Dir == "asc", Classes: commaValues(in.Class), Kinds: kinds,
		Offset: offset, Limit: todoDonePage,
	})
	if err != nil {
		return nil, hErr(err)
	}
	return &todoDoneOutput{Body: res}, nil
}
