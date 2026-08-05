package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

type chaptersOutput struct {
	Body []apimodel.Chapter
}
type chapterOutput struct {
	Body apimodel.Chapter
}
type addChapterInput struct {
	ID   string `path:"id"`
	Body apimodel.AddChapterReq
}
type chapterIDInput struct {
	ID string `path:"id"`
}
type updateChapterInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateChapterReq
}
type reorderChaptersInput struct {
	ID   string `path:"id"`
	Body apimodel.ReorderChaptersReq
}
type reorderContentInput struct {
	ID   string `path:"id"`
	Body apimodel.ReorderContentReq
}
type filesOutput struct {
	Body []apimodel.File
}
type fileOutput struct {
	Body apimodel.File
}
type fileIDInput struct {
	ID string `path:"id"`
}
type updateFileInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateFileReq
}

func (a *api) registerContent(api huma.API) {
	const tag = "Content"
	reg(api, http.MethodGet, "/api/workspaces/{id}/chapters", "listChapters", tag, "List chapters", http.StatusOK, a.listChapters)
	reg(api, http.MethodPost, "/api/workspaces/{id}/chapters", "addChapter", tag, "Add a chapter", http.StatusCreated, a.addChapter)
	reg(api, http.MethodPost, "/api/workspaces/{id}/chapters/reorder", "reorderChapters", tag, "Reorder chapters", http.StatusNoContent, a.reorderChapters)
	reg(api, http.MethodPost, "/api/workspaces/{id}/content/reorder", "reorderContent", tag, "Move and reorder chapter content", http.StatusNoContent, a.reorderContent)
	reg(api, http.MethodPatch, "/api/chapters/{id}", "updateChapter", tag, "Update a chapter", http.StatusOK, a.updateChapter)
	reg(api, http.MethodDelete, "/api/chapters/{id}", "deleteChapter", tag, "Delete a chapter", http.StatusNoContent, a.deleteChapter)

	reg(api, http.MethodGet, "/api/files", "listAllFiles", tag, "List all files", http.StatusOK, a.listAllFiles)
	reg(api, http.MethodGet, "/api/workspaces/{id}/files", "listWorkspaceFiles", tag, "List workspace files", http.StatusOK, a.listWorkspaceFiles)
	reg(api, http.MethodGet, "/api/files/{id}", "getFile", tag, "Get a file", http.StatusOK, a.getFile)
	reg(api, http.MethodPatch, "/api/files/{id}", "updateFile", tag, "Update a file", http.StatusOK, a.updateFile)
	reg(api, http.MethodDelete, "/api/files/{id}", "deleteFile", tag, "Delete a file", http.StatusNoContent, a.deleteFile)
}

func (a *api) assertWorkspaceEditor(ctx context.Context, wsID string) error {
	err := a.s.AssertWorkspaceEditor(ctx, userID(ctx), wsID)
	if errors.Is(err, store.ErrForbidden) {
		return store.ErrNotFound
	}
	return err
}

func (a *api) listChapters(ctx context.Context, in *workspaceIDInput) (*chaptersOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ListChapters(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &chaptersOutput{Body: res}, nil
}

func (a *api) addChapter(ctx context.Context, in *addChapterInput) (*chapterOutput, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.AddChapter(ctx, in.ID, in.Body.Name)
	if err != nil {
		return nil, hErr(err)
	}
	return &chapterOutput{Body: res}, nil
}

func (a *api) updateChapter(ctx context.Context, in *updateChapterInput) (*chapterOutput, error) {
	if err := a.assertChapterEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.UpdateChapter(ctx, in.ID, store.ChapterPatch{Name: in.Body.Name, Order: in.Body.Order})
	if err != nil {
		return nil, hErr(err)
	}
	return &chapterOutput{Body: res}, nil
}

func (a *api) reorderChapters(ctx context.Context, in *reorderChaptersInput) (*Empty, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.ReorderChapters(ctx, in.Body.IDs); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) reorderContent(ctx context.Context, in *reorderContentInput) (*Empty, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	items := make([]store.ContentOrderItem, len(in.Body.Items))
	for i, item := range in.Body.Items {
		items[i] = store.ContentOrderItem{ID: item.ID, Type: item.Type}
	}
	if err := a.s.ReorderContent(ctx, in.ID, in.Body.ChapterID, items); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) deleteChapter(ctx context.Context, in *chapterIDInput) (*Empty, error) {
	if err := a.assertChapterEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.DeleteChapter(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) listAllFiles(ctx context.Context, _ *struct{}) (*filesOutput, error) {
	res, err := a.s.ListFiles(ctx, userID(ctx), "")
	if err != nil {
		return nil, hErr(err)
	}
	return &filesOutput{Body: res}, nil
}

func (a *api) listWorkspaceFiles(ctx context.Context, in *workspaceIDInput) (*filesOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ListFiles(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &filesOutput{Body: res}, nil
}

func (a *api) getFile(ctx context.Context, in *fileIDInput) (*fileOutput, error) {
	if _, err := a.fileRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetFile(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &fileOutput{Body: res}, nil
}

func (a *api) updateFile(ctx context.Context, in *updateFileInput) (*fileOutput, error) {
	if err := a.assertFileEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	patch := store.FilePatch{Name: in.Body.Name}
	// chapterId: "" unfiles (NULL), a real id files it, omitted leaves it.
	if in.Body.ChapterID != nil {
		if *in.Body.ChapterID == "" {
			var none *string
			patch.ChapterID = &none
		} else {
			cid := *in.Body.ChapterID
			p := &cid
			patch.ChapterID = &p
		}
	}
	res, err := a.s.UpdateFile(ctx, in.ID, patch)
	if err != nil {
		return nil, hErr(err)
	}
	return &fileOutput{Body: res}, nil
}

func (a *api) deleteFile(ctx context.Context, in *fileIDInput) (*Empty, error) {
	if err := a.assertFileEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	// The blob objects are queued for the reaper by trigger, so there is nothing
	// to clean up here and no chance of leaking them if this request dies.
	if err := a.s.DeleteFile(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
