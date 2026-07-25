package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/store"
)

type materialRevisionsOutput struct{ Body []apimodel.MaterialRevision }
type discussionsOutput struct{ Body []apimodel.Discussion }
type discussionOutput struct{ Body apimodel.Discussion }
type commentOutput struct{ Body apimodel.Comment }
type suggestionMutationOutput struct {
	Body apimodel.SuggestionMutationResult
}

type createDiscussionInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateDiscussionReq
}

type discussionIDInput struct {
	ID string `path:"id"`
}

type deleteDiscussionInput struct {
	ID               string `path:"id"`
	ExpectedRevision int64  `query:"expectedRevision,omitempty"`
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

type commitMaterialSuggestionsInput struct {
	ID   string `path:"id"`
	Body apimodel.CommitMaterialSuggestionsReq
}

type reviewMaterialSuggestionsInput struct {
	ID   string `path:"id"`
	Body apimodel.ReviewMaterialSuggestionsReq
}

type deleteMaterialSuggestionInput struct {
	ID               string `path:"id"`
	ExpectedRevision int64  `query:"expectedRevision" minimum:"1"`
}

func (a *api) registerCollaboration(api huma.API) {
	const tag = "Material collaboration"
	reg(api, http.MethodGet, "/api/materials/{id}/revisions", "listMaterialRevisions", tag, "List material revisions", http.StatusOK, a.listMaterialRevisions)
	regWithMaxBody(api, http.MethodPost, "/api/materials/{id}/suggestion-commits", "commitMaterialSuggestions", tag, "Commit marked material suggestions", http.StatusCreated, materialRequestMaxBytes, a.commitMaterialSuggestions)
	regWithMaxBody(api, http.MethodPost, "/api/materials/{id}/suggestions/review", "reviewMaterialSuggestions", tag, "Accept or reject selected or all suggestions", http.StatusOK, materialRequestMaxBytes, a.reviewMaterialSuggestions)
	reg(api, http.MethodDelete, "/api/material-suggestions/{id}", "withdrawMaterialSuggestion", tag, "Withdraw and reject a pending suggestion", http.StatusOK, a.withdrawMaterialSuggestion)
	reg(api, http.MethodGet, "/api/materials/{id}/discussions", "listMaterialDiscussions", tag, "List nested material discussions", http.StatusOK, a.listMaterialDiscussions)
	reg(api, http.MethodPost, "/api/materials/{id}/discussions", "createMaterialDiscussion", tag, "Create a comment discussion", http.StatusCreated, a.createMaterialDiscussion)
	reg(api, http.MethodPatch, "/api/discussions/{id}", "updateMaterialDiscussion", tag, "Resolve or reopen a comment discussion", http.StatusNoContent, a.updateMaterialDiscussion)
	reg(api, http.MethodDelete, "/api/discussions/{id}", "deleteMaterialDiscussion", tag, "Soft-delete a discussion and reject pending marks", http.StatusOK, a.deleteMaterialDiscussion)
	reg(api, http.MethodPost, "/api/discussions/{id}/comments", "createMaterialComment", tag, "Add a comment or one-level reply", http.StatusCreated, a.createMaterialComment)
	reg(api, http.MethodPatch, "/api/comments/{id}", "updateMaterialComment", tag, "Edit an authored comment", http.StatusOK, a.updateMaterialComment)
	reg(api, http.MethodDelete, "/api/comments/{id}", "deleteMaterialComment", tag, "Soft-delete a comment", http.StatusNoContent, a.deleteMaterialComment)
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
		out[i] = apimodel.FromMaterialRevision(revision)
	}
	return &materialRevisionsOutput{Body: out}, nil
}

func (a *api) commitMaterialSuggestions(
	ctx context.Context,
	in *commitMaterialSuggestionsInput,
) (*suggestionMutationOutput, error) {
	if err := a.s.AssertMaterialCommenter(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	raw, err := materialdoc.Marshal(in.Body.Content)
	if err != nil {
		return nil, collaborationError(err)
	}
	result, err := a.s.CommitMaterialSuggestions(
		ctx,
		in.ID,
		userID(ctx),
		raw,
		in.Body.ExpectedRevision,
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	return mutationOutput(result), nil
}

func (a *api) reviewMaterialSuggestions(
	ctx context.Context,
	in *reviewMaterialSuggestionsInput,
) (*suggestionMutationOutput, error) {
	if err := a.s.AssertMaterialEditor(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	result, err := a.s.ReviewMaterialSuggestions(
		ctx,
		in.ID,
		userID(ctx),
		in.Body.Decision,
		in.Body.SuggestionIDs,
		in.Body.ExpectedRevision,
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	return mutationOutput(result), nil
}

func (a *api) withdrawMaterialSuggestion(
	ctx context.Context,
	in *deleteMaterialSuggestionInput,
) (*suggestionMutationOutput, error) {
	resource, err := a.s.SuggestionResource(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), resource.MaterialID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if resource.Status != store.SuggestionPending ||
		(resource.UserID != userID(ctx) && !store.RoleCanEdit(role)) {
		return nil, collaborationError(store.ErrForbidden)
	}
	result, err := a.s.WithdrawMaterialSuggestion(
		ctx,
		in.ID,
		userID(ctx),
		in.ExpectedRevision,
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	return mutationOutput(result), nil
}

func (a *api) listMaterialDiscussions(ctx context.Context, in *materialIDInput) (*discussionsOutput, error) {
	if _, err := a.s.MaterialAccess(ctx, userID(ctx), in.ID); err != nil {
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
		apimodel.EncodeRaw(in.Body.Anchor),
		apimodel.EncodeRaw(in.Body.ContentRich),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
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
	if err := a.s.SetCollaborationDiscussionResolved(ctx, in.ID, in.Body.IsResolved); err != nil {
		return nil, collaborationError(err)
	}
	return &Empty{}, nil
}

func (a *api) deleteMaterialDiscussion(
	ctx context.Context,
	in *deleteDiscussionInput,
) (*suggestionMutationOutput, error) {
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
	var expectedRevision *int64
	if in.ExpectedRevision > 0 {
		expectedRevision = &in.ExpectedRevision
	}
	result, err := a.s.SoftDeleteDiscussion(ctx, in.ID, userID(ctx), expectedRevision)
	if err != nil {
		return nil, collaborationError(err)
	}
	return mutationOutput(result), nil
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
		ctx,
		in.ID,
		userID(ctx),
		in.Body.ParentCommentID,
		apimodel.EncodeRaw(in.Body.ContentRich),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
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
		ctx,
		in.ID,
		userID(ctx),
		apimodel.EncodeRaw(in.Body.ContentRich),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
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
	return &Empty{}, nil
}

func mutationOutput(result store.SuggestionMutation) *suggestionMutationOutput {
	return &suggestionMutationOutput{Body: apimodel.SuggestionMutationResult{
		MaterialUpdateResult: apimodel.MaterialUpdateResult{
			ID:                    result.Material.ID,
			Revision:              result.Material.Revision,
			ContentBytes:          len(result.Material.Content),
			HasPendingSuggestions: result.Material.HasPendingSuggestions,
			UpdatedAt:             result.Material.UpdatedAt,
		},
		SuggestionIDs: result.SuggestionIDs,
		Discussions:   result.Discussions,
	}}
}
