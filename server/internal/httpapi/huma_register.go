package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// humaConfig builds the OpenAPI document metadata. With apiDocs (local
// development only) huma serves the spec at /openapi.yaml, /openapi.json
// (+ 3.0 variants), docs at /docs and schemas at /schemas/*, and links each
// body to its schema with `$schema`. Without it none of those routes exist and
// bodies carry no `$schema` link.
func humaConfig(apiDocs bool) huma.Config {
	config := huma.DefaultConfig("Capy Notebook API", "0.1.0")
	if !apiDocs {
		config.OpenAPIPath, config.DocsPath, config.SchemasPath = "", "", ""
		// DefaultConfig's only create hook adds the `$schema` link transformer.
		config.CreateHooks = nil
	}
	return config
}

// SpecYAML renders the OpenAPI 3.0.3 spec (safest for orval) without a live DB;
// handlers are registered but never executed during spec generation. It keeps
// the local-development config, so schemas list the optional, read-only
// `$schema` field that deployed bodies leave out.
func SpecYAML() ([]byte, error) {
	r := chi.NewRouter()
	api := humachi.New(r, humaConfig(true))
	registerRoutes(api, &api2{})
	return api.OpenAPI().DowngradeYAML()
}

// api2 is an alias so the zero value reads clearly at the SpecYAML call site.
type api2 = api

// userID pulls the authenticated user id from the request context (set by the
// auth middleware on the chi router that huma shares).
func userID(ctx context.Context) string { return auth.UserID(ctx) }

// hErr maps store errors onto huma HTTP errors.
// Forbidden is collapsed to 404 so private/shared resources do not leak existence.
type handlerError struct {
	error
	cause error
}

func (e *handlerError) Unwrap() error  { return e.error }
func (e *handlerError) GetStatus() int { return e.error.(huma.StatusError).GetStatus() }

func hErr(err error) error {
	if err == nil {
		return nil
	}
	return &handlerError{error: mapHTTPError(err), cause: err}
}

// conflictError is a 409 carrying a machine code the browser maps to copy.
func conflictError(code, detail string) error {
	return &huma.ErrorModel{
		Status: http.StatusConflict,
		Title:  http.StatusText(http.StatusConflict),
		Detail: detail,
		Errors: []*huma.ErrorDetail{{Message: code}},
	}
}

// limitError is a 429 carrying a machine code the browser maps to copy.
func limitError(code, detail string) error {
	return &huma.ErrorModel{
		Status: http.StatusTooManyRequests,
		Title:  http.StatusText(http.StatusTooManyRequests),
		Detail: detail,
		Errors: []*huma.ErrorDetail{{Message: code}},
	}
}

// audioTranscribingDetail is the copy for store.ErrAudioTranscribing.
const audioTranscribingDetail = "This recording is still being transcribed; try again when it finishes"

