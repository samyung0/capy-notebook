package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type materialRevisionsOutput struct {
	Body []apimodel.MaterialRevision `nullable:"false"`
}
type discussionsOutput struct {
	Body []apimodel.Discussion `nullable:"false"`
}
type discussionOutput struct{ Body apimodel.Discussion }
type commentOutput struct{ Body apimodel.Comment }

type createDiscussionInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateDiscussionReq
}

type discussionIDInput struct {
	ID string `path:"id"`
}

type updateDiscussionInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateDiscussionReq
}

type createCommentInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateCommentReq
}

type updateCommentBodyInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateCommentReq
}

type collaborationTokenInput struct {
	ID string `path:"id"`
}

type collaborationTokenResponse struct {
	Token string `json:"token"`
	Room  string `json:"room"`
	URL   string `json:"url"`
	// shrink is write access restricted to edits that reduce the document, which
	// is how an over-quota account stays able to delete its way back under limit.
	Access    string `json:"access" enum:"write,comment,shrink"`
	ExpiresAt int64  `json:"expiresAt"`
}

type collaborationTokenOutput struct {
	Body collaborationTokenResponse
}

type projectMaterialReq struct {
	Content    materialdoc.Envelope `json:"content"`
	YjsVersion int64                `json:"yjsVersion" minimum:"1"`
}

type projectMaterialInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	Body   projectMaterialReq
}

type projectMaterialOutput struct {
	Body apimodel.MaterialUpdateResult
}

func (a *api) registerCollaboration(api huma.API) {
	const tag = "Material collaboration"
	reg(api, http.MethodGet, "/api/materials/{id}/revisions", "listMaterialRevisions", tag, "List material revisions", http.StatusOK, a.listMaterialRevisions)
	reg(api, http.MethodGet, "/api/materials/{id}/discussions", "listMaterialDiscussions", tag, "List nested material comment discussions", http.StatusOK, a.listMaterialDiscussions)
	reg(api, http.MethodPost, "/api/materials/{id}/discussions", "createMaterialDiscussion", tag, "Create a comment discussion", http.StatusCreated, a.createMaterialDiscussion)
	reg(api, http.MethodPatch, "/api/discussions/{id}", "updateMaterialDiscussion", tag, "Resolve or reopen a comment discussion", http.StatusNoContent, a.updateMaterialDiscussion)
	reg(api, http.MethodDelete, "/api/discussions/{id}", "deleteMaterialDiscussion", tag, "Soft-delete a comment discussion", http.StatusNoContent, a.deleteMaterialDiscussion)
	reg(api, http.MethodPost, "/api/discussions/{id}/comments", "createMaterialComment", tag, "Add a comment or one-level reply", http.StatusCreated, a.createMaterialComment)
	reg(api, http.MethodPatch, "/api/comments/{id}", "updateMaterialComment", tag, "Edit an authored comment", http.StatusOK, a.updateMaterialComment)
	reg(api, http.MethodDelete, "/api/comments/{id}", "deleteMaterialComment", tag, "Soft-delete a comment", http.StatusNoContent, a.deleteMaterialComment)
	reg(api, http.MethodPost, "/api/materials/{id}/collaboration-token", "createMaterialCollaborationToken", tag, "Create a short-lived material room token", http.StatusCreated, a.createMaterialCollaborationToken)
	regWithMaxBody(api, http.MethodPost, "/internal/collaboration/materials/{id}/projection", "projectMaterialYjsDocument", tag, "Project a durably stored Yjs document", http.StatusOK, materialRequestMaxBytes, a.projectMaterialYjsDocument)
}

