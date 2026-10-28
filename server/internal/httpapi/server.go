package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/redis/go-redis/v9"
	"github.com/stripe/stripe-go/v82"

	"github.com/samyung0/capy-notebook/server/internal/alibaba"
	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/jev"
	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/ratelimit"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Config holds gateway settings for auth and billing. Provider OAuth
// (Google/Microsoft) is managed entirely by Clerk.
type Config struct {
	ReleaseSHA         string
	ClerkSecretKey     string
	ClerkWebhookSecret string
	AuthDisabled       bool
	DevUserID          string
	// APIDocs serves /docs, /openapi.* and /schemas/* and links bodies to their
	// schemas: local development only (APP_ENV=development). Deployed
	// environments, UAT included, leave it off.
	APIDocs bool
	// E2EAuth enables X-E2E-User-Id identity headers (disposable E2E only).
	E2EAuth                bool
	E2ESecret              string
	E2EUserIDs             []string
	StripeSecretKey        string
	StripeWebhookSecret    string
	StripePricePro         string
	AppURL                 string
	EmailUnsubscribeSecret string
	CollaborationSecret    string
	CollaborationURL       string
	// AllowedOrigins is the CORS allowlist. Empty answers no cross-origin
	// request at all (never "*"): development and e2e reach the API through a
	// same-origin proxy, and deployed gateways refuse to boot without a list.
	AllowedOrigins []string
	// AuthorizedParties are the origins whose Clerk session tokens are accepted
	// (COLLABORATION_ALLOWED_ORIGINS, Epo 2026-10-21).
	AuthorizedParties []string
	// RateLimit governs per-user and per-IP request limits. The zero value
	// disables limiting entirely.
	RateLimit ratelimit.Config
	// TurnstileSecret verifies signed-out answer checks' Turnstile tokens
	// (TURNSTILE_SECRET_KEY); CaptchaVerifier replaces siteverify in tests.
	TurnstileSecret string
	// TurnstileHosts are the hosts a Turnstile token must have been solved
	// on, the environment's app hosts; empty skips the check (development
	// and e2e, whose test keys name no app host).
	TurnstileHosts  []string
	CaptchaVerifier CaptchaVerifier
	// ModelRegistry is the process-wide model config cache. Nil disables
	// per-model pricing and pinning (tests).
	ModelRegistry *models.Registry
	// Jev grades open quiz parts. Nil (no JEV_TYPESAFE_API_KEY) makes grading
	// answer 503 rather than falling back to another model.
	Jev *jev.Client
	// Voice transcribes chat voice input. Nil (no ALIBABA_MODELSTUDIO_KEY or
	// _URL) makes voice input answer 503 voice_unavailable.
	Voice *alibaba.Client
	// PipelineSecret authenticates the retrieval service's and the ingest
	// host's callbacks into /api/internal/*. Empty disables those routes and
	// therefore Drive/OneDrive imports, which need the import worker.
	PipelineSecret string
	// ParseMaxPages and ParseMaxOCRPages are the ingest host parser's page cap
	// and OCR page cap, from the same env keys (CAPY_PARSE_MAX_PAGES,
	// CAPY_PARSE_OCR_PAGE_CAP). The upload policy serves them to the browser
	// and a fast-parse reservation claiming more pages is refused.
	ParseMaxPages    int
	ParseMaxOCRPages int
	// MailRecorder exposes delivered mail to Playwright. Non-nil only under
	// APP_ENV=e2e.
	MailRecorder     mail.Recorder
	Bank             *bank.Store
	BankAssets       bank.AssetWriter
	BankAssetsURL    string
	BankCommentEmail string
}

