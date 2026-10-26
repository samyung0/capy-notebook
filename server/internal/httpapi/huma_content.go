package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type chaptersOutput struct {
	Body []apimodel.Chapter `nullable:"false"`
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
	Body []apimodel.File `nullable:"false"`
}
type workspaceRecentOutput struct {
	Body apimodel.WorkspaceRecent
}
type filesListInput struct {
	Kind        string `query:"kind" doc:"Comma-separated file kinds"`
	WorkspaceID string `query:"workspaceId" doc:"Comma-separated workspace ids"`
	Scope       string `query:"scope" enum:"owned,member" default:"owned" doc:"owned: the files the caller pays for, wherever they sit (the Files page); member: the files the caller can open, in its workspaces and those it is a member of"`
	Sort        string `query:"sort" enum:"added,name,size,kind,workspace" default:"added"`
	Dir         string `query:"dir" enum:"asc,desc" default:"desc"`
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"40"`
	Cursor      string `query:"cursor" doc:"Opaque cursor from the previous page"`
}
type filePageOutput struct {
	Body apimodel.FilePage
}
type fileOutput struct {
	Body apimodel.File
}
type fileIDInput struct {
	ID string `path:"id"`
}
type trashFileInput struct {
	ID        string `path:"id"`
	RequestID string `query:"requestId" maxLength:"64" doc:"Optional idempotency key for this trash action"`
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

	reg(api, http.MethodGet, "/api/files", "listOwnedFiles", tag, "List the files the caller pays for, or can open (scope=member)", http.StatusOK, a.listOwnedFiles)
	reg(api, http.MethodGet, "/api/workspaces/{id}/files", "listWorkspaceFiles", tag, "List workspace files", http.StatusOK, a.listWorkspaceFiles)
	reg(api, http.MethodGet, "/api/workspaces/{id}/recent", "listWorkspaceRecent", tag, "List a workspace's newest files and materials", http.StatusOK, a.listWorkspaceRecent)
	reg(api, http.MethodPost, "/api/workspaces/{id}/files/blank", "createBlankFile", tag, "Create a blank Word or Excel file", http.StatusCreated, a.createBlankFile)
	reg(api, http.MethodGet, "/api/files/{id}", "getFile", tag, "Get a file", http.StatusOK, a.getFile)
	reg(api, http.MethodGet, "/api/files/{id}/links", "getFileLinks", tag, "Get presigned file reads", http.StatusOK, a.getFileLinks)
	reg(api, http.MethodPatch, "/api/files/{id}", "updateFile", tag, "Update a file", http.StatusOK, a.updateFile)
	reg(api, http.MethodDelete, "/api/files/{id}", "deleteFile", tag, "Move a file to the trash", http.StatusNoContent, a.deleteFile)
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
	res, err := a.s.AddChapter(ctx, in.ID, userID(ctx), string(in.Body.Name))
	if err != nil {
		return nil, hErr(err)
	}
	return &chapterOutput{Body: res}, nil
}

func (a *api) updateChapter(ctx context.Context, in *updateChapterInput) (*chapterOutput, error) {
	if err := a.assertChapterEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.UpdateChapter(ctx, userID(ctx), in.ID, store.ChapterPatch{Name: apimodel.Str(in.Body.Name), Order: in.Body.Order})
	if err != nil {
		return nil, hErr(err)
	}
	return &chapterOutput{Body: res}, nil
}

func (a *api) reorderChapters(ctx context.Context, in *reorderChaptersInput) (*Empty, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.ReorderChapters(ctx, userID(ctx), in.ID, in.Body.IDs); err != nil {
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
	if err := a.s.ReorderContent(ctx, in.ID, userID(ctx), in.Body.ChapterID, items); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) deleteChapter(ctx context.Context, in *chapterIDInput) (*Empty, error) {
	if err := a.assertChapterEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.DeleteChapter(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) listOwnedFiles(ctx context.Context, in *filesListInput) (*filePageOutput, error) {
	page, err := a.s.ListOwnedFiles(ctx, userID(ctx), store.FileListFilter{
		Kinds: csv(in.Kind), WorkspaceIDs: csv(in.WorkspaceID), Member: in.Scope == "member",
		Sort: in.Sort, Ascending: in.Dir == "asc", Limit: in.Limit, Cursor: in.Cursor,
	})
	if err != nil {
		return nil, hErr(err)
	}
	if err := a.signFileThumbnails(ctx, page.Items); err != nil {
		return nil, hErr(err)
	}
	return &filePageOutput{Body: page}, nil
}

func (a *api) listWorkspaceFiles(ctx context.Context, in *workspaceIDInput) (*filesOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ListFiles(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if err := a.signFileThumbnails(ctx, res); err != nil {
		return nil, hErr(err)
	}
	return &filesOutput{Body: res}, nil
}

// workspaceRecentCount is the empty viewer's 2x2 quick-open grid.
const workspaceRecentCount = 4

// listWorkspaceRecent serves the empty viewer's grid to every reader of the
// workspace (members, link and public readers alike), unlike the owned lists.
func (a *api) listWorkspaceRecent(ctx context.Context, in *workspaceIDInput) (*workspaceRecentOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ListWorkspaceRecent(ctx, in.ID, workspaceRecentCount)
	if err != nil {
		return nil, hErr(err)
	}
	if err := a.signFileThumbnails(ctx, res.Files); err != nil {
		return nil, hErr(err)
	}
	return &workspaceRecentOutput{Body: res}, nil
}

// signFileThumbnails gives each row its hour-stable thumbnail link. Callers
// pass only rows an access-scoped query returned for this caller, so a link is
// minted exactly for files the caller can already read (openwiki/thumbnails.md,
// TestListThumbnailsFollowReadAccess). Signing is local: no database call.
func (a *api) signFileThumbnails(ctx context.Context, files []store.File) error {
	for i := range files {
		url, err := a.thumbnailURL(ctx, files[i].ThumbnailKey)
		if err != nil {
			return err
		}
		files[i].ThumbnailURL = url
	}
	return nil
}

func (a *api) thumbnailURL(ctx context.Context, key string) (*string, error) {
	if key == "" || a.blob == nil {
		return nil, nil
	}
	url, err := a.blob.PresignStableGet(ctx, key)
	if err != nil {
		return nil, err
	}
	return &url, nil
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

type fileLinksOutput struct {
	Body apimodel.FileLinks
}

// getFileLinks presigns the source and citation-preview objects. Owners plus
// link/public viewers, like every other file read. Bytes never proxy through
// the gateway.
func (a *api) getFileLinks(ctx context.Context, in *fileIDInput) (*fileLinksOutput, error) {
	// The read check (fileRead) and the role the strip needs, in one lookup.
	wsID, err := a.s.FileWorkspaceID(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.WorkspaceEffectiveRole(ctx, userID(ctx), wsID)
	if err != nil {
		return nil, hErr(err)
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	source, preview, err := a.s.FileBlobPaths(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if source == "" {
		return nil, huma.Error404NotFound("no content")
	}
	signed, err := a.blob.PresignGetWithExpiry(ctx, source)
	if err != nil {
		return nil, hErr(err)
	}
	out := apimodel.FileLinks{URL: signed.URL, ExpiresAt: signed.ExpiresAt}
	// The payer's full storage explains view-only only to those who could
	// edit; a viewer was never editing (like materials and source sessions).
	if store.RoleCanEdit(role) {
		payer, err := a.s.FilePayerID(ctx, in.ID)
		if err != nil {
			return nil, hErr(err)
		}
		full, err := a.ownerFull(ctx, payer)
		if err != nil {
			return nil, hErr(err)
		}
		out.StorageFull = store.FullBy(full, payer, userID(ctx))
	}
	if preview != "" {
		signedPreview, err := a.blob.PresignGetWithExpiry(ctx, preview)
		if err != nil {
			return nil, hErr(err)
		}
		out.PreviewURL = &signedPreview.URL
	}
	return &fileLinksOutput{Body: out}, nil
}

func (a *api) updateFile(ctx context.Context, in *updateFileInput) (*fileOutput, error) {
	if err := a.assertFileEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	patch := store.FilePatch{Name: apimodel.Str(in.Body.Name)}
	if patch.Name != nil {
		// A rename keeps the file's extension, which names its kind and the
		// checks its upload passed (Epo 2026-10-24, Q346).
		if !fieldlimits.ValidFileName(*patch.Name) {
			return nil, invalidFileName()
		}
		file, err := a.s.GetFile(ctx, in.ID)
		if err != nil {
			return nil, hErr(err)
		}
		if sourceupload.Extension(*patch.Name) != sourceupload.Extension(file.Name) {
			return nil, &huma.ErrorModel{
				Status: http.StatusUnprocessableEntity, Title: http.StatusText(http.StatusUnprocessableEntity),
				Detail: "a rename keeps the file's extension",
				Errors: []*huma.ErrorDetail{{Message: "file_extension_changed"}},
			}
		}
	}
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
	res, err := a.s.UpdateFile(ctx, userID(ctx), in.ID, patch)
	if err != nil {
		return nil, hErr(err)
	}
	return &fileOutput{Body: res}, nil
}

// deleteFile moves the file into the trash. Blobs, index and charges stay
// until the owner purges it or the 30-day sweep does; the trash transition
// trigger cancels pipeline work and evicts the source room.
func (a *api) deleteFile(ctx context.Context, in *trashFileInput) (*Empty, error) {
	if err := a.orPayer(ctx, agenttools.KindSourceFile, in.ID, a.assertFileEditor(ctx, in.ID)); err != nil {
		return nil, hErr(err)
	}
	op, err := trashOperation(ctx, in.RequestID, agenttools.KindSourceFile, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if _, err := a.s.TrashFile(ctx, userID(ctx), in.ID, op); err != nil {
		return nil, trashError(err)
	}
	return &Empty{}, nil
}
