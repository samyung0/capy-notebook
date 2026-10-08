package httpapi

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

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
	// read is the downgrade an editor gets when a frozen or locked account (their
	// own, or the storage owner's) makes the material read-only, or the storage
	// owner is at its limit (view-only).
	Access    string `json:"access" enum:"write,read"`
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
	// A projectMaterialReq the handler decodes itself (decodeProjectionBody).
	RawBody []byte
}

type projectMaterialOutput struct {
	Body apimodel.MaterialUpdateResult
}

func (a *api) registerCollaboration(api huma.API) {
	a.registerSourceDocuments(api)
	const tag = "Material collaboration"
	reg(api, http.MethodGet, "/api/materials/{id}/discussions", "listMaterialDiscussions", tag, "List nested material comment discussions", http.StatusOK, a.listMaterialDiscussions)
	reg(api, http.MethodPost, "/api/materials/{id}/discussions", "createMaterialDiscussion", tag, "Create a comment discussion", http.StatusCreated, a.createMaterialDiscussion)
	reg(api, http.MethodDelete, "/api/discussions/{id}", "deleteMaterialDiscussion", tag, "Soft-delete a comment discussion", http.StatusNoContent, a.deleteMaterialDiscussion)
	reg(api, http.MethodPost, "/api/discussions/{id}/comments", "createMaterialComment", tag, "Add a comment to a discussion", http.StatusCreated, a.createMaterialComment)
	reg(api, http.MethodPatch, "/api/comments/{id}", "updateMaterialComment", tag, "Edit an authored comment", http.StatusOK, a.updateMaterialComment)
	reg(api, http.MethodDelete, "/api/comments/{id}", "deleteMaterialComment", tag, "Soft-delete a comment", http.StatusNoContent, a.deleteMaterialComment)
	reg(api, http.MethodPost, "/api/materials/{id}/collaboration-token", "createMaterialCollaborationToken", tag, "Create a short-lived material room token", http.StatusCreated, a.createMaterialCollaborationToken)
	// The handler decodes the 2 MiB body once (decodeProjectionBody, then
	// materialdoc.NewProjection) instead of Huma decoding it twice, into a
	// generic value for schema validation and then into the struct. The
	// collaboration service gives up after 15 s.
	const projectionPath = "/internal/collaboration/materials/{id}/projection"
	regWithMaxBody(api, http.MethodPost, projectionPath, "projectMaterialYjsDocument", tag, "Project a durably stored Yjs document", http.StatusOK, materialRequestMaxBytes, a.projectMaterialYjsDocument, func(op *huma.Operation) {
		op.SkipValidateBody = true
		op.BodyReadTimeout = 15 * time.Second
		// Documented as the JSON it must hold, as a Body field would be.
		op.RequestBody = &huma.RequestBody{Content: map[string]*huma.MediaType{
			"application/json": {Schema: api.OpenAPI().Components.Schemas.Schema(reflect.TypeOf(projectMaterialReq{}), true, "")},
		}}
	})
	// RawBody also documents a raw byte body the route does not take.
	delete(api.OpenAPI().Paths[projectionPath].Post.RequestBody.Content, "application/octet-stream")
	reg(api, http.MethodPost, "/internal/collaboration/materials/{id}/index", "requestMaterialIndex", tag, "Queue a dirty idle note for retrieval indexing", http.StatusAccepted, a.requestMaterialIndex)
	reg(api, http.MethodPost, "/internal/collaboration/materials/{id}/children", "adoptMaterialChildren", tag, "Make the images and quiz or flashcard blocks an update brought in the material's own", http.StatusOK, a.adoptMaterialChildren)
}

// materialChildBlock is one quiz or flashcard block an update wrote.
type materialChildBlock struct {
	MaterialID string `json:"materialId" minLength:"1"`
	// Copy asks for a copy of the material's own row too, for a block whose
	// quiz another block keeps.
	Copy bool `json:"copy,omitempty"`
}

type materialChildrenInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	Body   struct {
		// ActorUserID is the user whose connection sent the update (or whose
		// AI edit or Undo brought the ids back); copies check their access.
		ActorUserID string               `json:"actorUserId" minLength:"1"`
		AssetIDs    []string             `json:"assetIds" maxItems:"50" nullable:"false"`
		Materials   []materialChildBlock `json:"materials" maxItems:"20" nullable:"false"`
	}
}