type api struct {
	s                  *store.Store
	wh                 webhookStore
	blob               blob.Store
	pipe               *pipeline.Client
	rdb                *redis.Client
	parser             string
	cfg                Config
	mailRecorder       mail.Recorder
	limiter            *ratelimit.Limiter
	captcha            CaptchaVerifier
	modelReg           *models.Registry
	jev                *jev.Client
	stripeSubscription func(string) (*stripe.Subscription, error)
	stripeEntitlements func(string) ([]*stripe.Subscription, error)
	stripeInvoices     func(string) ([]*stripe.Invoice, error)
	// Subscription Checkout calls, faked in tests.
	stripeNewCheckout    func(customerID, priceID, userID, successURL, cancelURL, reservationID, key string) (billing.CheckoutSession, error)
	stripeGetCheckout    func(sessionID string) (billing.CheckoutSession, error)
	stripeExpireCheckout func(sessionID string) error
	// Credit top-up and auto-reload calls, replaced by tests.
	stripeTopUpMethod func(string) (store.PaymentMethod, error)
	stripeSetupMethod func(string) (store.PaymentMethod, error)
	// The card a Pro Checkout saved, for the starter grant.
	stripeSubscriptionMethod func(string) (store.PaymentMethod, error)
	stripeVoidInvoice        func(string) error
	stripeReloadOutcome      func(string) (billing.ReloadResult, error)
	// Credit Checkout and portal sessions, replaced by tests.
	stripeTopUpCheckout  func(customerID, userID string, amountCents int64, successURL, cancelURL string) (billing.CheckoutSession, error)
	stripeMethodCheckout func(customerID, userID, successURL, cancelURL string) (billing.CheckoutSession, error)
	stripePortal         func(customerID, returnURL, cancelSubscriptionID string) (string, error)
	invoices             invoiceCache
	streamMu             sync.Mutex
	streamByUser         map[string]int
	streamTotal          int
	// uploads admits the gateway uploads (upload_queue.go).
	uploads *uploadQueue
	// undos run the requests for one chat Undo step one at a time
	// (huma_undo.go).
	undos operationLocks
	// broker fans the ingest and notification channels out from one Redis
	// subscription, and the workspace tree channel from one Postgres LISTEN
	// (treeLive says whether that LISTEN is attached); see fanout.go.
	broker   *channelBroker
	treeLive atomic.Bool
	// operations hold an agent edit's or create's retry until its first
	// attempt ends (internal_documents.go).
	operations operationLocks
	// turns are the chat turns this process relays, by assistant message id,
	// so a stop request reaches its relay (chat_stop.go).
	turns sync.Map
}

