package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/sourceupload"
	"github.com/evonotes/server/internal/store"
)

type sourceUploadPolicyOutput struct {
	Body apimodel.SourceUploadPolicy
}

func (a *api) registerSourceUploads(api huma.API) {
	const tag = "Content"
	reg(api, http.MethodGet, "/api/source-upload-policy", "getSourceUploadPolicy", tag, "Get source upload policy", http.StatusOK, a.getSourceUploadPolicy)
	regWithMaxBody(api, http.MethodPost, "/api/workspaces/{id}/sources/uploads", "createSourceUpload", tag, "Reserve a direct source upload", http.StatusCreated, 64<<10, a.createSourceUpload)
	reg(api, http.MethodPost, "/api/workspaces/{id}/sources/uploads/{uploadId}/complete", "completeSourceUpload", tag, "Complete a direct source upload", http.StatusCreated, a.completeSourceUpload)
	reg(api, http.MethodPost, "/api/workspaces/{id}/sources/import", "importSources", tag, "Import sources from a connected drive", http.StatusCreated, a.importSources)
}

type sourceUploadPolicyInput struct {
	WorkspaceID string `query:"workspaceId"`
}

func (a *api) getSourceUploadPolicy(
	ctx context.Context,
	in *sourceUploadPolicyInput,
) (*sourceUploadPolicyOutput, error) {
	if in.WorkspaceID != "" {
		if _, err := a.workspaceRead(ctx, in.WorkspaceID); err != nil {
			return nil, hErr(err)
		}
	}
	maxBytes, err := a.sourceMaxBytes(ctx, in.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	extensionsByKind := sourceupload.ExtensionsByKind()
	kindOrder := []store.FileKind{
		store.FilePDF,
		store.FileDoc,
		store.FileMD,
		store.FileImage,
		store.FileTxt,
		store.FileSheet,
		store.FileSlides,
		store.FileAudio,
		store.FileJson,
	}
	textKinds := map[store.FileKind]bool{
		store.FileMD:   true,
		store.FileTxt:  true,
		store.FileJson: true,
	}
	kinds := make([]apimodel.SourceUploadKindPolicy, 0, len(kindOrder))
	for _, kind := range kindOrder {
		kinds = append(kinds, apimodel.SourceUploadKindPolicy{
			Kind:       kind,
			Extensions: extensionsByKind[string(kind)],
			Text:       textKinds[kind],
		})
	}

	parseModes := []apimodel.SourceUploadParseModePolicy{
		{
			Mode:            sourceupload.ParseModeFast,
			Extensions:      sourceupload.ParseExtensions(sourceupload.ParseModeFast),
			MaxBytes:        maxBytes,
			SupportsFigures: true,
		},
		{
			Mode:       sourceupload.ParseModeNone,
			Extensions: []string{},
			MaxBytes:   maxBytes,
		},
	}
	accept := sourceupload.SupportedExtensions()

	return &sourceUploadPolicyOutput{
		Body: apimodel.SourceUploadPolicy{
			Kinds:            kinds,
			ParseModes:       parseModes,
			Accept:           joinExtensions(accept),
			MaxBytes:         maxBytes,
			AllowNoExtension: false,
		},
	}, nil
}

func joinExtensions(extensions []string) string {
	result := ""
	for i, ext := range extensions {
		if i > 0 {
			result += ","
		}
		result += ext
	}
	return result
}

type createSourceUploadInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateSourceUploadReq
}

type sourceUploadReservationOutput struct {
	Body apimodel.SourceUploadReservation
}

type completeSourceUploadInput struct {
	ID       string `path:"id"`
	UploadID string `path:"uploadId"`
}

type sourceFileOutput struct {
	Status int
	Body   apimodel.File
}

type importSourcesInput struct {
	ID   string `path:"id"`
	Body apimodel.ImportSourcesReq
}

type sourceFilesOutput struct {
	Body []apimodel.File `nullable:"false"`
}

