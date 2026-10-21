package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/integrations"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type sourceUploadPolicyOutput struct {
	Body apimodel.SourceUploadPolicy
}

func (a *api) registerSourceUploads(api huma.API) {
	const tag = "Content"
	reg(api, http.MethodGet, "/api/source-upload-policy", "getSourceUploadPolicy", tag, "Get source upload policy", http.StatusOK, a.getSourceUploadPolicy)
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
	maxBytes, err := a.sourceMaxBytes(ctx, userID(ctx))
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
		extensions := extensionsByKind[string(kind)]
		if extensions == nil {
			// unknown has none; the upload dialog reads every kind's array.
			extensions = []string{}
		}
		kinds = append(kinds, apimodel.SourceUploadKindPolicy{
			Kind:       kind,
			Extensions: extensions,
			Text:       textKinds[kind],
		})
	}

	parseModes := []apimodel.SourceUploadParseModePolicy{
		{
			Mode:        sourceupload.ParseModeFast,
			Extensions:  sourceupload.ParseExtensions(sourceupload.ParseModeFast),
			MaxBytes:    maxBytes,
			MaxPages:    a.cfg.ParseMaxPages,
			MaxOCRPages: a.cfg.ParseMaxOCRPages,
		},
		{
			Mode:       sourceupload.ParseModeNone,
			Extensions: []string{},
			MaxBytes:   maxBytes,
		},
	}
	rates, err := a.s.ActiveResourceRates(ctx, []string{
		store.ResourceDigitalParsePage,
		store.ResourceVLMIngestPage,
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
			DigitalParsePageCreditMicros: rates[store.ResourceDigitalParsePage].CreditMicrosPerUnit,
			VLMIngestPageCreditMicros:    rates[store.ResourceVLMIngestPage].CreditMicrosPerUnit,
		},
	}, nil
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

// sourceUploadTicket checks a source upload's metadata and the uploader's
// room, the checks its upload repeats, and takes the upload's ticket
// (upload_queue.go), so a refused upload never waits in line.
func (a *api) sourceUploadTicket(w http.ResponseWriter, r *http.Request) {
	var batch string
	turn, err := a.takeSourceTicket(w, r, &batch)
	if err != nil {
		if status := answerError(w, r, err); batch != "" && status != http.StatusTooManyRequests {
			a.failSourceBatchFile(r.Context(), batch)
		}
		return
	}
	writeJSON(w, http.StatusCreated, turn)
}

func (a *api) takeSourceTicket(w http.ResponseWriter, r *http.Request, batch *string) (uploadTurn, error) {
	ctx := r.Context()
	wsID := id(r)
	maxBytes, err := a.sourceMaxBytes(ctx, uid(r))
	if err != nil {
		return uploadTurn{}, err
	}
	if err := a.assertWorkspaceEditor(ctx, wsID); err != nil {
		return uploadTurn{}, err
	}
	var body apimodel.CreateSourceUploadReq
	if err := readTicketMetadata(w, r, &body); err != nil {
		return uploadTurn{}, err
	}
	if _, _, err := a.checkSourceUpload(ctx, wsID, maxBytes, &body, batch); err != nil {
		return uploadTurn{}, err
	}
	if err := a.s.AssertSourceUploadRoom(ctx, wsID, uid(r), body.SizeBytes); err != nil {
		return uploadTurn{}, err
	}
	return a.uploads.take(uid(r), sourceUploadTarget(wsID), sourceClaim(&body))
}

// sourceClaim is what a source upload's metadata asks for, as its ticket
// keeps it: the trimmed name and the type with its default.
func sourceClaim(body *apimodel.CreateSourceUploadReq) uploadClaim {
	contentType := body.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return uploadClaim{
		name: strings.TrimSpace(string(body.Name)), contentType: contentType,
		batch: body.BatchID, size: body.SizeBytes,
	}
}