// New builds the full HTTP handler. huma owns every JSON operation (and, in
// local development only, the live OpenAPI spec and docs); a handful of endpoints
// huma can't model — streaming SSE, blob download redirects,
// webhooks, and the pipeline chat passthrough — stay on raw chi and are
// intentionally absent from the spec. /api/internal/* stays off Huma so Orval
// does not generate a browser client for the service-to-service secret.
func New(s *store.Store, b blob.Store, pipe *pipeline.Client, rdb *redis.Client, parser string, cfg Config) http.Handler {
	billing.Init(billing.Config{SecretKey: cfg.StripeSecretKey})
	a := &api{
		s:                  s,
		wh:                 s,
		blob:               b,
		pipe:               pipe,
		rdb:                rdb,
		parser:             parser,
		cfg:                cfg,
		mailRecorder:       cfg.MailRecorder,
		limiter:            ratelimit.New(rdb, cfg.RateLimit),
		captcha:            cfg.CaptchaVerifier,
		jev:                cfg.Jev,
		modelReg:           cfg.ModelRegistry,
		stripeSubscription: billing.RetrieveSubscription,
		stripeEntitlements: billing.ListEntitlingSubscriptions,
		stripeInvoices:     billing.ListInvoices,

		stripeNewCheckout:    billing.CreateCheckoutSession,
		stripeGetCheckout:    billing.GetCheckoutSession,
		stripeExpireCheckout: billing.ExpireCheckoutSession,

		stripeTopUpMethod:        billing.TopUpPaymentMethod,
		stripeSetupMethod:        billing.SetupPaymentMethod,
		stripeSubscriptionMethod: billing.SubscriptionPaymentMethod,
		stripeVoidInvoice:        billing.VoidInvoice,
		stripeReloadOutcome:      billing.ReloadOutcome,

		stripeTopUpCheckout:  billing.CreateTopUpCheckout,
		stripeMethodCheckout: billing.CreateReloadMethodCheckout,
		stripePortal:         billing.CreatePortalSession,
		streamByUser:         make(map[string]int),
	}
	if a.captcha == nil {
		a.captcha = newTurnstileVerifier(cfg.TurnstileSecret, cfg.TurnstileHosts)
	}
	a.uploads = newUploadQueue(func(batch string, removed bool) {
		if removed {
			a.removeSourceBatchFile(context.Background(), batch)
		} else {
			a.failSourceBatchFile(context.Background(), batch)
		}
	})
	// A ticket past its user's upload class waits in line (Q282).
	a.uploads.admitClass = func(ctx context.Context, user string) (time.Duration, error) {
		return a.limiter.TakeUpload(ctx, user)
	}
	if rdb != nil {
		a.broker = newChannelBroker(rdb, "ingest:*", "notif:*")
		go a.listenWorkspaceTree(context.Background())
	}
	// The e2e memory store, when its objects are served (blob.ServedPath).
	served, _ := b.(*blob.Memory)
	if served != nil && !served.Served() {
		served = nil
	}
	publicPrefix := []string{
		"/api/email/unsubscribe",
		// Signed-out grading of a shared quiz or of a quiz embedded in a
		// shared note; the handler verifies the share token and applies
		// the anonymous daily caps.
		"/api/public/quizzes/",
		"/api/public/notes/",
		// Service-to-service, authenticated by X-Pipeline-Secret in
		// internalSecretFirst; there is no Clerk session to verify.
		"/api/internal/",
	}
	if served != nil {
		// Read by the collaboration server too, which has no session.
		publicPrefix = append(publicPrefix, blob.ServedPath)
	}
	r := chi.NewRouter()
	// Trace first so the recovery handler and every log line below it can name
	// the request; access logging second so it records panics as 500s.
	r.Use(obs.Middleware)
	r.Use(obs.AccessLog)
	r.Use(recoverer)
	r.Use(obs.SentryMiddleware)
	// go-chi/cors reads an empty origin list as "*", so no list means no handler.
	if len(cfg.AllowedOrigins) > 0 {
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins: cfg.AllowedOrigins,
			AllowedMethods: []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
			AllowedHeaders: []string{
				"Content-Type", "Authorization", obs.HeaderTraceparent,
				auth.HeaderE2EUserID, auth.HeaderE2ESecret,
			},
			ExposedHeaders:   []string{obs.HeaderRequestID},
			AllowCredentials: false,
			MaxAge:           600,
		}))
	}
	// Public failures must not be cached either: visibility is read live, and
	// only the site Worker caches public responses.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/public/") {
				w.Header().Set("Cache-Control", "no-store")
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Use(a.internalSecretFirst)
	r.Use(auth.Middleware(auth.Config{
		SecretKey:         cfg.ClerkSecretKey,
		Disabled:          cfg.AuthDisabled,
		DevUserID:         cfg.DevUserID,
		E2EAuth:           cfg.E2EAuth,
		E2ESecret:         cfg.E2ESecret,
		E2EUserIDs:        cfg.E2EUserIDs,
		AuthorizedParties: cfg.AuthorizedParties,
		Store:             s,
		PublicPrefix:      publicPrefix,
		PublicReadPrefix: []string{
			"/api/public/",
		},
	}))
	// After auth: limits are per user wherever there is one, and only fall back
	// to the client IP for anonymous public reads.
	r.Use(ratelimit.Middleware(a.limiter, uid))

	// Mount huma on the chi router. Doc/spec routes register at construction, so
	// this must come after all r.Use(...) calls.
	humaAPI := humachi.New(r, humaConfig(cfg.APIDocs))
	registerRoutes(humaAPI, a)

	// Raw (OpenAPI-excluded) routes.
	r.Get("/healthz", healthHandler(cfg.ReleaseSHA))
	r.Post("/webhooks/clerk", a.clerkWebhook)
	r.Post("/webhooks/stripe", a.stripeWebhook)
	r.Get("/api/stream", a.stream)
	r.Get("/api/email/unsubscribe", a.emailUnsubscribe)
	r.Post("/api/email/unsubscribe", a.emailUnsubscribe)
	if cfg.E2EAuth && a.mailRecorder != nil {
		r.Get("/api/e2e/emails", a.e2eEmails)
	}
	r.Post("/api/workspaces/{id}/sources/uploads/tickets", a.sourceUploadTicket)
	r.Post("/api/workspaces/{id}/sources/uploads", a.uploadSource)
	r.Post("/api/materials/{id}/editor-assets/uploads/tickets", a.editorAssetUploadTicket)
	r.Post("/api/materials/{id}/editor-assets/uploads", a.uploadEditorAsset)
	r.Get("/api/uploads/tickets/{ticketId}", a.waitUploadTicket)
	r.Delete("/api/uploads/tickets/{ticketId}", a.cancelUploadTicket)
	r.Post("/api/workspaces/{id}/sources/batches/{batchId}/removed", a.removeUnsentSource)
	// The same flow with no workspace: a standalone file (Epo 2026-10-27).
	r.Post("/api/sources/uploads/tickets", a.sourceUploadTicket)
	r.Post("/api/sources/uploads", a.uploadSource)
	r.Post("/api/sources/batches/{batchId}/removed", a.removeUnsentSource)
	r.Get("/api/editor-assets/{assetId}/resolve", a.resolveEditorAsset)
	r.Post("/api/workspaces/{id}/chat/stream", a.chatStream)
	r.Post("/api/workspaces/{id}/ai/copilot", a.aiCopilot)
	if cfg.PipelineSecret != "" {
		r.Post("/api/internal/materials", a.internalCreateMaterial)
		r.Post("/api/internal/files", a.internalCreateFile)
		r.Post("/api/internal/study-progress", a.internalStudyProgress)
		r.Post("/api/internal/source-changes", a.internalSourceAuthority)
		r.Post("/api/internal/source-changes/resolve", a.internalSourceAuthority)
		r.Post("/api/internal/source-refresh/publish", a.internalSourceAuthority)
		r.Get("/api/internal/agent-operations/{operationId}", a.internalGetAgentOperation)
		r.Post("/api/internal/trash", a.internalTrash)
		r.Post("/api/internal/trash/restore", a.internalRestore)
		r.Get("/api/internal/trash", a.internalListTrash)
		r.Get("/api/internal/materials/{id}/index-text", a.internalMaterialIndexText)
		r.Post("/api/internal/note-changes", a.internalNoteChanges)
		r.Post("/api/internal/note-changes/resolve", a.internalResolveNoteChange)
		r.Post("/api/internal/documents/list", a.internalListDocuments)
		r.Post("/api/internal/documents/inspect", a.internalInspectDocument)
		r.Post("/api/internal/documents/edit", a.internalEditDocument)
		r.Post("/api/internal/documents/office/create", a.internalCreateOfficeDocument)
		r.Post("/api/internal/provider-calls", a.internalSettleProviderCall)
		r.Post("/api/internal/import/acquire", a.internalAcquireSourceImport)
		r.Post("/api/internal/import/complete", a.internalCompleteSourceImport)
		r.Post("/api/internal/import/fail", a.internalFailSourceImport)
	}
	r.Get("/api/workspaces/{id}/sources/import-content", a.getSourceImportContent)
	r.Get("/api/sources/import-content", a.getSourceImportContent)
	if served != nil {
		r.Get(blob.ServedPath+"*", e2eBlobs(served))
		r.Put(blob.ServedPath+"*", e2eBlobs(served))
	}

	return r
}

