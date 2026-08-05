package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

type eventsOutput struct {
	Body []apimodel.Event
}
type eventOutput struct {
	Body apimodel.Event
}
type eventIDInput struct {
	ID string `path:"id"`
}
type createEventInput struct {
	Body apimodel.CreateEventReq
}
type updateEventInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateEventReq
}
type labelsOutput struct {
	Body []apimodel.Label
}
type tasksOutput struct {
	Body []apimodel.Task
}
type taskOutput struct {
	Body apimodel.Task
}
type taskIDInput struct {
	ID string `path:"id"`
}
type updateTaskInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateTaskReq
}

func (a *api) registerSchedule(api huma.API) {
	const tag = "Schedule"
	reg(api, http.MethodGet, "/api/events", "listEvents", tag, "List events", http.StatusOK, a.listEvents)
	reg(api, http.MethodPost, "/api/events", "createEvent", tag, "Create an event", http.StatusCreated, a.createEvent)
	reg(api, http.MethodPatch, "/api/events/{id}", "updateEvent", tag, "Update an event", http.StatusOK, a.updateEvent)
	reg(api, http.MethodDelete, "/api/events/{id}", "deleteEvent", tag, "Delete an event", http.StatusNoContent, a.deleteEvent)
	reg(api, http.MethodGet, "/api/labels", "listLabels", tag, "List labels", http.StatusOK, a.listLabels)
	reg(api, http.MethodGet, "/api/tasks", "listTasks", tag, "List tasks", http.StatusOK, a.listTasks)
	reg(api, http.MethodPatch, "/api/tasks/{id}", "updateTask", tag, "Update a task", http.StatusOK, a.updateTask)
}

func (a *api) listEvents(ctx context.Context, _ *struct{}) (*eventsOutput, error) {
	res, err := a.s.ListEvents(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &eventsOutput{Body: res}, nil
}

func (a *api) createEvent(ctx context.Context, in *createEventInput) (*eventOutput, error) {
	if err := a.requireAccountCreate(ctx); err != nil {
		return nil, err
	}
	e := store.Event{
		Title: in.Body.Title, Start: in.Body.Start, End: in.Body.End,
		LabelIDs: in.Body.LabelIDs, Location: in.Body.Location, Note: in.Body.Note,
	}
	res, err := a.s.CreateEvent(ctx, userID(ctx), e)
	if err != nil {
		return nil, hErr(err)
	}
	return &eventOutput{Body: res}, nil
}

func (a *api) updateEvent(ctx context.Context, in *updateEventInput) (*eventOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	p := store.EventPatch{
		Title: in.Body.Title, Start: in.Body.Start, End: in.Body.End,
		LabelIDs: in.Body.LabelIDs, Location: in.Body.Location, Note: in.Body.Note,
	}
	res, err := a.s.UpdateEvent(ctx, in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return &eventOutput{Body: res}, nil
}

func (a *api) deleteEvent(ctx context.Context, in *eventIDInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.s.DeleteEvent(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) listLabels(ctx context.Context, _ *struct{}) (*labelsOutput, error) {
	res, err := a.s.ListLabels(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &labelsOutput{Body: res}, nil
}

func (a *api) listTasks(ctx context.Context, _ *struct{}) (*tasksOutput, error) {
	res, err := a.s.ListTasks(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &tasksOutput{Body: res}, nil
}

func (a *api) updateTask(ctx context.Context, in *updateTaskInput) (*taskOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.UpdateTask(ctx, in.ID, store.TaskPatch{Title: in.Body.Title, Meta: in.Body.Meta, Done: in.Body.Done})
	if err != nil {
		return nil, hErr(err)
	}
	return &taskOutput{Body: res}, nil
}