type adoptedMaterialChild struct {
	SourceID string `json:"sourceId"`
	// ID is the material's own child, "" when the block or node goes.
	ID string `json:"id"`
}

type materialChildrenOutput struct {
	Body struct {
		Assets    []adoptedMaterialChild `json:"assets" nullable:"false"`
		Materials []adoptedMaterialChild `json:"materials" nullable:"false"`
		// StorageRefused: a copy did not fit the payer's storage; its block goes
		// and the user who pasted is told.
		StorageRefused bool `json:"storageRefused"`
	}
}

// adoptMaterialChildren answers the collaboration service's pass over the
// asset and quiz or flashcard ids an update brought into a material room
// (collaboration/src/children.ts): the material's own child keeps its id and
// leaves the trash, another material's child the actor can read becomes a
// copy, and anything else (unreadable, purged, unknown) gets "".
func (a *api) adoptMaterialChildren(ctx context.Context, in *materialChildrenInput) (*materialChildrenOutput, error) {
	if err := a.checkSourceSecret(ctx, in.Secret); err != nil {
		return nil, err
	}
	actor := in.Body.ActorUserID
	if err := a.s.AssertMaterialEditor(ctx, actor, in.ID); err != nil {
		return nil, hErr(err)
	}
	out := &materialChildrenOutput{}
	out.Body.Assets = []adoptedMaterialChild{}
	out.Body.Materials = []adoptedMaterialChild{}
	if len(in.Body.AssetIDs) > 0 {
		workspaceID, study, err := a.s.EditorAssetMaterial(ctx, in.ID)
		if err != nil {
			return nil, hErr(err)
		}
		var imageMaxBytes int64
		if study {
			imageMaxBytes = studyImageMaxBytes
		}
		adopted, refused, err := a.s.AdoptEditorAssets(ctx, actor, workspaceID, in.ID, in.Body.AssetIDs, imageMaxBytes)
		if err != nil {
			return nil, hErr(err)
		}
		out.Body.StorageRefused = refused
		for _, id := range in.Body.AssetIDs {
			out.Body.Assets = append(out.Body.Assets, adoptedMaterialChild{SourceID: id, ID: adopted[id]})
		}
	}
	if len(in.Body.Materials) > 0 {
		blocks := make([]store.EmbeddedAdoption, len(in.Body.Materials))
		for i, block := range in.Body.Materials {
			blocks[i] = store.EmbeddedAdoption{SourceID: block.MaterialID, Copy: block.Copy}
		}
		adopted, refused, err := a.s.AdoptEmbeddedMaterials(ctx, actor, in.ID, blocks)
		if err != nil {
			return nil, hErr(err)
		}
		out.Body.StorageRefused = out.Body.StorageRefused || refused
		for i, block := range blocks {
			out.Body.Materials = append(out.Body.Materials, adoptedMaterialChild{SourceID: block.SourceID, ID: adopted[i]})
		}
	}
	return out, nil
}

type materialIndexInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
}
type materialIndexOutput struct {
	Body struct {
		JobID string `json:"jobId"`
	}
}