/* ------------------------------------------------------------------ helpers */

// The API listener's timeouts: a request has a minute to send its headers and
// body and five to be answered, and an idle keep-alive connection closes after
// two. Routes that stream or take a long upload body extend their own
// deadlines (extendDeadlines, readUploadMetadata).
const (
	serverReadTimeout  = time.Minute
	serverWriteTimeout = 5 * time.Minute
	serverIdleTimeout  = 2 * time.Minute
)

// NewServer is the API's http.Server for handler on addr.
func NewServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       serverReadTimeout,
		WriteTimeout:      serverWriteTimeout,
		IdleTimeout:       serverIdleTimeout,
	}
}

// extendDeadlines lets a streaming request read and write for d from now,
// past the server's timeouts; the connection's read deadline also ends a
// stream, since a failed background read cancels the request. A writer
// without deadlines (a test recorder) keeps none.
func extendDeadlines(w http.ResponseWriter, d time.Duration) {
	conn := http.NewResponseController(w)
	at := time.Now().Add(d)
	_ = conn.SetReadDeadline(at)
	_ = conn.SetWriteDeadline(at)
}

// internalBodyMaxBytes caps every service-to-service body at the largest an
// internal route takes (a source state); routes with a tighter bound keep it.
const internalBodyMaxBytes = 150 << 20