// uploadSource streams one source file through the gateway (Epo 2026-10-22;
// see uploads.go): it reserves the uploader's storage, spools and hashes the
// bytes, writes them to their final key in one bounded PUT, and creates the
// file with its first pipeline job. Every kind records its SHA-256.
func (a *api) uploadSource(w http.ResponseWriter, r *http.Request) {
	var batch string
	file, err := a.receiveSource(w, r, &batch)
	if err != nil {
		// A refused upload is a failed file of its batch, except a 429 the
		// browser retries (withUploadRetry).
		if status := a.failUpload(w, r, err); batch != "" && status != http.StatusTooManyRequests {
			a.failSourceBatchFile(r.Context(), batch)
		}
		return
	}
	writeJSON(w, http.StatusCreated, file)
}

func (a *api) openSourceBatch(ctx context.Context, wsID, source, batchID string, total int) error {
	err := a.s.OpenSourceBatch(ctx, batchID, wsID, userID(ctx), source, total)
	if errors.Is(err, store.ErrConflict) {
		return huma.Error409Conflict("batch id belongs to another submission")
	}
	return hErr(err)
}

func (a *api) failSourceBatchFile(ctx context.Context, batchID string) {
	if err := a.s.FailSourceBatchFile(context.WithoutCancel(ctx), batchID); err != nil {
		log.Printf("count refused source in batch %s: %v", batchID, err)
	}
}

func errorStatus(err error) int {
	var status huma.StatusError
	if errors.As(err, &status) {
		return status.GetStatus()
	}
	return http.StatusInternalServerError
}

var batchIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// receiveSource stores one streamed source upload; batch names the upload's
// batch once it is open. An upload refused for its ticket, before its body
// is read, is settled by its batch's idle sweep (store.SourceBatchIdle).
func (a *api) receiveSource(w http.ResponseWriter, r *http.Request, batch *string) (store.File, error) {
	ctx := r.Context()
	wsID := id(r)
	claim, release, err := a.uploads.start(r.URL.Query().Get("ticket"), uid(r), sourceUploadTarget(wsID))
	if err != nil {
		return store.File{}, err
	}
	defer release()
	maxBytes, err := a.sourceMaxBytes(ctx, uid(r))
	if err != nil {
		return store.File{}, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+uploadMetadataMaxBytes)
	if a.blob == nil {
		return store.File{}, errors.New("blob store not configured")
	}
	if err := a.assertWorkspaceEditor(ctx, wsID); err != nil {
		return store.File{}, err
	}
	var body apimodel.CreateSourceUploadReq
	stream, err := readUploadMetadata(w, r, &body)
	if err != nil {
		return store.File{}, err
	}
	// The ticket's batch counts a mismatch, which the upload's own does not
	// reach.
	if err := claim.matches(sourceClaim(&body)); err != nil {
		*batch = claim.batch
		return store.File{}, err
	}
	name, chapterName, err := a.checkSourceUpload(ctx, wsID, maxBytes, &body, batch)
	if err != nil {
		return store.File{}, err
	}

	uploadID := randID("up")
	_, key := sourceObjectKeys(uploadID, name)
	if _, err := a.s.CreateUploadSession(ctx, store.NewUploadSession{
		ID: uploadID, WorkspaceID: wsID, CreatedBy: uid(r),
		ChapterID: body.ChapterID, ChapterName: chapterName,
		ObjectPath: key, FinalPath: key, Name: name, Kind: body.Kind,
		ContentType: body.ContentType, DeclaredSize: body.SizeBytes,
		ParseMode: body.ParseMode,
		ExpiresAt: time.Now().UTC().Add(uploadSessionTTL), BatchID: body.BatchID,
	}); err != nil {
		return store.File{}, err
	}
	file, err := a.storeSourceBytes(ctx, stream, uploadID, key, body.ContentType, body.SizeBytes)
	if err != nil {
		// A failed upload is charged nothing; the release also queues the key
		// for the reaper, which deletes it once nothing references it.
		if err := a.s.MarkUploadExpired(context.WithoutCancel(ctx), uploadID); err != nil {
			log.Printf("release failed upload %s: %v", uploadID, err)
		}
		return store.File{}, err
	}
	log.Printf("source upload stored upload=%s workspace=%s file=%s bytes=%d",
		uploadID, wsID, file.ID, body.SizeBytes)
	return file, nil
}

