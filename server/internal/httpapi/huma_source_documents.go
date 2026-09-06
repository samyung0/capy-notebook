package httpapi

import (
	"context"
	"crypto/subtle"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type sourceSessionOutput struct{ Body store.SourceSession }
type SourceCollaborationToken struct {
	Token     string `json:"token"`
	Room      string `json:"room"`
	URL       string `json:"url"`
	Access    string `json:"access" enum:"write,read"`
	ExpiresAt int64  `json:"expiresAt"`
	Epoch     int64  `json:"epoch"`
}
type sourceTokenOutput struct{ Body SourceCollaborationToken }
type sourceBootstrapInput struct {
	ID      string `path:"id"`
	Secret  string `header:"X-Collaboration-Secret"`
	ActorID string `query:"actorId"`
}
type sourceAccessInput struct {
	ID      string `path:"id"`
	Secret  string `header:"X-Collaboration-Secret"`
	ActorID string `query:"actorId"`
	Epoch   int64  `query:"epoch" minimum:"1"`
	Edit    bool   `query:"edit"`
}
type sourceCheckpointInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	Body   store.SourceCheckpoint
}
type sourceRefreshInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	Body   struct {
		ActorID   string `json:"actorId"`
		Automatic bool   `json:"automatic"`
	}
}
type sourceProcessOutput struct{ Body store.SourceProcessResult }
type annotationsOutput struct {
	Body []store.PDFAnnotation `nullable:"false"`
}
type annotationOutput struct{ Body store.PDFAnnotation }
type annotationInput struct {
	ID   string `path:"id"`
	Body store.PDFAnnotationBody
}
type annotationUpdateInput struct {
	ID           string `path:"id"`
	AnnotationID string `path:"annotationId"`
	Body         store.PDFAnnotationBody
}
type annotationIDInput struct {
	ID           string `path:"id"`
	AnnotationID string `path:"annotationId"`
}