// internalSecretFirst refuses a call to /internal/collaboration/* or
// /api/internal/* without that prefix's service secret before anything reads
// its body (Huma decodes and validates a body before the handler runs), and
// caps the body of the callers that hold it. Neither prefix is rate limited.
func (a *api) internalSecretFirst(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ok bool
		switch {
		case strings.HasPrefix(r.URL.Path, "/internal/collaboration/"):
			ok = a.collaborationSecretOK(r.Header.Get("X-Collaboration-Secret"))
		case strings.HasPrefix(r.URL.Path, "/api/internal/"):
			ok = a.pipelineSecretOK(r)
		default:
			next.ServeHTTP(w, r)
			return
		}
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, internalBodyMaxBytes)
		next.ServeHTTP(w, r)
	})
}

func healthHandler(releaseSHA string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if releaseSHA != "" {
			w.Header().Set("X-Capy-Release", releaseSHA)
		}
		_, _ = w.Write([]byte("ok"))
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func decode(r *http.Request, v any) error { return json.NewDecoder(r.Body).Decode(v) }

// errAIUnavailable is a failed handshake with the Python retrieval service.
// Chat and generate used to invent a local answer here; the client must see
// the miss so an outage does not look like a finished turn.
var errAIUnavailable = errors.New("AI service is unavailable")

// errAgentFailed is a sanitized client-facing chat failure. Provider and
// store detail stay in logs and Sentry, not in the SSE payload.
var errAgentFailed = errors.New("the chat agent hit an internal error")

// errGenerateEmpty is a 200-shaped pipeline miss: the model ran, but the
// reply could not become a material. Distinct from errAIUnavailable so a
// blank mindmap is not reported as the retrieval process being down.
var errGenerateEmpty = errors.New("the model returned no usable material")

// errScopeNoIndexedContent: nothing in a Generate scope has text to work from.
var errScopeNoIndexedContent = errors.New("None of the chosen sources has any text to generate from yet: " +
	"they are still being indexed, or they are quizzes or flashcard sets, which hold no source text.")
var errContextTooLarge = errors.New("source context exceeds the selected model's input limit")
var errSourceChanged = errors.New("sources changed while this request was running; please try again")

// failFor is fail for a user-facing request: a storage refusal carries the
// numbers when the requester is the charged account.
func (a *api) failFor(w http.ResponseWriter, r *http.Request, err error) {
	if detail := quotaDetail(err, uid(r)); detail != nil {
		obs.ResponseError(w, err)
		detail["code"], detail["message"] = "storage_quota_exceeded", "storage quota exceeded"
		writeJSON(w, http.StatusForbidden, detail)
		return
	}
	a.fail(w, err)
}

func (a *api) fail(w http.ResponseWriter, err error) {
	obs.ResponseError(w, err)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "not found"})
		return
	}
	if errors.Is(err, store.ErrModelRefRequired) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code":    "model_ref_required",
			"message": "a model preference is required",
		})
		return
	}
	if errors.Is(err, store.ErrModelUnavailable) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"code":    "model_unavailable",
			"message": "LLM model not available",
		})
		return
	}
	if errors.Is(err, store.ErrMaterialConflict) || errors.Is(err, store.ErrMaterialIDTaken) ||
		errors.Is(err, store.ErrOperationConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "operation_conflict",
			"message": "this operation id was already used with a different request",
		})
		return
	}
	if errors.Is(err, store.ErrAudioTranscribing) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "audio_transcribing",
			"message": audioTranscribingDetail,
		})
		return
	}
	if errors.Is(err, store.ErrTitleTaken) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "title_taken",
			"message": "a material with this name already exists in this workspace",
		})
		return
	}
	if errors.Is(err, store.ErrTooManyChapters) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "too_many_chapters",
			"message": "this workspace already has the maximum number of chapters",
		})
		return
	}
	if errors.Is(err, store.ErrStorageQuotaExceeded) {
		// The code alone; failFor adds the charged account's own numbers.
		writeJSON(w, http.StatusForbidden, map[string]any{
			"code":    "storage_quota_exceeded",
			"message": "storage quota exceeded",
		})
		return
	}
	var fileLimit *store.FileLimitExceededError
	if errors.As(err, &fileLimit) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"code":           fileLimit.Code(),
			"message":        "workspace file limit exceeded",
			"filesUsed":      fileLimit.Used,
			"filesReserved":  fileLimit.Reserved,
			"filesRequested": fileLimit.Requested,
			"filesLimit":     fileLimit.Limit,
			"workspaceId":    fileLimit.WorkspaceID,
		})
		return
	}
	var workspaceLimit *store.WorkspaceLimitExceededError
	if errors.As(err, &workspaceLimit) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"code":                "workspace_limit_exceeded",
			"message":             "owned workspace limit exceeded",
			"workspacesUsed":      workspaceLimit.Used,
			"workspacesRequested": workspaceLimit.Requested,
			"workspacesLimit":     workspaceLimit.Limit,
		})
		return
	}
	var busy *providerBusyError
	if errors.As(err, &busy) {
		obs.ResponseError(w, obs.ExpectedError(err))
		w.Header().Set("Retry-After", strconv.Itoa(busy.retryAfter()))
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"code":              "provider_busy",
			"message":           busy.Error(),
			"retryAfterSeconds": busy.retryAfter(),
		})
		return
	}
	if errors.Is(err, errAIUnavailable) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"code":    "ai_unavailable",
			"message": errAIUnavailable.Error(),
		})
		return
	}
	if errors.Is(err, errGenerateEmpty) {
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"code":    "generate_empty",
			"message": errGenerateEmpty.Error(),
		})
		return
	}
	if errors.Is(err, errScopeNoIndexedContent) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code":    "scope_has_no_indexed_content",
			"message": errScopeNoIndexedContent.Error(),
		})
		return
	}
	if errors.Is(err, errContextTooLarge) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code":    "context_too_large",
			"message": errContextTooLarge.Error(),
		})
		return
	}
	if errors.Is(err, errSourceChanged) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "source_changed",
			"message": errSourceChanged.Error(),
		})
		return
	}
	if errors.Is(err, store.ErrTooManyLLMLeases) {
		w.Header().Set("Retry-After", "10")
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"code":    "too_many_streams",
			"message": "too many AI requests in progress",
		})
		return
	}
	if errors.Is(err, store.ErrTooManyIngestLeases) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"code":    "too_many_ingest_leases",
			"message": "too many ingest jobs in progress",
		})
		return
	}
	// Distinct from storage_quota_exceeded on purpose: this one is about the
	// caller's own inference budget, the other is about the workspace owner's
	// disk. They render as completely different messages and only one of them
	// is actionable by the person reading it.
	var credits *store.CreditsExhaustedError
	if errors.As(err, &credits) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"code":                   "llm_credits_exhausted",
			"message":                "monthly AI credits exhausted",
			"creditsUsedMicros":      credits.UsedMicros,
			"creditsReservedMicros":  credits.ReservedMicros,
			"creditsLimitMicros":     credits.LimitMicros,
			"creditsPurchasedMicros": credits.PurchasedMicros,
			"planTier":               string(credits.PlanTier),
		})
		return
	}
	var locked *store.AccountLockedError
	if errors.As(err, &locked) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"code":    locked.Code(),
			"message": "account unavailable",
			"state":   string(locked.State),
			"reason":  locked.Reason,
		})
		return
	}
	writeUnexpected(w, http.StatusInternalServerError)
}

