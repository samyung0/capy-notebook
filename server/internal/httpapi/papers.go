package httpapi

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Papers: an assignment answered on paper (todo-file-submissions.md 5a). Its
// files arrive through the source upload with attemptId; these routes order and
// remove them while the attempt runs and sign their links for the member and
// the class's staff; once deletable they list on the Files page (listItems).
func (a *api) registerPapers(api huma.API) {
	reg(api, "DELETE", "/api/assignment-attempts/{id}/paper/{fileId}", "removePaperFile", "assignments",
		"Remove a file from a running attempt's paper", 204, a.removePaperFile)
	reg(api, "GET", "/api/assignment-attempts/{id}/paper/{fileId}/links", "getPaperFileLinks", "assignments",
		"A paper file's presigned reads, for its member or the class's staff", 200, a.getPaperFileLinks)
	// A hand-in (S3, T2): an unmarked assignment's files, through the source
	// upload with handInId.
	reg(api, "DELETE", "/api/assignments/{id}/hand-in/{fileId}", "removeHandInFile", "assignments",
		"Remove a file from the caller's open hand-in", 204, a.removeHandInFile)
	reg(api, "GET", "/api/assignments/{id}/hand-in/{fileId}/links", "getHandInFileLinks", "assignments",
		"A hand-in file's presigned reads, for its member or, once handed in, the class's staff", 200, a.getHandInFileLinks)
	reg(api, "DELETE", "/api/papers/{id}", "deletePaper", "assignments",
		"Delete one of the caller's hand-in files never handed in before its assignment closed; handed-in files stay", 204, a.deletePaper)
	regWithMaxBody(api, http.MethodPost, "/api/files/{id}/marked-copy", "storeMarkedCopy", "assignments",
		"Store the PDF copy staff mark a Word submission on, drawn by the first staff browser to open it; stored once",
		http.StatusNoContent, fieldlimits.SubmissionCopyBytes, a.storeMarkedCopy)
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

func (a *api) removeHandInFile(ctx context.Context, in *paperFileInput) (*Empty, error) {
	return &Empty{}, paperError(a.s.RemoveHandInFile(ctx, userID(ctx), in.ID, in.FileID))
}

func (a *api) getPaperFileLinks(ctx context.Context, in *paperFileInput) (*fileLinksOutput, error) {
	blob, err := a.s.PaperFileBlob(ctx, userID(ctx), in.ID, in.FileID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.submissionFileLinks(ctx, blob)
}

func (a *api) getHandInFileLinks(ctx context.Context, in *paperFileInput) (*fileLinksOutput, error) {
	blob, err := a.s.HandInFileBlob(ctx, userID(ctx), in.ID, in.FileID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.submissionFileLinks(ctx, blob)
}

// submissionFileLinks signs a paper's or hand-in's stored file, and as its
// preview the PDF it shows as: a PDF's own bytes, a .docx's marked copy.
func (a *api) submissionFileLinks(ctx context.Context, blob store.SubmissionBlob) (*fileLinksOutput, error) {
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	if blob.Path == "" {
		return nil, huma.Error404NotFound("no content")
	}
	signed, err := a.blob.PresignGetWithExpiry(ctx, blob.Path)
	if err != nil {
		return nil, hErr(err)
	}
	out := apimodel.FileLinks{URL: signed.URL, ExpiresAt: signed.ExpiresAt}
	switch {
	case blob.Kind == string(store.FilePDF):
		out.PreviewURL = &signed.URL
	case blob.Copy != "":
		copied, err := a.blob.PresignGetWithExpiry(ctx, blob.Copy)
		if err != nil {
			return nil, hErr(err)
		}
		out.PreviewURL = &copied.URL
	}
	return &fileLinksOutput{Body: out}, nil
}

type markedCopyInput struct {
	ID      string `path:"id" maxLength:"64"`
	RawBody []byte `contentType:"application/pdf"`
}

// storeMarkedCopy keeps a Word submission's PDF copy (mock
// B6H1Z7o4byVFBVyCRSUK3B C1) at copies/{id}/{uuid}.pdf, charged to no one.
// A browser that lost the race to another gets marked_copy_taken and opens
// the stored one; its own object is deleted here, as nothing references it.
func (a *api) storeMarkedCopy(ctx context.Context, in *markedCopyInput) (*Empty, error) {
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	actor := userID(ctx)
	if !bytes.HasPrefix(in.RawBody, []byte("%PDF-")) {
		return nil, huma.Error422UnprocessableEntity("the copy is not a PDF")
	}
	// Queued for deletion here, so an upload SetMarkedCopy never references
	// (a crash between the two) is reaped.
	key := "copies/" + in.ID + "/" + uuid.NewString() + ".pdf"
	if err := a.s.AssertMarkedCopy(ctx, actor, in.ID, key); err != nil {
		return nil, markedCopyError(err)
	}
	if _, err := a.blob.PutObjectOnce(ctx, key, bytes.NewReader(in.RawBody), "application/pdf", ""); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.SetMarkedCopy(ctx, actor, in.ID, key); err != nil {
		if deleted := a.blob.Delete(context.WithoutCancel(ctx), key); deleted != nil {
			obs.Log(ctx).Warn("unreferenced marked copy not deleted", "key", key, "error", deleted)
		}
		return nil, markedCopyError(err)
	}
	return &Empty{}, nil
}

func markedCopyError(err error) error {
	if errors.Is(err, store.ErrMarkedCopyTaken) {
		return conflictError("marked_copy_taken", err.Error())
	}
	return hErr(err)
}

func (a *api) deletePaper(ctx context.Context, in *drawingIDInput) (*Empty, error) {
	return &Empty{}, hErr(a.s.DeleteLeftHandIn(ctx, userID(ctx), in.ID))
}
