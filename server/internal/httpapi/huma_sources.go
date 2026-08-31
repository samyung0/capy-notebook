package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/obs"
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
	regWithMaxBody(api, http.MethodPost, "/api/files/{id}/replacement-uploads", "createFileReplacementUpload", tag, "Reserve a direct file replacement", http.StatusCreated, 64<<10, a.createFileReplacementUpload)
	reg(api, http.MethodPost, "/api/files/{id}/replacement-uploads/{uploadId}/complete", "completeFileReplacementUpload", tag, "Complete a direct file replacement", http.StatusOK, a.completeFileReplacementUpload)
	reg(api, http.MethodPost, "/api/workspaces/{id}/sources/import", "importSources", tag, "Queue sources from a connected drive", http.StatusAccepted, a.importSources)
	regWithMaxBody(api, http.MethodPost, "/api/workspaces/{id}/sources/import-inspect", "inspectSourceImports", tag, "Inspect sources selected from a connected drive", http.StatusOK, 64<<10, a.inspectSourceImports)
	reg(api, http.MethodGet, "/api/workspaces/{id}/sources/imports/{jobId}", "getSourceImport", tag, "Get source import status", http.StatusOK, a.getSourceImport)
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
		store.FileUnknown,
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
	rates, err := a.s.ActiveResourceRates(ctx, []string{
		store.ResourceAudioSecond,
		store.ResourceDigitalParsePage,
		store.ResourceOCRParsePage,
	})
	if err != nil {
		return nil, hErr(err)
	}

	return &sourceUploadPolicyOutput{
		Body: apimodel.SourceUploadPolicy{
			Kinds:      kinds,
			ParseModes: parseModes,
			// An empty accept filter lets the native picker select unrecognized
			// formats. The server still owns the size cap and stores those as
			// kind=unknown with no ingest job.
			Accept:                       "",
			MaxBytes:                     maxBytes,
			AllowNoExtension:             true,
			AudioSecondCreditMicros:      rates[store.ResourceAudioSecond].CreditMicrosPerUnit,
			AudioMaxDurationSeconds:      10 * 60 * 60,
			DigitalParsePageCreditMicros: rates[store.ResourceDigitalParsePage].CreditMicrosPerUnit,
			OCRParsePageCreditMicros:     rates[store.ResourceOCRParsePage].CreditMicrosPerUnit,
		},
	}, nil
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

type createFileReplacementUploadInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateFileReplacementUploadReq
}