func mapHTTPError(err error) error {
	if err == nil {
		return nil
	}
	for code, rowCap := range map[string]error{
		"comment_limit":    store.ErrTooManyComments,
		"annotation_limit": store.ErrTooManyAnnotations,
		"event_limit":      store.ErrTooManyEvents,
	} {
		if errors.Is(err, rowCap) {
			return conflictError(code, rowCap.Error())
		}
	}
	if errors.Is(err, store.ErrInviteRecentlySent) {
		return limitError("invite_recently_sent", "this address was invited in the last 10 minutes")
	}
	if errors.Is(err, store.ErrInviteLimit) {
		return limitError("invite_limit", "the daily invite limit is reached; it resets at midnight UTC")
	}
	if errors.Is(err, store.ErrAudioTranscribing) {
		return conflictError("audio_transcribing", audioTranscribingDetail)
	}
	if errors.Is(err, store.ErrInvalidCursor) {
		return huma.Error400BadRequest(err.Error())
	}
	// An upload whose session expired (the sweeper) or changed state (its
	// payer changed) while its body streamed.
	if errors.Is(err, store.ErrUploadExpired) || errors.Is(err, store.ErrEditorAssetUploadExpired) {
		return huma.Error410Gone(err.Error())
	}
	if errors.Is(err, store.ErrUploadState) || errors.Is(err, store.ErrEditorAssetUploadState) {
		return huma.Error409Conflict(err.Error())
	}
	var spending *store.SpendingLimitError
	if errors.As(err, &spending) {
		return &huma.ErrorModel{
			Status: http.StatusConflict,
			Title:  http.StatusText(http.StatusConflict),
			Detail: "the monthly spending limit would be exceeded",
			Errors: []*huma.ErrorDetail{{
				Message: "spending_limit",
				Value: map[string]any{
					"limitCents":    spending.LimitCents,
					"spentCents":    spending.SpentCents,
					"chargingCents": spending.ChargingCents,
				},
			}},
		}
	}
	if errors.Is(err, store.ErrNoPaymentMethod) {
		return conflictError("no_payment_method", err.Error())
	}
	if errors.Is(err, store.ErrPaymentMethodNotInstant) {
		return conflictError("payment_method_not_instant", err.Error())
	}
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		return huma.Error404NotFound("not found")
	}
	if errors.Is(err, store.ErrInvalidCustomization) {
		return huma.Error422UnprocessableEntity(err.Error())
	}
	if errors.Is(err, store.ErrModelRefRequired) {
		return huma.Error400BadRequest("a model preference is required")
	}
	if errors.Is(err, store.ErrTooManyLLMLeases) {
		return &huma.ErrorModel{
			Status: http.StatusTooManyRequests,
			Title:  http.StatusText(http.StatusTooManyRequests),
			Detail: "too many AI requests in progress",
			Errors: []*huma.ErrorDetail{{
				Message: "too_many_streams",
			}},
		}
	}
	if errors.Is(err, store.ErrTooManyIngestLeases) {
		return &huma.ErrorModel{
			Status: http.StatusTooManyRequests,
			Title:  http.StatusText(http.StatusTooManyRequests),
			Detail: "too many ingest jobs in progress",
			Errors: []*huma.ErrorDetail{{
				Message: "too_many_ingest_leases",
			}},
		}
	}
	var busy *providerBusyError
	if errors.As(err, &busy) {
		return &huma.ErrorModel{
			Status: http.StatusServiceUnavailable,
			Title:  http.StatusText(http.StatusServiceUnavailable),
			Detail: busy.Error(),
			Errors: []*huma.ErrorDetail{{
				Message: "provider_busy",
				// The browser spreads an object value into the error body.
				Value: map[string]any{"retryAfterSeconds": busy.retryAfter()},
			}},
		}
	}
	if errors.Is(err, store.ErrModelUnavailable) {
		return &huma.ErrorModel{
			Status: http.StatusUnprocessableEntity,
			Title:  http.StatusText(http.StatusUnprocessableEntity),
			Detail: "LLM model not available",
			Errors: []*huma.ErrorDetail{{
				Message: "model_unavailable",
			}},
		}
	}
	if errors.Is(err, store.ErrTitleTaken) {
		return conflictError("title_taken", "a material with this name already exists in this workspace")
	}
	if errors.Is(err, store.ErrTooManyChapters) {
		return conflictError("too_many_chapters", "this workspace already has the maximum number of chapters")
	}
	// The specific conflicts wrap ErrConflict, so they come first.
	if errors.Is(err, store.ErrAccountDeletionBusy) {
		return conflictError("account_deletion_busy", "account deletion is still being processed")
	}
	if errors.Is(err, store.ErrSubscriptionExists) {
		return conflictError("subscription_exists", "an active subscription already exists")
	}
	if errors.Is(err, store.ErrCheckoutStarting) {
		return conflictError("checkout_starting", "a checkout is still starting")
	}
	if errors.Is(err, store.ErrCloneSourceChanged) {
		return conflictError("clone_source_changed", "the source changed while it was copied")
	}
	if errors.Is(err, store.ErrProcessingStarted) {
		return conflictError("processing_started", "processing has already started")
	}
	if errors.Is(err, store.ErrCheckpointMoved) {
		return conflictError("checkpoint_moved", "the source checkpoint moved")
	}
	if errors.Is(err, store.ErrSourceEpochChanged) {
		return conflictError("epoch_changed", "the source editing epoch changed")
	}
	if errors.Is(err, store.ErrConflict) {
		return conflictError("revision_conflict", "someone else changed this first")
	}
	if errors.Is(err, store.ErrInvalidCheckpoint) {
		return &huma.ErrorModel{
			Status: http.StatusUnprocessableEntity,
			Title:  http.StatusText(http.StatusUnprocessableEntity),
			Detail: store.ErrInvalidCheckpoint.Error(),
			Errors: []*huma.ErrorDetail{{Message: "invalid_checkpoint"}},
		}
	}
	if errors.Is(err, store.ErrNothingToProcess) {
		return conflictError("nothing_to_process", "no saved changes to process")
	}
	if errors.Is(err, store.ErrParseModeUnsupported) {
		return huma.Error400BadRequest("parse mode not available for this file")
	}
	if errors.Is(err, store.ErrInvalidPDFAnnotation) {
		return huma.Error400BadRequest("invalid annotation")
	}
	if errors.Is(err, errAIUnavailable) {
		return &huma.ErrorModel{
			Status: http.StatusServiceUnavailable,
			Title:  http.StatusText(http.StatusServiceUnavailable),
			Detail: errAIUnavailable.Error(),
			Errors: []*huma.ErrorDetail{{Message: "ai_unavailable"}},
		}
	}
	if errors.Is(err, errGenerateEmpty) || errors.Is(err, store.ErrEmptyMaterial) {
		return &huma.ErrorModel{
			Status: http.StatusBadGateway,
			Title:  http.StatusText(http.StatusBadGateway),
			Detail: errGenerateEmpty.Error(),
			Errors: []*huma.ErrorDetail{{Message: "generate_empty"}},
		}
	}
	if errors.Is(err, errScopeNoIndexedContent) {
		return &huma.ErrorModel{
			Status: http.StatusBadRequest,
			Title:  http.StatusText(http.StatusBadRequest),
			Detail: errScopeNoIndexedContent.Error(),
			Errors: []*huma.ErrorDetail{{Message: "scope_has_no_indexed_content"}},
		}
	}
	if errors.Is(err, errContextTooLarge) {
		return &huma.ErrorModel{
			Status: http.StatusBadRequest,
			Title:  http.StatusText(http.StatusBadRequest),
			Detail: errContextTooLarge.Error(),
			Errors: []*huma.ErrorDetail{{Message: "context_too_large"}},
		}
	}
	var pendingTooLarge *pendingSourcesTooLargeError
	if errors.As(err, &pendingTooLarge) {
		return &huma.ErrorModel{
			Status: http.StatusBadRequest,
			Title:  http.StatusText(http.StatusBadRequest),
			Detail: pendingTooLarge.Error(),
			Errors: []*huma.ErrorDetail{{
				Message: "pending_sources_too_large",
				Value:   map[string]any{"fileIds": pendingTooLarge.FileIDs, "materialIds": pendingTooLarge.MaterialIDs},
			}},
		}
	}
	if errors.Is(err, errSourceChanged) {
		return &huma.ErrorModel{
			Status: http.StatusConflict,
			Title:  http.StatusText(http.StatusConflict),
			Detail: errSourceChanged.Error(),
			Errors: []*huma.ErrorDetail{{Message: "source_changed"}},
		}
	}
	if errors.Is(err, store.ErrOfficeEditingPaused) {
		return &huma.ErrorModel{
			Status: http.StatusLocked,
			Title:  http.StatusText(http.StatusLocked),
			Detail: store.ErrOfficeEditingPaused.Error(),
			Errors: []*huma.ErrorDetail{{Message: "office_editing_paused"}},
		}
	}
	if errors.Is(err, store.ErrAuthorityUnavailable) {
		return huma.Error503ServiceUnavailable("collaboration authority unavailable")
	}
	var quota *store.QuotaExceededError
	if errors.As(err, &quota) {
		// The code alone: reportHandlerError adds the numbers for the charged
		// account (see quotaDetail).
		return quotaError(nil)
	}
	var fileLimit *store.FileLimitExceededError
	if errors.As(err, &fileLimit) {
		return &huma.ErrorModel{
			Status: http.StatusForbidden,
			Title:  http.StatusText(http.StatusForbidden),
			Detail: "workspace file limit exceeded",
			Errors: []*huma.ErrorDetail{{
				Message: fileLimit.Code(),
				Value: map[string]any{
					"filesUsed":      fileLimit.Used,
					"filesReserved":  fileLimit.Reserved,
					"filesRequested": fileLimit.Requested,
					"filesLimit":     fileLimit.Limit,
					"workspaceId":    fileLimit.WorkspaceID,
				},
			}},
		}
	}
	// A clone past the payer's per-file cap: the upload's refusal, with a code
	// and the cap for the clone dialog.
	var tooLarge *store.FileTooLargeError
	if errors.As(err, &tooLarge) {
		return &huma.ErrorModel{
			Status: http.StatusBadRequest,
			Title:  http.StatusText(http.StatusBadRequest),
			Detail: fmt.Sprintf("uploads support files up to %d MB", tooLarge.LimitBytes>>20),
			Errors: []*huma.ErrorDetail{{
				Message: "file_too_large",
				Value:   map[string]any{"maxBytes": tooLarge.LimitBytes},
			}},
		}
	}
	var workspaceLimit *store.WorkspaceLimitExceededError
	if errors.As(err, &workspaceLimit) {
		return &huma.ErrorModel{
			Status: http.StatusForbidden,
			Title:  http.StatusText(http.StatusForbidden),
			Detail: "owned workspace limit exceeded",
			Errors: []*huma.ErrorDetail{{
				Message: "workspace_limit_exceeded",
				Value: map[string]any{
					"workspacesUsed":      workspaceLimit.Used,
					"workspacesRequested": workspaceLimit.Requested,
					"workspacesLimit":     workspaceLimit.Limit,
				},
			}},
		}
	}
	var locked *store.AccountLockedError
	if errors.As(err, &locked) {
		return &huma.ErrorModel{
			Status: http.StatusForbidden,
			Title:  http.StatusText(http.StatusForbidden),
			Detail: "account unavailable",
			Errors: []*huma.ErrorDetail{{
				Message: locked.Code(),
				Value: map[string]any{
					"state":  string(locked.State),
					"reason": locked.Reason,
				},
			}},
		}
	}
	var credits *store.CreditsExhaustedError
	if errors.As(err, &credits) {
		return &huma.ErrorModel{
			Status: http.StatusForbidden,
			Title:  http.StatusText(http.StatusForbidden),
			Detail: "monthly AI credits exhausted",
			Errors: []*huma.ErrorDetail{{
				Message: "llm_credits_exhausted",
				Value: map[string]any{
					"creditsUsedMicros":      credits.UsedMicros,
					"creditsReservedMicros":  credits.ReservedMicros,
					"creditsLimitMicros":     credits.LimitMicros,
					"creditsPurchasedMicros": credits.PurchasedMicros,
					"planTier":               string(credits.PlanTier),
				},
			}},
		}
	}
	// Anything else is unexpected: reportHandlerError answers the generic 500.
	return huma.Error500InternalServerError("")
}