// checkSourceUpload checks a source upload's metadata for its ticket and
// again for its upload, filling in the inferred kind and parse mode and the
// default content type, and returns the trimmed file and chapter names.
// batch names the upload's batch once it is open.
func (a *api) checkSourceUpload(
	ctx context.Context, wsID string, maxBytes int64, body *apimodel.CreateSourceUploadReq, batch *string,
) (name, chapterName string, err error) {
	// The bounds the JSON schema applied when the metadata was its own request.
	if !batchIDPattern.MatchString(body.BatchID) || body.BatchTotal < 1 || body.BatchTotal > 10000 ||
		body.EstimatedCreditMicros < 0 ||
		utf8.RuneCountInString(string(body.Name)) > fieldlimits.FileName ||
		utf8.RuneCountInString(string(body.ChapterName)) > fieldlimits.ChapterName {
		return "", "", huma.Error422UnprocessableEntity("validation failed")
	}
	if err := a.openSourceBatch(ctx, wsID, "upload", body.BatchID, body.BatchTotal); err != nil {
		return "", "", err
	}
	*batch = body.BatchID
	name = strings.TrimSpace(string(body.Name))
	chapterName = strings.TrimSpace(string(body.ChapterName))
	if name == "" {
		return "", "", huma.Error400BadRequest("file name is required")
	}
	if body.ChapterID != nil && chapterName != "" {
		return "", "", huma.Error400BadRequest("chapterId and chapterName cannot both be set")
	}
	if body.Kind == "" {
		body.Kind = kindFromName(name)
	}
	if body.ParseMode == "" {
		body.ParseMode = sourceupload.DefaultParseMode(name, body.Kind)
	}
	if err := sourceupload.Validate(name, body.Kind, body.ParseMode, body.SizeBytes, maxBytes); err != nil {
		return "", "", huma.Error400BadRequest(err.Error())
	}
	if err := a.checkParsePages(body.ParseMode, body.PageCount); err != nil {
		return "", "", err
	}
	if sourceupload.NeedsIngestJob(name, body.Kind, body.ParseMode) {
		if err := a.s.AssertCreditsForEstimate(ctx, userID(ctx), body.EstimatedCreditMicros); err != nil {
			return "", "", err
		}
	}
	if body.ChapterID != nil {
		chapterWorkspace, err := a.s.ChapterWorkspaceID(ctx, *body.ChapterID)
		if err != nil || chapterWorkspace != wsID {
			return "", "", huma.Error400BadRequest("chapter does not belong to this workspace")
		}
	}
	if body.ContentType == "" {
		body.ContentType = "application/octet-stream"
	}
	if _, _, err := mime.ParseMediaType(body.ContentType); err != nil || strings.ContainsAny(body.ContentType, "\r\n") {
		return "", "", huma.Error400BadRequest("invalid content type")
	}
	return name, chapterName, nil
}

// storeSourceBytes spools the file part, writes it in one PUT and finalizes the
// reserved upload. Once the bytes are stored, finalize runs to its end even if
// the browser leaves, so a committed file is never reported (and released) as
// failed.
func (a *api) storeSourceBytes(ctx context.Context, stream *uploadBody, uploadID, key, contentType string, size int64) (store.File, error) {
	spool, sha, err := spoolUpload(stream, size, contentType)
	if err != nil {
		return store.File{}, err
	}
	defer dropSpool(spool)
	etag, err := putUpload(ctx, a.blob, uploadID, key, spool, contentType)
	if err != nil {
		return store.File{}, err
	}
	return a.s.FinalizeUploadSession(context.WithoutCancel(ctx), userID(ctx), uploadID, etag, sha, a.parser)
}

var errStoredSourceChanged = errors.New("uploaded object changed during completion")