// writeUnexpected is the raw handlers' generic answer to an unexpected
// failure (publicError's): the trace id comes from the X-Request-Id the trace
// middleware already set on this response.
func writeUnexpected(w http.ResponseWriter, status int) {
	writeJSON(w, status, newUnexpectedError(status, w.Header().Get(obs.HeaderRequestID)))
}

// recoverer is chi's Recoverer answering the generic unexpected error: the
// Sentry middleware inside it has already captured the panic. A response
// already under way (a stream) is left as it is.
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}
			middleware.PrintPrettyStack(recovered)
			if started, ok := w.(interface{ Status() int }); ok && started.Status() != 0 {
				return
			}
			if r.Header.Get("Connection") != "Upgrade" {
				writeUnexpected(w, http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func id(r *http.Request) string { return chi.URLParam(r, "id") }

func uid(r *http.Request) string { return auth.UserID(r.Context()) }

// userLocale is the authenticated user's Settings locale. The pipeline uses it
// so chat/generate/editor AI replies in that language; ingest stays English.
// Unknown or missing values fall back to English. Never taken from the client.
func (a *api) userLocale(ctx context.Context, userID string) string {
	if userID == "" {
		return "en"
	}
	u, err := a.s.Me(ctx, userID)
	if err != nil {
		return "en"
	}
	return normalizeUserLocale(u.Locale)
}

func normalizeUserLocale(locale string) string {
	if locale == "zh" {
		return "zh"
	}
	return "en"
}

func randID(prefix string) string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func randInt(min, max int) int {
	n, _ := rand.Int(rand.Reader, big.NewInt(int64(max-min)))
	return min + int(n.Int64())
}

func (a *api) assertWS(w http.ResponseWriter, r *http.Request, wsID string) bool {
	if err := a.s.AssertWorkspaceEditor(r.Context(), uid(r), wsID); err != nil {
		if errors.Is(err, store.ErrForbidden) {
			err = store.ErrNotFound
		}
		a.fail(w, err)
		return false
	}
	return true
}

// chatAccess is what the chat stream needs to know about the actor.
type chatAccess struct {
	// canEdit follows the effective role (owner, member editor, or share-role
	// editor) unless a frozen account makes the workspace read-only: it unlocks
	// the pending-sources notice. role is what the agent-tool
	// operations table is evaluated from; readOnly (frozen) and full (the
	// actor, who pays for what the agent creates, at its storage limit) narrow it.
	canEdit  bool
	readOnly bool
	full     bool
	role     store.WorkspaceRole
}

// assertWSChat admits any effective role (owner, member, or link/public
// visitor) and reports what the actor may do beyond chatting. Chat stays open
// to frozen accounts; a frozen actor makes the turn read-only.
func (a *api) assertWSChat(w http.ResponseWriter, r *http.Request, wsID string) (chatAccess, bool) {
	effective, err := a.s.WorkspaceEffectiveRole(r.Context(), uid(r), wsID)
	if err != nil {
		a.fail(w, err)
		return chatAccess{}, false
	}
	readOnly, full := false, false
	if store.RoleCanEdit(effective) {
		// Only the actor's own account narrows the turn: what the agent creates
		// is charged to the actor (uploader pays), and edits to others' items
		// are gated per item.
		if readOnly, err = a.readOnly(r.Context(), uid(r)); err != nil {
			a.fail(w, err)
			return chatAccess{}, false
		}
		if full, err = a.ownerFull(r.Context(), uid(r)); err != nil {
			a.fail(w, err)
			return chatAccess{}, false
		}
	}
	return chatAccess{
		canEdit: store.RoleCanEdit(effective) && !readOnly, readOnly: readOnly, full: full, role: effective,
	}, true
}

func (a *api) assertWSRead(w http.ResponseWriter, r *http.Request, wsID string) bool {
	if _, err := a.s.WorkspaceAccess(r.Context(), uid(r), wsID); err != nil {
		a.fail(w, err)
		return false
	}
	return true
}

/* ------------------------------------------------------ raw source handlers */

func kindFromName(name string) string {
	return sourceupload.KindFromName(name)
}