// unexpectedError answers a server failure that carries no machine code: a
// fixed message and the request's trace id, never the cause's text, which
// stays in the logs and Sentry under that id. The browser shows the id where
// the error stays on screen.
type unexpectedError struct {
	huma.ErrorModel
	TraceID string `json:"traceId,omitempty"`
}

func newUnexpectedError(status int, traceID string) *unexpectedError {
	return &unexpectedError{
		ErrorModel: huma.ErrorModel{Status: status, Title: http.StatusText(status), Detail: "Something went wrong"},
		TraceID:    traceID,
	}
}

// typedServerCodes are the 5xx codes the browser gives their own copy; a 5xx
// carrying anything else in errors[] (an error's text, even one word) is
// unexpected. src/lib/errors.ts keeps the same list.
var typedServerCodes = []string{"provider_busy", "ai_unavailable", "generate_empty", "bank_unavailable", "upload_queue_full", "rate_limit_unavailable", "captcha_unavailable", "transcription_failed", "voice_unavailable"}

func typedServerError(details []*huma.ErrorDetail) bool {
	return len(details) > 0 && !slices.ContainsFunc(details, func(detail *huma.ErrorDetail) bool {
		return detail == nil || !slices.Contains(typedServerCodes, detail.Message)
	})
}

// publicError is the answer for a handler's error: a 5xx that is not typed
// (or an error huma would answer as 500) becomes the generic answer; a typed
// 5xx and every 4xx stay as they are.
func publicError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	var status huma.StatusError
	if !errors.As(err, &status) {
		return newUnexpectedError(http.StatusInternalServerError, obs.TraceID(ctx))
	}
	if status.GetStatus() < http.StatusInternalServerError {
		return err
	}
	var model *huma.ErrorModel
	if errors.As(err, &model) && typedServerError(model.Errors) {
		return err
	}
	return newUnexpectedError(status.GetStatus(), obs.TraceID(ctx))
}

