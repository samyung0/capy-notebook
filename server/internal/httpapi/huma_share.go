package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

/* Sharing & cloning.

Read access follows the privacy model in store/share.go: owners get full
access, link/public resources are readable by any signed-in user; standalone
materials are clonable by any reader, while a workspace, or a file or material
inside one, additionally requires membership or an effective editor grant.
A workspace clone lands in the caller's account; a file or material lands in a
workspace the caller edits (a material also standalone). Clones copy the
retrieval index in the same transaction as the content, so the copy is
queryable the moment it exists. */

type cloneWorkspaceInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateWorkspaceReq
}
type cloneWorkspaceOutput struct {
	Body apimodel.CloneWorkspaceResp
}
type cloneFileInput struct {
	ID   string `path:"id"`
	Body apimodel.CloneFileReq
}
type cloneMaterialInput struct {
	ID   string `path:"id"`
	Body apimodel.CloneMaterialReq
}
type publicFlashcardSetsOutput struct {
	Body []apimodel.PublicFlashcardSet `nullable:"false"`
}

func (a *api) registerShare(api huma.API) {
	const tag = "Sharing"
	reg(api, http.MethodPost, "/api/workspaces/{id}/clone", "cloneWorkspace", tag, "Clone a shared workspace", http.StatusCreated, a.cloneWorkspace)
	reg(api, http.MethodPost, "/api/files/{id}/clone", "cloneFile", tag, "Clone a file into a workspace", http.StatusCreated, a.cloneFile)
	reg(api, http.MethodPost, "/api/materials/{id}/clone", "cloneMaterial", tag, "Clone a material into a workspace or standalone", http.StatusCreated, a.cloneMaterial)
	reg(api, http.MethodGet, "/api/explore/flashcards", "exploreFlashcardSets", "Explore", "Public flashcards", http.StatusOK, a.exploreFlashcardSets)
}

/* ----------------------------------------------------------- access helpers */

// workspaceRead allows owners and link/public viewers; returns isOwner.
func (a *api) workspaceRead(ctx context.Context, wsID string) (bool, error) {
	return a.s.WorkspaceAccess(ctx, userID(ctx), wsID)
}

// materialRead allows owners and viewers of shared materials (or materials in
// shared workspaces); returns isOwner.
func (a *api) materialRead(ctx context.Context, matID string) (bool, error) {
	return a.s.MaterialAccess(ctx, userID(ctx), matID)
}

// fileRead resolves a file's workspace and applies workspaceRead.
func (a *api) fileRead(ctx context.Context, fileID string) (bool, error) {
	wsID, err := a.s.FileWorkspaceID(ctx, fileID)
	if err != nil {
		return false, err
	}
	return a.workspaceRead(ctx, wsID)
}

// Resource-editor helpers gate writes addressed by a child id.
func (a *api) assertChapterEditor(ctx context.Context, chapterID string) error {
	wsID, err := a.s.ChapterWorkspaceID(ctx, chapterID)
	if err != nil {
		return err
	}
	return a.assertWorkspaceEditor(ctx, wsID)
}

func (a *api) assertFileEditor(ctx context.Context, fileID string) error {
	wsID, err := a.s.FileWorkspaceID(ctx, fileID)
	if err != nil {
		return err
	}
	return a.assertWorkspaceEditor(ctx, wsID)
}

/* ------------------------------------------------------------------ cloning */

func (a *api) cloneWorkspace(ctx context.Context, in *cloneWorkspaceInput) (*cloneWorkspaceOutput, error) {
	if in.Body.Cover != nil {
		if err := in.Body.Cover.Check(); err != nil {
			return nil, huma.Error422UnprocessableEntity(err.Error())
		}
	}
	ws, copies, err := a.s.CloneWorkspaceThumbnails(ctx, userID(ctx), in.ID, in.Body.ToWorkspaceCreate())
	if err != nil {
		return nil, hErr(err)
	}
	a.copyCloneThumbnails(ctx, copies)
	statuses, err := a.accountStatuses(ctx, ws.OwnerUserID)
	if err != nil {
		return nil, err
	}
	return &cloneWorkspaceOutput{Body: apimodel.CloneWorkspaceResp{
		Workspace: apimodel.FromWorkspace(ws, statuses[ws.OwnerUserID]),
	}}, nil
}

// copyCloneThumbnails copies a clone's thumbnails under the clone's own file
// ids, inside the bucket. A failed copy leaves the file
// without a thumbnail until its next capture: logged, never retried.
func (a *api) copyCloneThumbnails(ctx context.Context, copies []store.ThumbnailCopy) {
	if a.blob == nil {
		return
	}
	for _, c := range copies {
		if err := a.blob.Copy(ctx, c.From, c.To); err != nil {
			obs.Log(ctx).Warn("clone thumbnail copy failed", "file_id", c.FileID, "error", err)
			continue
		}
		if err := a.s.SetCloneThumbnail(ctx, c.FileID, c.To); err != nil {
			obs.Log(ctx).Warn("clone thumbnail not recorded", "file_id", c.FileID, "key", c.To, "error", err)
		}
	}
}

// cloneTarget validates where a single-item copy lands; name is the copy's.
func cloneTarget(workspaceID, chapterID, chapterName, name string) (store.CloneTarget, error) {
	target := store.CloneTarget{
		WorkspaceID: workspaceID,
		ChapterName: strings.TrimSpace(chapterName),
		Name:        strings.TrimSpace(name),
	}
	switch {
	case target.Name == "":
		return target, huma.Error422UnprocessableEntity("the copy needs a name")
	case chapterID != "" && target.ChapterName != "":
		return target, huma.Error422UnprocessableEntity("give at most one of chapterId or chapterName")
	case workspaceID == "" && (chapterID != "" || target.ChapterName != ""):
		return target, huma.Error422UnprocessableEntity("a chapter goes with workspaceId")
	}
	if chapterID != "" {
		target.ChapterID = &chapterID
	}
	return target, nil
}

func (a *api) cloneFile(ctx context.Context, in *cloneFileInput) (*fileOutput, error) {
	b := in.Body
	target, err := cloneTarget(b.WorkspaceID, b.ChapterID, string(b.ChapterName), string(b.Name))
	if err != nil {
		return nil, err
	}
	file, copies, err := a.s.CloneFile(ctx, userID(ctx), in.ID, target)
	if err != nil {
		return nil, hErr(err)
	}
	a.copyCloneThumbnails(ctx, copies)
	return &fileOutput{Body: file}, nil
}

func (a *api) cloneMaterial(ctx context.Context, in *cloneMaterialInput) (*materialOutput, error) {
	b := in.Body
	target, err := cloneTarget(b.WorkspaceID, b.ChapterID, string(b.ChapterName), string(b.Title))
	if err != nil {
		return nil, err
	}
	mt, err := a.s.CloneMaterial(ctx, userID(ctx), in.ID, target)
	if err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), mt.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.materialResponse(ctx, mt, role, false, false)
}

/* ------------------------------------------------------------------ explore */

func (a *api) exploreFlashcardSets(ctx context.Context, _ *struct{}) (*publicFlashcardSetsOutput, error) {
	res, err := a.s.ListPublicFlashcardSets(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &publicFlashcardSetsOutput{Body: apimodel.FromPublicFlashcardSets(res)}, nil
}