func (a *api) requestMaterialIndex(ctx context.Context, in *materialIndexInput) (*materialIndexOutput, error) {
	if err := a.checkSourceSecret(ctx, in.Secret); err != nil {
		return nil, err
	}
	jobID, err := a.s.RequestMaterialIndex(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	out := &materialIndexOutput{}
	out.Body.JobID = jobID
	return out, nil
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
	if !store.RoleCanEdit(role) {
		// Viewers render statically and never join the room.
		return nil, collaborationError(store.ErrForbidden)
	}
	access := "write"
	// The room token is the collaboration server's only source of truth for what
	// a connection may do, so lifecycle restrictions have to be resolved here.
	// Tokens are short-lived, which bounds how long a stale grant survives.
	//
	// The role above decided that this user may write. A frozen or locked
	// account on either side leaves the room read-only: a frozen actor edits
	// nowhere, and nobody edits what a frozen owner pays for. An owner at its
	// storage limit makes the material view-only too.
	owner, err := a.s.MaterialOwnerAccess(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	actor, err := a.s.AccountAccess(ctx, uid)
	if err != nil {
		return nil, collaborationError(err)
	}
	full, err := a.ownerFull(ctx, owner.UserID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if !owner.CanEdit() || !actor.CanEdit() || full {
		access = "read"
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
	obs.ContinueInternalRetry(ctx)
	body, err := decodeProjectionBody(in.RawBody)
	if err != nil {
		return nil, err
	}
	projection, err := materialdoc.NewProjection(body.Content)
	if err != nil {
		return nil, collaborationError(err)
	}
	material, err := a.s.ProjectMaterialContent(ctx, in.ID, projection, body.YjsVersion)
	if err != nil {
		return nil, collaborationError(err)
	}
	return &projectMaterialOutput{Body: apimodel.MaterialUpdateResult{
		ID: material.ID, Revision: material.Revision, ContentBytes: int(material.SizeBytes),
		NodeCount: material.NodeCount, MaxDepth: material.MaxDepth,
		UpdatedAt: material.UpdatedAt,
	}}, nil
}

// decodeProjectionBody reads the projection body once and refuses what Huma's
// schema validation refused before the route skipped it, with Huma's codes:
// 400 for malformed JSON, 422 for a missing, null, unknown or mistyped field
// or a yjsVersion below 1. Field names match regardless of case and the
// documented `$schema` link is ignored, as with Huma; `value` may be null, as
// its schema allows. materialdoc then checks the document itself (400).
func decodeProjectionBody(raw []byte) (projectMaterialReq, error) {
	invalid := func(message string) (projectMaterialReq, error) {
		return projectMaterialReq{}, huma.Error422UnprocessableEntity(message)
	}
	// One null node stands in for `value`: a decoded array replaces it, null
	// clears it, and a missing field leaves it to be refused like a null node.
	nodes := []map[string]any{nil}
	var body struct {
		Schema  json.RawMessage `json:"$schema"`
		Content struct {
			SchemaVersion *int              `json:"schemaVersion"`
			Value         *[]map[string]any `json:"value"`
		} `json:"content"`
		YjsVersion *int64 `json:"yjsVersion"`
	}
	body.Content.Value = &nodes
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	// The decoder scans the whole object before decoding it, so a syntax
	// error anywhere wins over a field error, as with Huma.
	err := decoder.Decode(&body)
	var syntax *json.SyntaxError
	malformed := errors.As(err, &syntax) || errors.Is(err, io.ErrUnexpectedEOF)
	if err == nil {
		_, end := decoder.Token()
		malformed = end != io.EOF // anything after the object
	}
	if malformed {
		return projectMaterialReq{}, huma.Error400BadRequest("malformed JSON body")
	}
	if err != nil {
		return invalid(err.Error())
	}
	if body.YjsVersion == nil || *body.YjsVersion < 1 {
		return invalid("yjsVersion must be an integer of at least 1")
	}
	if body.Content.SchemaVersion == nil {
		return invalid("content.schemaVersion is required")
	}
	req := projectMaterialReq{YjsVersion: *body.YjsVersion}
	req.Content.SchemaVersion = *body.Content.SchemaVersion
	if body.Content.Value != nil {
		req.Content.Value = *body.Content.Value
	}
	for _, node := range req.Content.Value {
		if node == nil {
			return invalid("content.value must be an array of objects")
		}
	}
	return req, nil
}

func (a *api) listMaterialDiscussions(ctx context.Context, in *materialIDInput) (*discussionsOutput, error) {
	if err := a.s.AssertMaterialEditor(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	rows, err := a.s.ListCollaborationDiscussions(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	return &discussionsOutput{Body: rows}, nil
}

func (a *api) createMaterialDiscussion(ctx context.Context, in *createDiscussionInput) (*discussionOutput, error) {
	if err := a.s.AssertMaterialEditor(ctx, userID(ctx), in.ID); err != nil {
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

func (a *api) deleteMaterialDiscussion(ctx context.Context, in *discussionIDInput) (*Empty, error) {
	resource, err := a.s.DiscussionResource(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), resource.MaterialID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if resource.UserID != userID(ctx) && role != store.RoleOwner {
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
	if err := a.s.AssertMaterialEditor(ctx, userID(ctx), resource.MaterialID); err != nil {
		return nil, collaborationError(err)
	}
	comment, err := a.s.AddComment(
		ctx, in.ID, userID(ctx), apimodel.EncodeRaw(in.Body.ContentRich),
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
	if err := a.s.AssertMaterialEditor(ctx, userID(ctx), resource.MaterialID); err != nil {
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
	if resource.UserID != userID(ctx) && role != store.RoleOwner {
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