// maxRequestErrors bounds the errors in one answer: Huma reports every
// failing element, so a long array would answer one error per element.
const maxRequestErrors = 10

// trimRequestErrors keeps the first maxRequestErrors and drops the value Huma
// echoes on the errors it builds about the request (each names a location:
// body, path, query or header; a body it could not parse echoes all of it).
// Our typed errors name no location and keep their value.
func trimRequestErrors(model *huma.ErrorModel) {
	details := model.Errors[:min(len(model.Errors), maxRequestErrors)]
	model.Errors = make([]*huma.ErrorDetail, len(details))
	for i, detail := range details {
		if detail != nil && detail.Location != "" {
			detail = &huma.ErrorDetail{Message: detail.Message, Location: detail.Location}
		}
		model.Errors[i] = detail
	}
}

func init() {
	// The errors huma builds itself (a request body it could not read,
	// writeStatusErr) follow the same rule; their cause goes to the logs and
	// Sentry instead of the body.
	huma.NewErrorWithContext = func(ctx huma.Context, status int, msg string, errs ...error) huma.StatusError {
		built := huma.NewError(status, msg, errs...)
		model, ok := built.(*huma.ErrorModel)
		if ok {
			trimRequestErrors(model)
		}
		if status < http.StatusInternalServerError || ok && typedServerError(model.Errors) {
			return built
		}
		if cause := errors.Join(errs...); cause != nil {
			obs.RecordHTTPError(ctx.Context(), fmt.Errorf("%s: %w", msg, cause))
		}
		return newUnexpectedError(status, obs.TraceID(ctx.Context()))
	}
}

