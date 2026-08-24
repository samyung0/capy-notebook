package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
)

type listTagsInput struct {
	Kind string `query:"kind" doc:"Tag kind: workspace | quiz | card"`
}
type tagsOutput struct {
	Body []apimodel.Tag `nullable:"false"`
}

func (a *api) registerTags(api huma.API) {
	const tag = "Tags"
	reg(api, http.MethodGet, "/api/tags", "listTags", tag, "List the user's tag catalog for a kind", http.StatusOK, a.listTags)
}

func (a *api) listTags(ctx context.Context, in *listTagsInput) (*tagsOutput, error) {
	if in.Kind == "" {
		return &tagsOutput{Body: []apimodel.Tag{}}, nil
	}
	res, err := a.s.ListTags(ctx, userID(ctx), in.Kind)
	if err != nil {
		return nil, hErr(err)
	}
	return &tagsOutput{Body: apimodel.WrapTags(res)}, nil
}
