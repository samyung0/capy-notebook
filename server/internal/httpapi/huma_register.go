package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"github.com/evonotes/server/internal/auth"
	"github.com/evonotes/server/internal/store"
)

// humaConfig builds the OpenAPI document metadata. huma serves the spec at
// /openapi.yaml, /openapi.json (+ 3.0 variants) and docs at /docs.
func humaConfig() huma.Config {
	return huma.DefaultConfig("Evo Notes API", "0.1.0")
}

// SpecYAML renders the OpenAPI 3.0.3 spec (safest for orval) without a live DB;
// handlers are registered but never executed during spec generation.
func SpecYAML() ([]byte, error) {
	r := chi.NewRouter()
	api := humachi.New(r, humaConfig())
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
func hErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		return huma.Error404NotFound("not found")
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
	if errors.Is(err, store.ErrInvalidLLMKey) {
		return &huma.ErrorModel{
			Status: http.StatusBadRequest,
			Title:  http.StatusText(http.StatusBadRequest),
			Detail: "the provider rejected this key",
			Errors: []*huma.ErrorDetail{{Message: "invalid_llm_key"}},
		}
	}
	if errors.Is(err, store.ErrLLMKeyFailed) {
		return &huma.ErrorModel{
			Status: http.StatusBadRequest,
			Title:  http.StatusText(http.StatusBadRequest),
			Detail: "Something went wrong, please double check if the key is valid",
			Errors: []*huma.ErrorDetail{{Message: "llm_key_failed"}},
		}
	}
	if errors.Is(err, store.ErrLLMCredentialsUnavailable) {
		return huma.Error503ServiceUnavailable("key storage is not configured")
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
		return huma.Error409Conflict("a material with this name already exists in this workspace")
	}
	if errors.Is(err, errAIUnavailable) {
		return &huma.ErrorModel{
			Status: http.StatusServiceUnavailable,
			Title:  http.StatusText(http.StatusServiceUnavailable),
			Detail: errAIUnavailable.Error(),
			Errors: []*huma.ErrorDetail{{Message: "ai_unavailable"}},
		}
	}
	if errors.Is(err, errGenerateEmpty) {
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
	if errors.Is(err, store.ErrAuthorityUnavailable) {
		return huma.Error503ServiceUnavailable(
			"collaboration authority unavailable",
			err,
		)
	}
	var quota *store.QuotaExceededError
	if errors.As(err, &quota) {
		return &huma.ErrorModel{
			Status: http.StatusForbidden,
			Title:  http.StatusText(http.StatusForbidden),
			Detail: "storage quota exceeded",
			Errors: []*huma.ErrorDetail{{
				Message: "storage_quota_exceeded",
				Value: map[string]any{
					"storageUsedBytes":      quota.UsedBytes,
					"storageReservedBytes":  quota.ReservedBytes,
					"storageRequestedBytes": quota.RequestedBytes,
					"storageLimitBytes":     quota.LimitBytes,
					"ownerUserId":           quota.UserID,
				},
			}},
		}
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
					"creditsUsedMicros":     credits.UsedMicros,
					"creditsReservedMicros": credits.ReservedMicros,
					"creditsLimitMicros":    credits.LimitMicros,
					"planTier":              string(credits.PlanTier),
				},
			}},
		}
	}
	return huma.Error500InternalServerError(err.Error())
}

// materialContentError answers a read whose stored document cannot be decoded.
// Reads no longer substitute an empty envelope for undecodable content, because
// a blank body is indistinguishable from data loss. The machine code lets the
// client say "this note could not be loaded" instead of "not found".
func materialContentError(err error) error {
	return &huma.ErrorModel{
		Status: http.StatusUnprocessableEntity,
		Title:  http.StatusText(http.StatusUnprocessableEntity),
		Detail: "material content could not be decoded",
		Errors: []*huma.ErrorDetail{{
			Message: "material_content_unreadable",
			Value:   map[string]any{"reason": err.Error()},
		}},
	}
}

const materialRequestMaxBytes = 3 << 20

// reg is a thin wrapper over huma.Register that sets the common operation
// fields; type params are inferred from the handler.
func reg[I, O any](api huma.API, method, path, id, tag, summary string, status int, h func(context.Context, *I) (*O, error)) {
	regWithMaxBody(api, method, path, id, tag, summary, status, 0, h)
}

func regWithMaxBody[I, O any](
	api huma.API,
	method, path, id, tag, summary string,
	status int,
	maxBodyBytes int64,
	h func(context.Context, *I) (*O, error),
) {
	huma.Register(api, huma.Operation{
		OperationID:   id,
		Method:        method,
		Path:          path,
		Summary:       summary,
		Tags:          []string{tag},
		DefaultStatus: status,
		MaxBodyBytes:  maxBodyBytes,
	}, h)
}

// Empty is the output for endpoints that return 204 No Content.
type Empty struct{}

// registerRoutes wires every JSON operation onto the huma API. Streaming,
// multipart, redirect, webhook, pipeline-passthrough, and /api/internal/*
// endpoints stay on raw chi (see server.go) and are intentionally absent
// from the spec so Orval does not generate a browser client for them.
func registerRoutes(api huma.API, a *api) {
	a.registerAccount(api)
	a.registerModels(api)
	a.registerAccountLifecycle(api)
	a.registerWorkspaces(api)
	a.registerTags(api)
	a.registerChat(api)
	a.registerContent(api)
	a.registerSourceUploads(api)
	a.registerGenerate(api)
	a.registerMaterials(api)
	a.registerQuizzes(api)
	a.registerFlashcards(api)
	a.registerSchedule(api)
	a.registerThinking(api)
	a.registerExplore(api)
	a.registerShare(api)
	a.registerBillingIntegrations(api)
}
