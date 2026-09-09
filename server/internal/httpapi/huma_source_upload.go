package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// uploadSourceForm is the multipart body the browser sends when bytes go
// through the API instead of a presigned PUT. Bounded fields validate like
// every JSON request. huma requires form parts by default, so every optional
// part must carry required:"false" or real uploads 422.
type uploadSourceForm struct {
	File          huma.FormFile        `form:"file" contentType:"application/octet-stream" required:"true"`
	Name          apimodel.FileName    `form:"name" required:"false"`
	Kind          string               `form:"kind" required:"false"`
	ChapterID     string               `form:"chapterId" required:"false"`
	ChapterName   apimodel.ChapterName `form:"chapterName" required:"false"`
	ParseMode     string               `form:"parseMode" required:"false"`
	CaptionImages bool                 `form:"captionImages" required:"false"`
}

type uploadSourceInput struct {
	ID      string `path:"id"`
	RawBody huma.MultipartFormFiles[uploadSourceForm]
}

// multipartHeadroom covers form field overhead above the largest source file.
const multipartHeadroom = 4 << 20

// Source uploads run through huma's multipart parser; keep them in memory up
// to the size the raw handler used instead of humachi's 8 KiB default. Set
// once here rather than per New() call, since live handlers read the global.
func init() {
	humachi.MultipartMaxMemory = 32 << 20
}

func (a *api) registerSourceUpload(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID:   "uploadSource",
		Method:        http.MethodPost,
		Path:          "/api/workspaces/{id}/sources",
		Summary:       "Upload a source through the API",
		Tags:          []string{"Content"},
		DefaultStatus: http.StatusCreated,
		// huma reads the whole form before the handler runs, so authorize and
		// cap the body here. The cap is the absolute source ceiling; the
		// plan-aware check runs in the handler.
		Middlewares: huma.Middlewares{func(ctx huma.Context, next func(huma.Context)) {
			if err := a.assertWorkspaceEditor(ctx.Context(), ctx.Param("id")); err != nil {
				writeStatusErr(api, ctx, hErr(err))
				return
			}
			maxBytes, err := a.s.MaxSourceFileBytes()
			if err != nil {
				huma.WriteErr(api, ctx, http.StatusServiceUnavailable, "source size limit unavailable")
				return
			}
			r, w := humachi.Unwrap(ctx)
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes+multipartHeadroom)
			next(ctx)
		}},
	}, a.uploadSource)
}

// writeStatusErr renders an hErr result from middleware, where the handler's
// error return is not available.
func writeStatusErr(api huma.API, ctx huma.Context, err error) {
	model, ok := err.(*huma.ErrorModel)
	if !ok {
		_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, err.Error())
		return
	}
	details := make([]error, len(model.Errors))
	for i, detail := range model.Errors {
		details[i] = detail
	}
	_ = huma.WriteErr(api, ctx, model.Status, model.Detail, details...)
}

func (a *api) uploadSource(ctx context.Context, in *uploadSourceInput) (*sourceFileOutput, error) {
	wsID := in.ID
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	form := in.RawBody.Data()
	defer form.File.Close()

	name := strings.TrimSpace(string(form.Name))
	if name == "" {
		// The part's filename is not schema-validated; clamp it like other
		// names the user did not type.
		name = fieldlimits.ClampFileName(form.File.Filename)
	}
	if name == "" {
		return nil, huma.Error400BadRequest("file name is required")
	}
	kind := form.Kind
	if kind == "" {
		kind = kindFromName(name)
	}
	var chapterID *string
	if form.ChapterID != "" {
		chapterID = &form.ChapterID
	}
	chapterName := strings.TrimSpace(string(form.ChapterName))
	if chapterID != nil && chapterName != "" {
		return nil, huma.Error400BadRequest("chapterId and chapterName cannot both be set")
	}
	if chapterID != nil {
		chapterWorkspace, err := a.s.ChapterWorkspaceID(ctx, *chapterID)
		if err != nil || chapterWorkspace != wsID {
			return nil, huma.Error400BadRequest("chapter does not belong to this workspace")
		}
	}
	parseMode := form.ParseMode
	if parseMode == "" {
		parseMode = sourceupload.DefaultParseMode(name, kind)
	}
	maxBytes, err := a.sourceMaxBytes(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}
	if err := sourceupload.Validate(name, kind, parseMode, form.File.Size, maxBytes); err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	captionImages := sourceupload.NormalizeCaptionImages(kind, parseMode, form.CaptionImages)
	needsJob := sourceupload.NeedsIngestJob(name, kind, parseMode)
	if needsJob {
		if err := a.s.AssertCreditsAvailable(ctx, userID(ctx)); err != nil {
			return nil, hErr(err)
		}
	}

	blobPath, size, err := a.blob.Put(sourceObjectKey(randID("blob")), form.File)
	if err != nil {
		return nil, hErr(err)
	}
	var res apimodel.File
	if needsJob {
		res, _, err = a.s.CreateSourceWithJob(ctx, wsID, userID(ctx), name, kind, chapterID, chapterName, size, blobPath, a.parser, parseMode, captionImages)
	} else {
		res, err = a.s.CreateSourceReady(ctx, wsID, userID(ctx), name, kind, chapterID, chapterName, size, blobPath)
	}
	if err != nil {
		_ = a.blob.Delete(ctx, blobPath)
		return nil, hErr(err)
	}
	return &sourceFileOutput{Status: http.StatusCreated, Body: res}, nil
}

func (a *api) sourceMaxBytes(ctx context.Context, wsID string) (int64, error) {
	if wsID != "" {
		tier, err := a.s.WorkspaceOwnerPlan(ctx, wsID)
		if err != nil {
			return 0, err
		}
		limits, err := a.s.PlanLimits(tier)
		if err != nil {
			return 0, err
		}
		return limits.SourceFileBytes, nil
	}
	me, err := a.s.Me(ctx, userID(ctx))
	if err != nil {
		return 0, err
	}
	limits, err := a.s.PlanLimits(me.PlanTier)
	if err != nil {
		return 0, err
	}
	return limits.SourceFileBytes, nil
}