// storedSourceSHA256 hashes a completed drive import's stored object once, for
// a file with source sessions (Office and text), so every session names its
// SHA-256 from the first open (Epo 2026-10-17); a file without them is not read
// (""). The gateway hashes the bytes itself: B2's documented PutObject verifies
// no client-sent checksum, and the collaboration server checks every original
// it loads against this SHA. Browser uploads hash as they stream instead.
func storedSourceSHA256(ctx context.Context, objects blob.Store, name, kind, path string, size int64) (string, error) {
	if store.SourceEditFormat(name, kind) == "" {
		return "", nil
	}
	body, err := objects.Open(ctx, path)
	if err != nil {
		return "", err
	}
	defer body.Close()
	hash := sha256.New()
	read, err := io.Copy(hash, io.LimitReader(body, size+1))
	if err != nil {
		return "", err
	}
	if read != size {
		return "", errStoredSourceChanged
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// promoteMatchingObject treats a matching stable object as success when another
// completion request wins the incoming-object promotion race.
func promoteMatchingObject(
	ctx context.Context,
	objects blob.Store,
	incomingPath, stablePath string,
	expectedSize int64,
	expectedContentType string,
	incoming blob.ObjectInfo,
) (blob.ObjectInfo, error) {
	if err := objects.Promote(ctx, incomingPath, stablePath); err != nil {
		stable, headErr := objects.Head(ctx, stablePath)
		if headErr != nil || stable.Size != expectedSize ||
			stable.ContentType == "" || stable.ContentType != expectedContentType {
			return blob.ObjectInfo{}, err
		}
		return stable, nil
	}
	return incoming, nil
}

func (a *api) importSources(ctx context.Context, in *importSourcesInput) (*sourceImportOutput, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.openSourceBatch(ctx, in.ID, "import", in.Body.BatchID, in.Body.BatchTotal); err != nil {
		return nil, err
	}
	out, err := a.queueSourceImports(ctx, in)
	// A refused request is a failed item of its batch. The browser retries
	// 408, 429 and 5xx (withSourceImportRequestRetry); an item whose retries
	// run out is left to the idle sweep.
	if status := errorStatus(err); err != nil && status < 500 &&
		status != http.StatusRequestTimeout && status != http.StatusTooManyRequests {
		a.failSourceBatchFile(ctx, in.Body.BatchID)
	}
	return out, err
}

func (a *api) queueSourceImports(ctx context.Context, in *importSourcesInput) (*sourceImportOutput, error) {
	actor := userID(ctx)
	wsID := in.ID
	if len(in.Body.FileIds) == 0 {
		return nil, huma.Error400BadRequest("provider and fileIds required")
	}
	chapterName := strings.TrimSpace(string(in.Body.ChapterName))
	in.Body.ParseMode = strings.ToLower(strings.TrimSpace(in.Body.ParseMode))
	if in.Body.ChapterID != nil && chapterName != "" {
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
	if in.Body.Provider != integrations.ProviderGoogle &&
		in.Body.Provider != integrations.ProviderMicrosoft {
		return nil, huma.Error400BadRequest("unknown provider")
	}
	for _, ref := range refs {
		if strings.TrimSpace(ref.ID) == "" {
			return nil, huma.Error400BadRequest("fileIds cannot contain empty ids")
		}
	}
	if in.Body.ChapterID != nil && strings.TrimSpace(*in.Body.ChapterID) == "" {
		return nil, huma.Error400BadRequest("chapterId cannot be empty")
	}
	fingerprintBody, err := json.Marshal(struct {
		ChapterID   *string
		ChapterName string
		ParseMode   string
		Provider    string
		Refs        []integrations.ImportRef
	}{
		ChapterID:   in.Body.ChapterID,
		ChapterName: chapterName,
		ParseMode:   in.Body.ParseMode,
		Provider:    in.Body.Provider,
		Refs:        refs,
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
	if a.cfg.PipelineSecret == "" {
		return nil, huma.Error503ServiceUnavailable("source import worker is not configured")
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
	tok, err := integrations.ClerkAccessToken(ctx, actor, in.Body.Provider)
	if errors.Is(err, integrations.ErrNotConnected) {
		return nil, huma.Error400BadRequest(in.Body.Provider + " account not connected")
	}
	if err != nil {
		return nil, hErr(err)
	}
	maxBytes, err := a.sourceMaxBytes(ctx, userID(ctx))
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
		if meta.Name == "" || utf8.RuneCountInString(meta.Name) > fieldlimits.FileName {
			rejected = append(rejected, apimodel.SourceImportRejected{
				FileID: ref.ID,
				Code:   "invalid_name",
			})
			continue
		}
		reservedSize := int64(0)
		if meta.Size != nil {
			reservedSize = *meta.Size
		} else if meta.ExportMIME != "" {
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
			mode = sourceupload.DefaultParseMode(meta.Name, kind)
		}
		if err := sourceupload.Validate(meta.Name, kind, mode, reservedSize, maxBytes); err != nil {
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

		uploadID := randID("up")
		jobID := randID("imp")
		incoming, finalPath := sourceObjectKeys(uploadID, meta.Name)
		pending = append(pending, store.NewSourceImport{
			JobID: jobID,
			Upload: store.NewUploadSession{
				ID: uploadID, WorkspaceID: wsID, CreatedBy: actor,
				ChapterID: in.Body.ChapterID, ChapterName: chapterName,
				ObjectPath: incoming,
				FinalPath:  finalPath,
				Name:       meta.Name, Kind: kind, ContentType: contentType,
				DeclaredSize: reservedSize, ParseMode: mode,
				// Four import attempts of CAPY_IMPORT_JOB_TIMEOUT fit inside an
				// hour; the upload sweeper then frees a reservation whose worker
				// died with its budget spent.
				ExpiresAt: time.Now().UTC().Add(time.Hour),
			},
			Provider: in.Body.Provider, ProviderFileID: ref.ID,
			ProviderDriveID: ref.DriveID, MaxBytes: maxBytes,
			IdempotencyKey: fmt.Sprintf("%s:%d", requestID, index),
			TraceID:        obs.TraceID(ctx),
		})
	}
	if needsCredits {
		// Imports stay on the plain exhaustion check; the 1.3× estimate
		// headroom applies to new uploads only (decision 2026-09-11).
		if err := a.s.AssertCreditsAvailable(ctx, actor); err != nil {
			return nil, hErr(err)
		}
	}
	jobs := make([]apimodel.SourceImportAccepted, 0, len(pending))
	for _, job := range pending {
		jobs = append(jobs, apimodel.SourceImportAccepted{
			JobID: job.JobID, UploadID: job.Upload.ID, Name: job.Upload.Name,
		})
	}
	response := apimodel.ImportSourcesAccepted{
		Jobs: jobs, Rejected: rejected,
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, hErr(err)
	}
	stored, err := a.s.CreateSourceImportsAndCompleteRequest(
		ctx, actor, wsID, requestID, fingerprint, pending, in.Body.BatchID,
		len(rejected), encoded,
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

// checkParsePages refuses a fast parse the browser counted past the parser's
// page cap. The count is the client's claim; the parser enforces the cap on
// the real document either way.
func (a *api) checkParsePages(parseMode string, pages int) error {
	if pages < 0 {
		return huma.Error400BadRequest("pageCount must not be negative")
	}
	if parseMode == sourceupload.ParseModeFast && pages > a.cfg.ParseMaxPages {
		return huma.Error400BadRequest(fmt.Sprintf("fast parsing reads at most %d pages per file", a.cfg.ParseMaxPages))
	}
	return nil
}

// sourceMaxBytes is the per-file cap of the uploader's plan: the uploader
// pays (Sam 2026-10-18).
func (a *api) sourceMaxBytes(ctx context.Context, uploaderID string) (int64, error) {
	limits, err := a.s.PayerPlanLimits(ctx, uploaderID)
	if err != nil {
		return 0, err
	}
	return limits.SourceFileBytes, nil
}