func (a *api) registerSourceDocuments(api huma.API) {
	const tag = "Source collaboration"
	reg(api, http.MethodGet, "/internal/collaboration/files/{id}/refresh-candidate", "claimSourceRefresh", tag, "Claim a fixed source export", http.StatusOK, a.claimSourceRefresh)
	regWithMaxBody(api, http.MethodPost, "/internal/collaboration/files/{id}/refresh-candidate", "finalizeSourceRefresh", tag, "Enqueue an uploaded candidate", http.StatusNoContent, 150<<20, a.finalizeSourceRefresh)
	regWithMaxBody(api, http.MethodPost, "/internal/collaboration/files/{id}/publish", "publishSourceRefresh", tag, "Publish a processed source checkpoint", http.StatusOK, 150<<20, a.publishSourceRefresh)
	reg(api, http.MethodPost, "/internal/collaboration/files/{id}/refresh-failure", "failSourceRefresh", tag, "Discard an unsuccessful candidate", http.StatusNoContent, a.failSourceRefresh)
	reg(api, http.MethodGet, "/api/files/{id}/source-session", "getSourceSession", tag, "Read source editing session", http.StatusOK, a.getSourceSession)
	reg(api, http.MethodPost, "/api/files/{id}/collaboration-token", "createSourceCollaborationToken", tag, "Create source room token", http.StatusCreated, a.createSourceCollaborationToken)
	reg(api, http.MethodPost, "/api/files/{id}/process-changes", "processSourceChanges", tag, "Process the latest saved source changes", http.StatusAccepted, a.processSourceChanges)
	reg(api, http.MethodGet, "/internal/collaboration/files/{id}/bootstrap", "bootstrapSourceDocument", tag, "Bootstrap an authorized source room", http.StatusOK, a.bootstrapSourceDocument)
	reg(api, http.MethodGet, "/internal/collaboration/files/{id}/access", "checkSourceAccess", tag, "Revalidate source room access", http.StatusNoContent, a.checkSourceAccess)
	regWithMaxBody(api, http.MethodPost, "/internal/collaboration/files/{id}/checkpoint", "checkpointSourceDocument", tag, "Persist an authorized source checkpoint", http.StatusOK, 150<<20, a.checkpointSourceDocument)
	reg(api, http.MethodPost, "/internal/collaboration/files/{id}/refresh", "requestSourceRefresh", tag, "Admit a saved source refresh", http.StatusAccepted, a.requestSourceRefresh)
	reg(api, http.MethodGet, "/api/files/{id}/annotations", "listPDFAnnotations", tag, "Read private PDF annotations", http.StatusOK, a.listPDFAnnotations)
	reg(api, http.MethodPost, "/api/files/{id}/annotations", "createPDFAnnotation", tag, "Create a private PDF annotation", http.StatusCreated, a.createPDFAnnotation)
	reg(api, http.MethodPatch, "/api/files/{id}/annotations/{annotationId}", "updatePDFAnnotation", tag, "Update an authored PDF annotation", http.StatusOK, a.updatePDFAnnotation)
	reg(api, http.MethodDelete, "/api/files/{id}/annotations/{annotationId}", "deletePDFAnnotation", tag, "Delete an authored PDF annotation", http.StatusNoContent, a.deletePDFAnnotation)
}
func (a *api) checkSourceSecret(secret string) error {
	if a.cfg.CollaborationSecret == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(a.cfg.CollaborationSecret)) != 1 {
		return huma.Error401Unauthorized("invalid collaboration service secret")
	}
	return nil
}
func (a *api) sourceSessionResponse(ctx context.Context, session store.SourceSession) (*sourceSessionOutput, error) {
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	url, err := a.blob.PresignGet(ctx, session.BaseBlobPath)
	if err != nil {
		return nil, hErr(err)
	}
	session.SourceURL = url
	return &sourceSessionOutput{Body: session}, nil
}
func (a *api) getSourceSession(ctx context.Context, in *collaborationTokenInput) (*sourceSessionOutput, error) {
	session, err := a.s.SourceSession(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.sourceSessionResponse(ctx, session)
}
func (a *api) bootstrapSourceDocument(ctx context.Context, in *sourceBootstrapInput) (*sourceSessionOutput, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	session, err := a.s.SourceSession(ctx, in.ActorID, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.sourceSessionResponse(ctx, session)
}
func (a *api) checkSourceAccess(ctx context.Context, in *sourceAccessInput) (*struct{}, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	if err := a.s.CheckSourceAccess(ctx, in.ActorID, in.ID, in.Epoch, in.Edit); err != nil {
		return nil, hErr(err)
	}
	return nil, nil
}
func (a *api) checkpointSourceDocument(ctx context.Context, in *sourceCheckpointInput) (*sourceSessionOutput, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	session, err := a.s.SaveSourceCheckpoint(ctx, in.ID, in.Body)
	if err != nil {
		return nil, hErr(err)
	}
	return a.sourceSessionResponse(ctx, session)
}
func (a *api) createSourceCollaborationToken(ctx context.Context, in *collaborationTokenInput) (*sourceTokenOutput, error) {
	session, err := a.s.SourceSession(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	me, err := a.s.Me(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	claims := newCollaborationClaims(userID(ctx), session.Room, session.Access, me.Name, me.AvatarURL, randID("collab"), int(session.Epoch))
	token, err := signCollaborationToken(a.cfg.CollaborationSecret, claims)
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("collaboration service unavailable", err)
	}
	return &sourceTokenOutput{Body: SourceCollaborationToken{Token: token, Room: session.Room, URL: a.cfg.CollaborationURL, Access: session.Access, ExpiresAt: claims.ExpiresAt, Epoch: session.Epoch}}, nil
}
func (a *api) processSourceChanges(ctx context.Context, in *collaborationTokenInput) (*sourceProcessOutput, error) {
	out, err := a.s.RequestSourceRefresh(ctx, userID(ctx), in.ID, false)
	if err != nil {
		return nil, hErr(err)
	}
	return &sourceProcessOutput{Body: out}, nil
}
func (a *api) requestSourceRefresh(ctx context.Context, in *sourceRefreshInput) (*sourceProcessOutput, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	out, err := a.s.RequestSourceRefresh(ctx, in.Body.ActorID, in.ID, in.Body.Automatic)
	if err != nil {
		return nil, hErr(err)
	}
	return &sourceProcessOutput{Body: out}, nil
}
func (a *api) listPDFAnnotations(ctx context.Context, in *collaborationTokenInput) (*annotationsOutput, error) {
	out, err := a.s.ListPDFAnnotations(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &annotationsOutput{Body: out}, nil
}
func (a *api) createPDFAnnotation(ctx context.Context, in *annotationInput) (*annotationOutput, error) {
	out, err := a.s.SavePDFAnnotation(ctx, userID(ctx), in.ID, "", in.Body)
	if err != nil {
		return nil, hErr(err)
	}
	return &annotationOutput{Body: out}, nil
}
func (a *api) updatePDFAnnotation(ctx context.Context, in *annotationUpdateInput) (*annotationOutput, error) {
	out, err := a.s.SavePDFAnnotation(ctx, userID(ctx), in.ID, in.AnnotationID, in.Body)
	if err != nil {
		return nil, hErr(err)
	}
	return &annotationOutput{Body: out}, nil
}
func (a *api) deletePDFAnnotation(ctx context.Context, in *annotationIDInput) (*Empty, error) {
	if err := a.s.DeletePDFAnnotation(ctx, userID(ctx), in.ID, in.AnnotationID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

type sourceCandidateInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	JobID  string `query:"jobId"`
}
type sourceCandidateResponse struct {
	store.SourceRefreshCandidate
	UploadURL     string            `json:"uploadURL"`
	UploadHeaders map[string]string `json:"uploadHeaders"`
}
type sourceCandidateOutput struct{ Body sourceCandidateResponse }
type sourceFinalizeInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	Body   store.SourceRefreshFinalize
}
type sourcePublishInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	Body   store.SourceRefreshPublish
}
type sourceFailureInput struct {
	ID     string `path:"id"`
	Secret string `header:"X-Collaboration-Secret"`
	Body   struct {
		JobID      string `json:"jobId"`
		LeaseToken string `json:"leaseToken"`
		Error      string `json:"error"`
		Stale      bool   `json:"stale"`
	}
}

func (a *api) claimSourceRefresh(ctx context.Context, in *sourceCandidateInput) (*sourceCandidateOutput, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	candidate, err := a.s.ClaimSourceRefresh(ctx, in.ID, in.JobID)
	if err != nil {
		return nil, hErr(err)
	}
	url, err := a.blob.PresignGet(ctx, candidate.BaseBlobPath)
	if err != nil {
		return nil, hErr(err)
	}
	candidate.BaseSourceURL = url
	upload, err := a.blob.PresignPut(ctx, candidate.SourceBlobPath, "application/octet-stream")
	if err != nil {
		return nil, hErr(err)
	}
	return &sourceCandidateOutput{Body: sourceCandidateResponse{SourceRefreshCandidate: candidate, UploadURL: upload.URL, UploadHeaders: upload.Headers}}, nil
}
func (a *api) finalizeSourceRefresh(ctx context.Context, in *sourceFinalizeInput) (*Empty, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	path, err := a.s.SourceCandidateBlob(ctx, in.ID, in.Body.JobID, in.Body.LeaseToken)
	if err != nil {
		return nil, hErr(err)
	}
	info, err := a.blob.Head(ctx, path)
	if err != nil {
		return nil, hErr(err)
	}
	if info.Size != in.Body.SizeBytes || info.ETag != in.Body.SourceETag {
		return nil, huma.Error409Conflict("candidate object changed")
	}
	if err = a.s.FinalizeSourceRefresh(ctx, in.ID, in.Body); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
func (a *api) publishSourceRefresh(ctx context.Context, in *sourcePublishInput) (*sourceSessionOutput, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	out, err := a.s.PublishSourceRefresh(ctx, in.ID, in.Body)
	if err != nil {
		return nil, hErr(err)
	}
	return a.sourceSessionResponse(ctx, out)
}
func (a *api) failSourceRefresh(ctx context.Context, in *sourceFailureInput) (*Empty, error) {
	if err := a.checkSourceSecret(in.Secret); err != nil {
		return nil, err
	}
	if err := a.s.FailSourceRefresh(ctx, in.ID, in.Body.JobID, in.Body.LeaseToken, in.Body.Error, in.Body.Stale); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