type completeFileReplacementUploadInput struct {
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

type sourceImportOutput struct {
	Body apimodel.ImportSourcesAccepted
}

type sourceImportStatusInput struct {
	ID    string `path:"id"`
	JobID string `path:"jobId"`
}

type sourceImportStatusOutput struct {
	Body apimodel.SourceImportStatus
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
	if sourceupload.NeedsIngestJob(body.Name, body.Kind, body.ParseMode) {
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

func (a *api) createFileReplacementUpload(
	ctx context.Context,
	in *createFileReplacementUploadInput,
) (*sourceUploadReservationOutput, error) {
	if err := a.assertFileEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	workspaceID, err := a.s.FileWorkspaceID(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	maxBytes, err := a.sourceMaxBytes(ctx, workspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	body := in.Body
	if body.SizeBytes < 0 || body.SizeBytes > maxBytes {
		return nil, huma.Error400BadRequest(fmt.Sprintf("uploads support files up to %d MB", maxBytes>>20))
	}
	if body.ExpectedRevision < 1 {
		return nil, huma.Error400BadRequest("expectedRevision must be positive")
	}
	if body.ContentType == "" {
		body.ContentType = "application/octet-stream"
	}
	if _, _, err := mime.ParseMediaType(body.ContentType); err != nil || strings.ContainsAny(body.ContentType, "\r\n") {
		return nil, huma.Error400BadRequest("invalid content type")
	}
	name, kind, parseMode, err := a.s.FileIngestPolicy(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if sourceupload.NeedsIngestJob(name, kind, parseMode) {
		if err := a.s.AssertCreditsAvailable(ctx, userID(ctx)); err != nil {
			return nil, hErr(err)
		}
	}

	uploadID := randID("up")
	blobID := randID("blob")
	incoming := incomingObjectKey(uploadID, blobID)
	finalPath := sourceObjectKey(blobID)
	signed, err := a.blob.PresignPut(ctx, incoming, body.ContentType)
	if err != nil {
		return nil, hErr(err)
	}
	session, err := a.s.CreateReplacementUploadSession(ctx, store.NewReplacementUploadSession{
		ID: uploadID, FileID: in.ID, CreatedBy: userID(ctx),
		ObjectPath: incoming, FinalPath: finalPath, ContentType: body.ContentType,
		DeclaredSize: body.SizeBytes, ExpectedRevision: body.ExpectedRevision,
		ExpiresAt: signed.ExpiresAt,
	})
	if errors.Is(err, store.ErrFileRevisionConflict) || errors.Is(err, store.ErrFileNotReady) {
		return nil, huma.Error409Conflict(err.Error())
	}
	if err != nil {
		return nil, hErr(err)
	}
	if signed.Headers == nil {
		signed.Headers = map[string]string{}
	}
	log.Printf("file replacement reserved upload=%s file=%s bytes=%d revision=%d",
		session.ID, in.ID, session.DeclaredSize, body.ExpectedRevision)
	return &sourceUploadReservationOutput{Body: apimodel.SourceUploadReservation{
		UploadID: session.ID, URL: signed.URL, Method: "PUT",
		Headers: signed.Headers, ExpiresAt: signed.ExpiresAt,
	}}, nil
}

func (a *api) completeFileReplacementUpload(
	ctx context.Context,
	in *completeFileReplacementUploadInput,
) (*sourceFileOutput, error) {
	session, err := a.s.GetReplacementUploadSession(ctx, in.UploadID)
	if err != nil {
		return nil, hErr(err)
	}
	if session.FileID == nil || *session.FileID != in.ID {
		return nil, hErr(store.ErrNotFound)
	}
	if err := a.assertFileEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if session.Status == "completed" {
		res, err := a.s.FinalizeReplacementUploadSession(ctx, in.UploadID, "", a.parser, a.engine)
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
	res, err := a.s.FinalizeReplacementUploadSession(ctx, in.UploadID, info.ETag, a.parser, a.engine)
	if errors.Is(err, store.ErrFileRevisionConflict) || errors.Is(err, store.ErrFileNotReady) {
		_ = a.s.MarkUploadExpired(ctx, in.UploadID)
		return nil, huma.Error409Conflict(err.Error())
	}
	if errors.Is(err, store.ErrUploadExpired) || errors.Is(err, store.ErrUploadState) {
		return nil, huma.Error409Conflict(err.Error())
	}
	if err != nil {
		return nil, hErr(err)
	}
	log.Printf("file replacement completed upload=%s file=%s bytes=%d revision=%d",
		in.UploadID, res.ID, info.Size, res.Revision)
	return &sourceFileOutput{Status: http.StatusOK, Body: res}, nil
}

func (a *api) importSources(ctx context.Context, in *importSourcesInput) (*sourceImportOutput, error) {
	actor := userID(ctx)
	wsID := in.ID
	if err := a.assertWorkspaceEditor(ctx, wsID); err != nil {
		return nil, hErr(err)
	}
	if a.cfg.ImportRelayEnqueueURL == "" || a.cfg.ImportRelaySecret == "" {
		return nil, huma.Error503ServiceUnavailable("source import relay is not configured")
	}
	if len(in.Body.FileIds) == 0 {
		return nil, huma.Error400BadRequest("provider and fileIds required")
	}
	in.Body.ChapterName = strings.TrimSpace(in.Body.ChapterName)
	in.Body.ParseMode = strings.ToLower(strings.TrimSpace(in.Body.ParseMode))
	if in.Body.ChapterID != nil && in.Body.ChapterName != "" {
		return nil, huma.Error400BadRequest("chapterId and chapterName cannot both be set")
	}
	requestID := strings.TrimSpace(in.Body.RequestID)
	if requestID == "" {
		requestID = randID("ireq")
	}
	refs, err := integrations.ZipImportDriveIDs(in.Body.FileIds, in.Body.DriveIds)
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if err := a.s.AssertWorkspaceFileRoom(ctx, wsID, len(refs)); err != nil {
		return nil, hErr(err)
	}
	if in.Body.ChapterID != nil {
		chapterWorkspace, err := a.s.ChapterWorkspaceID(ctx, *in.Body.ChapterID)
		if err != nil || chapterWorkspace != wsID {
			return nil, huma.Error400BadRequest("chapter does not belong to this workspace")
		}
	}
	if in.Body.Provider != integrations.ProviderGoogle &&
		in.Body.Provider != integrations.ProviderMicrosoft {
		return nil, huma.Error400BadRequest("unknown provider")
	}
	fingerprintBody, err := json.Marshal(struct {
		CaptionImages bool
		ChapterID     *string
		ChapterName   string
		ParseMode     string
		Provider      string
		Refs          []integrations.ImportRef
	}{
		CaptionImages: in.Body.CaptionImages,
		ChapterID:     in.Body.ChapterID,
		ChapterName:   in.Body.ChapterName,
		ParseMode:     in.Body.ParseMode,
		Provider:      in.Body.Provider,
		Refs:          refs,
	})
	if err != nil {
		return nil, hErr(err)
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(fingerprintBody))
	replayed, complete, err := a.s.BeginSourceImportRequest(
		ctx, actor, wsID, requestID, fingerprint,
	)
	if errors.Is(err, store.ErrImportIdempotencyConflict) {
		return nil, huma.Error409Conflict("source import request id was reused")
	}
	if err != nil {
		return nil, hErr(err)
	}
	if complete {
		var response apimodel.ImportSourcesAccepted
		if err := json.Unmarshal(replayed, &response); err != nil {
			return nil, hErr(err)
		}
		return &sourceImportOutput{Body: response}, nil
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

	rejected := make([]apimodel.SourceImportRejected, 0)
	pending := make([]store.NewSourceImport, 0, len(refs))
	needsCredits := false
	type metadataResult struct {
		meta integrations.ImportFileMetadata
		err  error
	}
	metadata := make([]metadataResult, len(refs))
	metadataSlots := make(chan struct{}, 4)
	var metadataWait sync.WaitGroup
	for index, ref := range refs {
		metadataWait.Add(1)
		go func() {
			defer metadataWait.Done()
			select {
			case metadataSlots <- struct{}{}:
				defer func() { <-metadataSlots }()
			case <-ctx.Done():
				metadata[index].err = ctx.Err()
				return
			}
			switch in.Body.Provider {
			case integrations.ProviderGoogle:
				metadata[index].meta, metadata[index].err =
					integrations.GetGoogleFileMetadata(ctx, tok, ref.ID)
			case integrations.ProviderMicrosoft:
				metadata[index].meta, metadata[index].err =
					integrations.GetMicrosoftFileMetadata(
						ctx, tok, ref.ID, ref.DriveID,
					)
			}
		}()
	}
	metadataWait.Wait()

	for index, ref := range refs {
		meta := metadata[index].meta
		if err := metadata[index].err; err != nil {
			if ctx.Err() != nil {
				return nil, hErr(ctx.Err())
			}
			if integrations.IsRetryableImportProviderError(err) ||
				(!errors.Is(err, integrations.ErrImportFileUnavailable) &&
					!errors.Is(err, integrations.ErrUnsupportedImportFile)) {
				return nil, huma.Error503ServiceUnavailable(
					"provider metadata is temporarily unavailable",
				)
			}
			code := "provider_file_unavailable"
			if errors.Is(err, integrations.ErrUnsupportedImportFile) {
				code = "unsupported_file"
			}
			rejected = append(rejected, apimodel.SourceImportRejected{
				FileID: ref.ID,
				Code:   code,
			})
			continue
		}
		meta.Name = strings.TrimSpace(meta.Name)
		if meta.Name == "" || len(meta.Name) > 512 {
			rejected = append(rejected, apimodel.SourceImportRejected{
				FileID: ref.ID,
				Code:   "invalid_name",
			})
			continue
		}
		reservedSize := int64(0)
		if meta.Size != nil {
			reservedSize = *meta.Size
		} else if meta.ExportPDF {
			reservedSize = min(maxBytes, integrations.GoogleExportMaxBytes())
		}
		if reservedSize < 0 || reservedSize > maxBytes {
			rejected = append(rejected, apimodel.SourceImportRejected{
				FileID: ref.ID,
				Code:   "file_too_large",
			})
			continue
		}
		kind := integrations.KindFromName(meta.Name)
		mode := in.Body.ParseMode
		if mode == "" {
			mode = defaultParseMode(meta.Name, kind)
		}
		if err := validateParseMode(mode, meta.Name, kind, reservedSize, maxBytes); err != nil {
			rejected = append(rejected, apimodel.SourceImportRejected{
				FileID: ref.ID,
				Code:   "unsupported_file",
			})
			continue
		}
		contentType := strings.TrimSpace(meta.MIMEType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if _, _, err := mime.ParseMediaType(contentType); err != nil ||
			strings.ContainsAny(contentType, "\r\n") {
			contentType = "application/octet-stream"
		}
		if sourceupload.NeedsIngestJob(meta.Name, kind, mode) {
			needsCredits = true
		}
		captionImages := sourceupload.NormalizeCaptionImages(
			kind,
			mode,
			in.Body.CaptionImages,
		)

		uploadID := randID("up")
		jobID := randID("imp")
		blobID := randID("blob")
		ext := strings.ToLower(filepath.Ext(meta.Name))
		if len(ext) > 12 {
			ext = ""
		}
		pending = append(pending, store.NewSourceImport{
			JobID: jobID,
			Upload: store.NewUploadSession{
				ID: uploadID, WorkspaceID: wsID, CreatedBy: actor,
				ChapterID: in.Body.ChapterID, ChapterName: in.Body.ChapterName,
				ObjectPath: incomingObjectKey(uploadID, blobID+ext),
				FinalPath:  sourceObjectKey(blobID + ext),
				Name:       meta.Name, Kind: kind, ContentType: contentType,
				DeclaredSize: reservedSize, ParseMode: mode, CaptionImages: captionImages,
				ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
			},
			Provider: in.Body.Provider, ProviderFileID: ref.ID,
			ProviderDriveID: ref.DriveID, MaxBytes: maxBytes,
			IdempotencyKey: fmt.Sprintf("%s:%d", requestID, index),
			TraceID:        obs.TraceID(ctx),
		})
	}
	if needsCredits {
		if err := a.s.AssertCreditsAvailable(ctx, actor); err != nil {
			return nil, hErr(err)
		}
	}
	created, err := a.s.CreateSourceImports(ctx, pending)
	if err != nil {
		return nil, hErr(err)
	}

	jobs := make([]apimodel.SourceImportAccepted, 0, len(created))
	for _, job := range created {
		jobs = append(jobs, apimodel.SourceImportAccepted{
			JobID: job.ID, UploadID: job.UploadSessionID, Name: job.Name,
		})
	}
	response := apimodel.ImportSourcesAccepted{
		Jobs: jobs, Rejected: rejected,
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, hErr(err)
	}
	stored, err := a.s.CompleteSourceImportRequest(
		ctx, actor, requestID, fingerprint, encoded,
	)
	if errors.Is(err, store.ErrImportIdempotencyConflict) {
		return nil, huma.Error409Conflict("source import request id was reused")
	}
	if err != nil {
		return nil, hErr(err)
	}
	if err := json.Unmarshal(stored, &response); err != nil {
		return nil, hErr(err)
	}
	return &sourceImportOutput{Body: response}, nil
}

func (a *api) getSourceImport(
	ctx context.Context,
	in *sourceImportStatusInput,
) (*sourceImportStatusOutput, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	job, err := a.s.GetSourceImport(ctx, in.ID, in.JobID)
	if err != nil {
		return nil, hErr(err)
	}
	return &sourceImportStatusOutput{Body: apimodel.SourceImportStatus{
		JobID: job.ID, Status: job.Status, Name: job.Name,
		FileID: job.FileID, ErrorCode: job.LastErrorCode,
	}}, nil
}