func (a *api) listMaterialRevisions(ctx context.Context, in *materialIDInput) (*materialRevisionsOutput, error) {
	if _, err := a.s.MaterialAccess(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	rows, err := a.s.ListMaterialRevisions(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	out := make([]apimodel.MaterialRevision, len(rows))
	for i, revision := range rows {
		out[i], err = apimodel.FromMaterialRevision(revision)
		if err != nil {
			return nil, materialContentError(err)
		}
	}
	return &materialRevisionsOutput{Body: out}, nil
}

func (a *api) createMaterialCollaborationToken(
	ctx context.Context,
	in *collaborationTokenInput,
) (*collaborationTokenOutput, error) {
	uid := userID(ctx)
	role, err := a.s.MaterialEffectiveRole(ctx, uid, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	access := ""
	switch {
	case store.RoleCanEdit(role):
		access = "write"
	case store.RoleCanComment(role):
		access = "comment"
	default:
		return nil, collaborationError(store.ErrForbidden)
	}
	// The room token is the collaboration server's only source of truth for what
	// a connection may do, so lifecycle restrictions have to be resolved here.
	// Tokens are short-lived, which bounds how long a stale grant survives.
	//
	// The role above decided whether this user may write at all; the material's
	// storage owner decides which direction the document may move, because the
	// bytes are charged to the owner and never to the actor. The actor's own
	// lifecycle does not enter into it: suspended, deletion-pending and deleted
	// users are refused a session by the auth middleware, and their storage
	// state is irrelevant inside a workspace they do not pay for.
	if access == "write" {
		owner, err := a.s.MaterialOwnerAccess(ctx, in.ID)
		if err != nil {
			return nil, collaborationError(err)
		}
		switch {
		case owner.ShrinkOnly():
			access = "shrink"
		case !owner.CanEdit():
			access = "comment"
		}
	}
	me, _ := a.s.Me(ctx, uid)
	room, err := a.s.MaterialRoom(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	schema := 1
	if _, _, found := strings.Cut(room, ":schema:"); found {
		if parsed, parseErr := strconv.Atoi(room[strings.LastIndex(room, ":")+1:]); parseErr == nil {
			schema = parsed
		}
	}
	claims := newCollaborationClaims(uid, room, access, me.Name, me.AvatarURL, randID("collab"), schema)
	token, err := signCollaborationToken(a.cfg.CollaborationSecret, claims)
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("collaboration service unavailable", err)
	}
	return &collaborationTokenOutput{Body: collaborationTokenResponse{
		Token: token, Room: room, URL: a.cfg.CollaborationURL, Access: access,
		ExpiresAt: claims.ExpiresAt,
	}}, nil
}

func (a *api) projectMaterialYjsDocument(
	ctx context.Context,
	in *projectMaterialInput,
) (*projectMaterialOutput, error) {
	if a.cfg.CollaborationSecret == "" ||
		subtle.ConstantTimeCompare([]byte(in.Secret), []byte(a.cfg.CollaborationSecret)) != 1 {
		return nil, huma.Error401Unauthorized("invalid collaboration service secret")
	}
	raw, err := materialdoc.MarshalProjection(in.Body.Content)
	if err != nil {
		return nil, collaborationError(err)
	}
	material, err := a.s.ProjectMaterialContent(ctx, in.ID, raw, in.Body.YjsVersion)
	if err != nil {
		return nil, collaborationError(err)
	}
	return &projectMaterialOutput{Body: apimodel.MaterialUpdateResult{
		ID: material.ID, Revision: material.Revision, ContentBytes: len(material.Content),
		NodeCount: material.NodeCount, MaxDepth: material.MaxDepth,
		UpdatedAt: material.UpdatedAt,
	}}, nil
}

func (a *api) listMaterialDiscussions(ctx context.Context, in *materialIDInput) (*discussionsOutput, error) {
	if err := a.s.AssertMaterialCommenter(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	rows, err := a.s.ListCollaborationDiscussions(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	return &discussionsOutput{Body: rows}, nil
}

func (a *api) createMaterialDiscussion(ctx context.Context, in *createDiscussionInput) (*discussionOutput, error) {
	if err := a.s.AssertMaterialCommenter(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	discussion, err := a.s.CreateCommentDiscussion(
		ctx,
		in.ID,
		userID(ctx),
		in.Body.BlockID,
		in.Body.AnchorStart,
		in.Body.AnchorEnd,
		in.Body.AnchorVersion,
		in.Body.AnchorQuote,
		apimodel.EncodeRaw(in.Body.ContentRich),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	a.publishCommentInvalidation(ctx, in.ID)
	return &discussionOutput{Body: discussion}, nil
}

func (a *api) updateMaterialDiscussion(ctx context.Context, in *updateDiscussionInput) (*Empty, error) {
	resource, err := a.s.DiscussionResource(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if err := a.s.AssertMaterialCommenter(ctx, userID(ctx), resource.MaterialID); err != nil {
		return nil, collaborationError(err)
	}
	if err := a.s.SetCollaborationDiscussionResolved(
		ctx, in.ID, userID(ctx), in.Body.IsResolved,
	); err != nil {
		return nil, collaborationError(err)
	}
	a.publishCommentInvalidation(ctx, resource.MaterialID)
	return &Empty{}, nil
}

func (a *api) deleteMaterialDiscussion(ctx context.Context, in *discussionIDInput) (*Empty, error) {
	resource, err := a.s.DiscussionResource(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), resource.MaterialID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if resource.UserID != userID(ctx) && !store.RoleCanEdit(role) {
		return nil, collaborationError(store.ErrForbidden)
	}
	if err := a.s.SoftDeleteDiscussion(ctx, in.ID, userID(ctx)); err != nil {
		return nil, collaborationError(err)
	}
	a.publishCommentInvalidation(ctx, resource.MaterialID)
	return &Empty{}, nil
}

func (a *api) createMaterialComment(ctx context.Context, in *createCommentInput) (*commentOutput, error) {
	resource, err := a.s.DiscussionResource(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if err := a.s.AssertMaterialCommenter(ctx, userID(ctx), resource.MaterialID); err != nil {
		return nil, collaborationError(err)
	}
	comment, err := a.s.AddNestedComment(
		ctx, in.ID, userID(ctx), in.Body.ParentCommentID,
		apimodel.EncodeRaw(in.Body.ContentRich),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	a.publishCommentInvalidation(ctx, resource.MaterialID)
	return &commentOutput{Body: comment}, nil
}

func (a *api) updateMaterialComment(ctx context.Context, in *updateCommentBodyInput) (*commentOutput, error) {
	resource, err := a.s.CommentResource(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if resource.UserID != userID(ctx) {
		return nil, collaborationError(store.ErrForbidden)
	}
	if err := a.s.AssertMaterialCommenter(ctx, userID(ctx), resource.MaterialID); err != nil {
		return nil, collaborationError(err)
	}
	comment, err := a.s.EditOwnComment(
		ctx, in.ID, userID(ctx), apimodel.EncodeRaw(in.Body.ContentRich),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	a.publishCommentInvalidation(ctx, resource.MaterialID)
	return &commentOutput{Body: comment}, nil
}

func (a *api) deleteMaterialComment(ctx context.Context, in *discussionIDInput) (*Empty, error) {
	resource, err := a.s.CommentResource(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), resource.MaterialID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if resource.UserID != userID(ctx) && !store.RoleCanEdit(role) {
		return nil, collaborationError(store.ErrForbidden)
	}
	if err := a.s.SoftDeleteComment(ctx, in.ID, userID(ctx)); err != nil {
		return nil, collaborationError(err)
	}
	a.publishCommentInvalidation(ctx, resource.MaterialID)
	return &Empty{}, nil
}

func (a *api) publishCommentInvalidation(ctx context.Context, materialID string) {
	if a.rdb == nil {
		return
	}
	event := map[string]any{
		"type": "comments-invalidated", "materialId": materialID,
		"at": time.Now().UTC().UnixMilli(),
	}
	if room, err := a.s.MaterialRoom(ctx, materialID); err == nil {
		event["room"] = room
	}
	payload, _ := json.Marshal(event)
	_ = a.rdb.Publish(ctx, "capy:collaboration:comments", payload).Err()
}
