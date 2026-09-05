package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
)

type canvasesOutput struct {
	Body []apimodel.Canvas `nullable:"false"`
}
type canvasOutput struct {
	Body apimodel.Canvas
}
type canvasIDInput struct {
	ID string `path:"id"`
}
type createCanvasInput struct {
	Body apimodel.CreateCanvasReq
}
type saveCanvasInput struct {
	ID   string `path:"id"`
	Body apimodel.SaveCanvasReq
}

func (a *api) registerThinking(api huma.API) {
	const tag = "Thinking"
	reg(api, http.MethodGet, "/api/thinking", "listCanvases", tag, "List thinking canvases", http.StatusOK, a.listCanvases)
	reg(api, http.MethodPost, "/api/thinking", "createCanvas", tag, "Create a canvas", http.StatusCreated, a.createCanvas)
	reg(api, http.MethodGet, "/api/thinking/{id}", "getCanvas", tag, "Get a canvas", http.StatusOK, a.getCanvas)
	reg(api, http.MethodPut, "/api/thinking/{id}", "saveCanvas", tag, "Save a canvas", http.StatusOK, a.saveCanvas)
}

func (a *api) listCanvases(ctx context.Context, _ *struct{}) (*canvasesOutput, error) {
	res, err := a.s.ListCanvases(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &canvasesOutput{Body: res}, nil
}

func (a *api) createCanvas(ctx context.Context, in *createCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.CreateCanvas(ctx, userID(ctx), in.Body.Name)
	if err != nil {
		return nil, hErr(err)
	}
	return &canvasOutput{Body: res}, nil
}

func (a *api) getCanvas(ctx context.Context, in *canvasIDInput) (*canvasOutput, error) {
	res, err := a.s.GetCanvas(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &canvasOutput{Body: res}, nil
}

func (a *api) saveCanvas(ctx context.Context, in *saveCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	var scene json.RawMessage
	if in.Body.Scene != nil {
		scene = apimodel.EncodeRaw(in.Body.Scene)
	}
	res, err := a.s.SaveCanvas(ctx, userID(ctx), in.ID, in.Body.Name, scene)
	if err != nil {
		return nil, hErr(err)
	}
	return &canvasOutput{Body: res}, nil
}