// materialContentError answers a read whose stored document cannot be decoded.
// Reads no longer substitute an empty envelope for undecodable content, because
// a blank body is indistinguishable from data loss. The machine code lets the
// client say "this note could not be loaded" instead of "not found"; the
// decode error stays in the log.
func materialContentError(ctx context.Context, materialID string, err error) error {
	obs.Log(ctx).Warn("material content unreadable", "material_id", materialID, "error", err)
	return &huma.ErrorModel{
		Status: http.StatusUnprocessableEntity,
		Title:  http.StatusText(http.StatusUnprocessableEntity),
		Detail: "material content could not be decoded",
		Errors: []*huma.ErrorDetail{{Message: "material_content_unreadable"}},
	}
}

// storedContentError answers an error from a route that reads a material's
// stored content (Epo 2026-10-20): content the rules refuse is the
// unreadable state, anything else goes through hErr. Content a request sends
// or we generate keeps its own answer (400, or a 500 that reaches Sentry).
func storedContentError(ctx context.Context, materialID string, err error) error {
	if errors.Is(err, materialdoc.ErrInvalid) {
		return materialContentError(ctx, materialID, err)
	}
	return hErr(err)
}

const materialRequestMaxBytes = 3 << 20

// reg is a thin wrapper over huma.Register that sets the common operation
// fields; type params are inferred from the handler.
func reg[I, O any](api huma.API, method, path, id, tag, summary string, status int, h func(context.Context, *I) (*O, error)) {
	regWithMaxBody(api, method, path, id, tag, summary, status, 0, h)
}