func (a *api) createSourceUpload(ctx context.Context, in *createSourceUploadInput) (*sourceUploadReservationOutput, error) {
	wsID := in.ID
	if err := a.assertWorkspaceEditor(ctx, wsID); err != nil {
		return nil, hErr(err)
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	body := in.Body
	body.Name = strings.TrimSpace(body.Name)
	body.ChapterName = strings.TrimSpace(body.ChapterName)
	if body.Name == "" || len(body.Name) > 512 {
		return nil, huma.Error400BadRequest("file name is required and must be at most 512 characters")
	}
	if len(body.ChapterName) > 255 {
		return nil, huma.Error400BadRequest("chapter name must be at most 255 characters")
	}
	if body.ChapterID != nil && body.ChapterName != "" {
		return nil, huma.Error400BadRequest("chapterId and chapterName cannot both be set")
	}
	if body.Kind == "" {
		body.Kind = kindFromName(body.Name)
	}
	if body.ParseMode == "" {
		body.ParseMode = defaultParseMode(body.Name, body.Kind)
	}
	maxBytes, err := a.sourceMaxBytes(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}
	if body.SizeBytes < 0 || body.SizeBytes > maxBytes {
		return nil, huma.Error400BadRequest(fmt.Sprintf("uploads support files up to %d MB", maxBytes>>20))
	}
	if err := validateParseMode(body.ParseMode, body.Name, body.Kind, body.SizeBytes, maxBytes); err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	body.CaptionImages = sourceupload.NormalizeCaptionImages(body.Kind, body.ParseMode, body.CaptionImages)
	if sourceupload.NeedsIngestJob(body.Kind, body.ParseMode) {
		if err := a.s.AssertCreditsAvailable(ctx, userID(ctx)); err != nil {
			return nil, hErr(err)
		}
	}
	if body.ChapterID != nil {
		chapterWorkspace, err := a.s.ChapterWorkspaceID(ctx, *body.ChapterID)
		if err != nil || chapterWorkspace != wsID {
			return nil, huma.Error400BadRequest("chapter does not belong to this workspace")
		}
	}
	if body.ContentType == "" {
		body.ContentType = "application/octet-stream"
	}
	if _, _, err := mime.ParseMediaType(body.ContentType); err != nil || strings.ContainsAny(body.ContentType, "\r\n") {
		return nil, huma.Error400BadRequest("invalid content type")
	}

	uploadID := randID("up")
	blobID := randID("blob")
	ext := strings.ToLower(filepath.Ext(body.Name))
	if len(ext) > 12 {
		ext = ""
	}
	incoming := incomingObjectKey(uploadID, blobID+ext)
	finalPath := sourceObjectKey(blobID + ext)
	signed, err := a.blob.PresignPut(ctx, incoming, body.ContentType)
	if err != nil {
		return nil, hErr(err)
	}
	session, err := a.s.CreateUploadSession(ctx, store.NewUploadSession{
		ID: uploadID, WorkspaceID: wsID, CreatedBy: userID(ctx),
		ChapterID: body.ChapterID, ChapterName: body.ChapterName,
		ObjectPath: incoming, FinalPath: finalPath, Name: body.Name, Kind: body.Kind,
		ContentType: body.ContentType, DeclaredSize: body.SizeBytes,
		ParseMode: body.ParseMode, CaptionImages: body.CaptionImages,
		ExpiresAt: signed.ExpiresAt,
	})
	if err != nil {
		return nil, hErr(err)
	}
	log.Printf("direct upload reserved upload=%s workspace=%s bytes=%d mode=%s captions=%t",
		session.ID, wsID, session.DeclaredSize, session.ParseMode, session.CaptionImages)
	if signed.Headers == nil {
		signed.Headers = map[string]string{}
	}
	return &sourceUploadReservationOutput{Body: apimodel.SourceUploadReservation{
		UploadID: session.ID, URL: signed.URL, Method: "PUT",
		Headers: signed.Headers, ExpiresAt: signed.ExpiresAt,
	}}, nil
}

func (a *api) completeSourceUpload(ctx context.Context, in *completeSourceUploadInput) (*sourceFileOutput, error) {
	session, err := a.s.GetUploadSession(ctx, in.UploadID)
	if err != nil {
		return nil, hErr(err)
	}
	if session.WorkspaceID != in.ID {
		return nil, hErr(store.ErrNotFound)
	}
	if err := a.assertWorkspaceEditor(ctx, session.WorkspaceID); err != nil {
		return nil, hErr(err)
	}
	if session.Status == "completed" {
		res, err := a.s.FinalizeUploadSession(ctx, in.UploadID, "", a.parser, a.engine)
		if err != nil {
			return nil, hErr(err)
		}
		return &sourceFileOutput{Status: http.StatusOK, Body: res}, nil
	}
	if time.Now().UTC().After(session.ExpiresAt) {
		return nil, &huma.ErrorModel{
			Status: http.StatusGone,
			Title:  http.StatusText(http.StatusGone),
			Detail: store.ErrUploadExpired.Error(),
		}
	}

	info, finalErr := a.blob.Head(ctx, session.FinalPath)
	if finalErr != nil {
		info, err = a.blob.Head(ctx, session.ObjectPath)
		if err != nil {
			return nil, huma.Error409Conflict("uploaded object is not available")
		}
	}
	if info.Size != session.DeclaredSize {
		_ = a.blob.Delete(ctx, session.ObjectPath)
		return nil, huma.Error400BadRequest("uploaded size does not match the reserved size")
	}
	if info.ContentType != "" && info.ContentType != session.ContentType {
		return nil, huma.Error400BadRequest("uploaded content type does not match the reservation")
	}
	if finalErr != nil {
		if err := a.blob.Promote(ctx, session.ObjectPath, session.FinalPath); err != nil {
			return nil, hErr(err)
		}
	}
	res, err := a.s.FinalizeUploadSession(ctx, in.UploadID, info.ETag, a.parser, a.engine)
	if errors.Is(err, store.ErrUploadExpired) || errors.Is(err, store.ErrUploadState) {
		return nil, huma.Error409Conflict(err.Error())
	}
	if err != nil {
		return nil, hErr(err)
	}
	log.Printf("direct upload completed upload=%s file=%s bytes=%d etag=%s",
		in.UploadID, res.ID, info.Size, info.ETag)
	return &sourceFileOutput{Status: http.StatusCreated, Body: res}, nil
}

func (a *api) importSources(ctx context.Context, in *importSourcesInput) (*sourceFilesOutput, error) {
	actor := userID(ctx)
	wsID := in.ID
	if err := a.assertWorkspaceEditor(ctx, wsID); err != nil {
		return nil, hErr(err)
	}
	if len(in.Body.FileIds) == 0 {
		return nil, huma.Error400BadRequest("provider and fileIds required")
	}
	refs, err := integrations.ZipImportDriveIDs(in.Body.FileIds, in.Body.DriveIds)
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if err := a.s.AssertWorkspaceFileRoom(ctx, wsID, len(in.Body.FileIds)); err != nil {
		return nil, hErr(err)
	}
	tok, err := integrations.ClerkAccessToken(ctx, actor, in.Body.Provider)
	if errors.Is(err, integrations.ErrNotConnected) {
		return nil, huma.Error400BadRequest(in.Body.Provider + " account not connected")
	}
	if err != nil {
		return nil, hErr(err)
	}
	maxBytes, err := a.sourceMaxBytes(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}

	created := make([]store.File, 0, len(refs))
	for _, ref := range refs {
		var data []byte
		var name string
		switch in.Body.Provider {
		case integrations.ProviderGoogle:
			data, name, err = integrations.DownloadGoogleFile(tok, ref.ID)
		case integrations.ProviderMicrosoft:
			data, name, err = integrations.DownloadMicrosoftFile(tok, ref.ID, ref.DriveID)
		default:
			return nil, huma.Error400BadRequest("unknown provider")
		}
		if err != nil {
			return nil, hErr(err)
		}
		kind := integrations.KindFromName(name)
		mode := defaultParseMode(name, kind)
		if err := validateParseMode(mode, name, kind, int64(len(data)), maxBytes); err != nil {
			return nil, huma.Error400BadRequest(err.Error())
		}
		if sourceupload.NeedsIngestJob(kind, mode) {
			if err := a.s.AssertCreditsAvailable(ctx, actor); err != nil {
				return nil, hErr(err)
			}
		}
		blobPath, _, err := a.blob.Put(sourceObjectKey(randID("blob")), bytes.NewReader(data))
		if err != nil {
			return nil, hErr(err)
		}
		var f store.File
		if !sourceupload.NeedsIngestJob(kind, mode) {
			f, err = a.s.CreateSourceReady(ctx, wsID, actor, name, kind, in.Body.ChapterID, "", int64(len(data)), blobPath)
		} else {
			f, _, err = a.s.CreateSourceWithJob(ctx, wsID, actor, name, kind, in.Body.ChapterID, "", int64(len(data)), blobPath, a.parser, a.engine, mode, false)
		}
		if err != nil {
			_ = a.blob.Delete(ctx, blobPath)
			return nil, hErr(err)
		}
		created = append(created, f)
	}
	return &sourceFilesOutput{Body: created}, nil
}
