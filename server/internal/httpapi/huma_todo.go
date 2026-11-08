package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

type todoOutput struct {
	Body store.TodoList
}

func (a *api) registerTodo(api huma.API) {
	reg(api, http.MethodGet, "/api/todo", "getTodo", "Assignments", "The To do page: what each of the caller's classes holds for them", http.StatusOK, a.getTodo)
}

type todoInput struct {
	Done bool `query:"done" doc:"The Done tab instead: what was given to the caller that they finished or that closed"`
}

func (a *api) getTodo(ctx context.Context, in *todoInput) (*todoOutput, error) {
	res, err := a.s.ListTodo(ctx, userID(ctx), time.Now(), in.Done)
	if err != nil {
		return nil, hErr(err)
	}
	return &todoOutput{Body: res}, nil
}