// regWithMaxBody is reg with a body size cap; options adjust the operation
// further (a large internal route's body read deadline).
func regWithMaxBody[I, O any](
	api huma.API,
	method, path, id, tag, summary string,
	status int,
	maxBodyBytes int64,
	h func(context.Context, *I) (*O, error),
	options ...func(*huma.Operation),
) {
	operation := huma.Operation{
		OperationID:   id,
		Method:        method,
		Path:          path,
		Summary:       summary,
		Tags:          []string{tag},
		DefaultStatus: status,
		MaxBodyBytes:  maxBodyBytes,
	}
	for _, option := range options {
		option(&operation)
	}
	huma.Register(api, operation, func(ctx context.Context, input *I) (*O, error) {
		output, err := h(ctx, input)
		err = reportHandlerError(ctx, err)
		return output, err
	})
}

func reportHandlerError(ctx context.Context, err error) error {
	cause := err
	if mapped, ok := err.(*handlerError); ok {
		cause, err = mapped.cause, mapped.error
	}
	if detail := quotaDetail(cause, userID(ctx)); detail != nil {
		err = quotaError(detail)
	}
	var busy *providerBusyError
	if errors.As(cause, &busy) {
		cause = obs.ExpectedError(cause)
	}
	obs.RecordHTTPError(ctx, cause)
	return publicError(ctx, err)
}

// Empty is the output for endpoints that return 204 No Content.
type Empty struct{}

// registerRoutes wires the JSON operations onto the huma API. Streaming
// (the gateway uploads with their tickets), redirect, webhook,
// pipeline-passthrough, and /api/internal/* endpoints stay on raw chi (see
// server.go) and are
// intentionally absent from the spec so Orval does not generate a browser
// client for them.
func registerRoutes(api huma.API, a *api) {
	a.registerBank(api)
	a.registerAccount(api)
	a.registerModels(api)
	a.registerAccountLifecycle(api)
	a.registerWorkspaces(api)
	a.registerTags(api)
	a.registerChat(api)
	a.registerContent(api)
	a.registerEditorAssets(api)
	a.registerThumbnails(api)
	a.registerSourceUploads(api)
	a.registerGenerate(api)
	a.registerMaterials(api)
	a.registerQuizzes(api)
	a.registerFlashcards(api)
	a.registerStudy(api)
	a.registerSchedule(api)
	a.registerExplore(api)
	a.registerShare(api)
	a.registerWorkspaceSummary(api)
	a.registerAnonymousMaterials(api)
	a.registerBillingIntegrations(api)
	a.registerEditIncidents(api)
	a.registerVoice(api)
}

func quotaError(detail map[string]any) *huma.ErrorModel {
	return &huma.ErrorModel{
		Status: http.StatusForbidden,
		Title:  http.StatusText(http.StatusForbidden),
		Detail: "storage quota exceeded",
		Errors: []*huma.ErrorDetail{{Message: "storage_quota_exceeded", Value: detail}},
	}
}

// quotaDetail is a storage refusal's numbers, for the charged account only: a
// member writing into the owner's workspace gets the code alone, since the
// owner's byte counts and id are not theirs to see. nil for anything else.
func quotaDetail(err error, requester string) map[string]any {
	var quota *store.QuotaExceededError
	if !errors.As(err, &quota) || requester == "" || quota.UserID != requester {
		return nil
	}
	return map[string]any{
		"storageUsedBytes":      quota.UsedBytes,
		"storageReservedBytes":  quota.ReservedBytes,
		"storageRequestedBytes": quota.RequestedBytes,
		"storageLimitBytes":     quota.LimitBytes,
		"ownerUserId":           quota.UserID,
	}
}

// writeStatusErr renders an hErr result from middleware, where the handler's
// error return is not available.
func writeStatusErr(api huma.API, ctx huma.Context, err error) {
	err = reportHandlerError(ctx.Context(), err)
	var model *huma.ErrorModel
	if !errors.As(err, &model) {
		// The generic answer (see huma.NewErrorWithContext in init); a typed
		// 5xx below keeps its code there.
		_ = huma.WriteErr(api, ctx, errorStatus(err), "")
		return
	}
	details := make([]error, len(model.Errors))
	for i, detail := range model.Errors {
		details[i] = detail
	}
	_ = huma.WriteErr(api, ctx, model.Status, model.Detail, details...)
}
