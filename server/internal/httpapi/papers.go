package httpapi

import (
	"context"
	"errors"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Papers: an assignment answered on paper (todo-file-submissions.md 5a). Its
// files arrive through the source upload with attemptId; these routes order and
// remove them while the attempt runs, sign their links for the member and the
// class's staff, and list them in Files › Submissions once deletable.
func (a *api) registerPapers(api huma.API) {
	reg(api, "DELETE", "/api/assignment-attempts/{id}/paper/{fileId}", "removePaperFile", "assignments",
		"Remove a file from a running attempt's paper", 204, a.removePaperFile)
	reg(api, "PUT", "/api/assignment-attempts/{id}/paper/order", "orderPaperFiles", "assignments",
		"Put a running attempt's paper files in order", 204, a.orderPaperFiles)
	reg(api, "GET", "/api/assignment-attempts/{id}/paper/{fileId}/links", "getPaperFileLinks", "assignments",
		"A paper file's presigned reads, for its member or the class's staff", 200, a.getPaperFileLinks)
	// A hand-in (S3, T2): an unmarked assignment's files, through the source
	// upload with handInId.
	reg(api, "DELETE", "/api/assignments/{id}/hand-in/{fileId}", "removeHandInFile", "assignments",
		"Remove a file from the caller's open hand-in", 204, a.removeHandInFile)
	reg(api, "GET", "/api/assignments/{id}/hand-in/{fileId}/links", "getHandInFileLinks", "assignments",
		"A hand-in file's presigned reads, for its member or, once handed in, the class's staff", 200, a.getHandInFileLinks)
	reg(api, "GET", "/api/papers", "listPapers", "assignments",
		"The caller's handed-in paper and hand-in files they may delete, newest first (Files › Submissions)", 200, a.listPapers)
	reg(api, "DELETE", "/api/papers/{id}", "deletePaper", "assignments",
		"Delete one of the caller's deletable paper files; its marks stay", 200, a.deletePaper)
	reg(api, "DELETE", "/api/papers", "deleteAllPapers", "assignments",
		"Delete every paper file the caller may delete; their marks stay", 200, a.deleteAllPapers)
}

type paperFileInput struct {
	ID     string `path:"id" maxLength:"64"`
	FileID string `path:"fileId" maxLength:"64"`
}

func paperError(err error) error {
	switch {
	case errors.Is(err, store.ErrPaperClosed):
		return conflictError("paper_closed", err.Error())
	case errors.Is(err, store.ErrHandInClosed):
		return conflictError("hand_in_closed", err.Error())
	case errors.Is(err, store.ErrPaperFull):
		return huma.Error422UnprocessableEntity(err.Error())
	}
	return assignmentError(err)
}

func (a *api) removePaperFile(ctx context.Context, in *paperFileInput) (*Empty, error) {
	return &Empty{}, paperError(a.s.RemovePaperFile(ctx, userID(ctx), in.ID, in.FileID, time.Now()))
}

type paperOrderInput struct {
	ID   string `path:"id" maxLength:"64"`
	Body struct {
		FileIDs []string `json:"fileIds" nullable:"false" maxItems:"15"`
	}
}

func (a *api) orderPaperFiles(ctx context.Context, in *paperOrderInput) (*Empty, error) {
	return &Empty{}, paperError(a.s.OrderPaperFiles(ctx, userID(ctx), in.ID, in.Body.FileIDs, time.Now()))
}

func (a *api) removeHandInFile(ctx context.Context, in *paperFileInput) (*Empty, error) {
	return &Empty{}, paperError(a.s.RemoveHandInFile(ctx, userID(ctx), in.ID, in.FileID))
}

func (a *api) getPaperFileLinks(ctx context.Context, in *paperFileInput) (*fileLinksOutput, error) {
	source, kind, err := a.s.PaperFileBlob(ctx, userID(ctx), in.ID, in.FileID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.submissionFileLinks(ctx, source, kind)
}

func (a *api) getHandInFileLinks(ctx context.Context, in *paperFileInput) (*fileLinksOutput, error) {
	source, kind, err := a.s.HandInFileBlob(ctx, userID(ctx), in.ID, in.FileID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.submissionFileLinks(ctx, source, kind)
}

// submissionFileLinks signs a paper's or hand-in's stored file.
func (a *api) submissionFileLinks(ctx context.Context, source, kind string) (*fileLinksOutput, error) {
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	if source == "" {
		return nil, huma.Error404NotFound("no content")
	}
	signed, err := a.blob.PresignGetWithExpiry(ctx, source)
	if err != nil {
		return nil, hErr(err)
	}
	out := apimodel.FileLinks{URL: signed.URL, ExpiresAt: signed.ExpiresAt}
	// A PDF shows page by page from the same bytes.
	if kind == string(store.FilePDF) {
		out.PreviewURL = &signed.URL
	}
	return &fileLinksOutput{Body: out}, nil
}

type paperListOutput struct {
	Body store.SubmittedPapers
}

func (a *api) listPapers(ctx context.Context, in *drawingListInput) (*paperListOutput, error) {
	page, err := a.s.ListSubmittedPapers(ctx, userID(ctx), in.Cursor, in.Limit)
	if err != nil {
		return nil, hErr(err)
	}
	return &paperListOutput{Body: page}, nil
}

func (a *api) deletePaper(ctx context.Context, in *drawingIDInput) (*drawingsDeletedOutput, error) {
	n, err := a.s.DeleteSubmittedPapers(ctx, userID(ctx), []string{in.ID})
	if err != nil {
		return nil, hErr(err)
	}
	if n == 0 {
		return nil, hErr(store.ErrNotFound)
	}
	out := &drawingsDeletedOutput{}
	out.Body.Deleted = n
	return out, nil
}

func (a *api) deleteAllPapers(ctx context.Context, _ *struct{}) (*drawingsDeletedOutput, error) {
	n, err := a.s.DeleteSubmittedPapers(ctx, userID(ctx), nil)
	if err != nil {
		return nil, hErr(err)
	}
	out := &drawingsDeletedOutput{}
	out.Body.Deleted = n
	return out, nil
}
