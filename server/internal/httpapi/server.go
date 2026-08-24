package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"sync"

	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/redis/go-redis/v9"

	"github.com/evonotes/server/internal/auth"
	"github.com/evonotes/server/internal/billing"
	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/mail"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/pipeline"
	"github.com/evonotes/server/internal/ratelimit"
	"github.com/evonotes/server/internal/sourceupload"
	"github.com/evonotes/server/internal/store"
)

// corsOrigins falls back to "*" when no allowlist is configured. Bearer tokens
// are sent explicitly rather than as cookies and AllowCredentials is false, so
// the wildcard is not a session-theft vector; it is still narrowed in
// production so a hostile page cannot drive the API from a user's browser.
func corsOrigins(configured []string) []string {
	if len(configured) == 0 {
		return []string{"*"}
	}
	return configured
}

// Config holds gateway settings for auth and billing. Provider OAuth
// (Google/Microsoft/Notion) is managed entirely by Clerk.
type Config struct {
	ClerkSecretKey     string
	ClerkWebhookSecret string
	AuthDisabled       bool
	DevUserID          string
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
	// AllowedOrigins is the CORS allowlist. Empty means "*", which is what dev
	// and e2e run with; production sets it once the SPA and API live on
	// different hostnames.
	AllowedOrigins []string
	// RateLimit governs per-user and per-IP request limits. The zero value
	// disables limiting entirely.
	RateLimit ratelimit.Config
	// ModelRegistry is the process-wide model config cache. Nil disables
	// per-model pricing and pinning (tests).
	ModelRegistry *models.Registry
	// PipelineSecret authenticates the retrieval service's callbacks into
	// /api/internal/*. Empty disables those routes entirely.
	PipelineSecret string
	// MailRecorder exposes delivered mail to Playwright. Non-nil only under
	// APP_ENV=e2e.
	MailRecorder mail.Recorder
}

type api struct {
	s            *store.Store
	wh           webhookStore
	blob         blob.Store
	pipe         *pipeline.Client
	rdb          *redis.Client
	parser       string
	engine       string
	cfg          Config
	mailRecorder mail.Recorder
	limiter      *ratelimit.Limiter
	modelReg     *models.Registry
	notifMu      sync.Mutex
	notifByUser  map[string]int
	notifTotal   int
}

// New builds the full HTTP handler. huma owns every JSON operation (and the
// live OpenAPI spec at /openapi.yaml + docs at /docs); a handful of endpoints
// huma can't model — streaming SSE, multipart upload, blob download redirects,
// webhooks, and the pipeline chat passthrough — stay on raw chi and are
// intentionally absent from the spec. /api/internal/* stays off Huma so Orval
// does not generate a browser client for the service-to-service secret.
func New(s *store.Store, b blob.Store, pipe *pipeline.Client, rdb *redis.Client, parser, engine string, cfg Config) http.Handler {
	billing.Init(billing.Config{SecretKey: cfg.StripeSecretKey})
	a := &api{
		s:            s,
		wh:           s,
		blob:         b,
		pipe:         pipe,
		rdb:          rdb,
		parser:       parser,
		engine:       engine,
		cfg:          cfg,
		mailRecorder: cfg.MailRecorder,
		limiter:      ratelimit.New(rdb, cfg.RateLimit),
		modelReg:     cfg.ModelRegistry,
		notifByUser:  make(map[string]int),
	}
	r := chi.NewRouter()
	// Trace first so the recovery handler and every log line below it can name
	// the request; access logging second so it records panics as 500s.
	r.Use(obs.Middleware)
	r.Use(obs.AccessLog)
	r.Use(obs.SentryMiddleware)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: corsOrigins(cfg.AllowedOrigins),
		AllowedMethods: []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{
			"Content-Type", "Authorization", obs.HeaderTraceparent,
			auth.HeaderE2EUserID, auth.HeaderE2ESecret,
		},
		ExposedHeaders:   []string{obs.HeaderRequestID},
		AllowCredentials: false,
		MaxAge:           600,
	}))
	r.Use(auth.Middleware(auth.Config{
		SecretKey:  cfg.ClerkSecretKey,
		Disabled:   cfg.AuthDisabled,
		DevUserID:  cfg.DevUserID,
		E2EAuth:    cfg.E2EAuth,
		E2ESecret:  cfg.E2ESecret,
		E2EUserIDs: cfg.E2EUserIDs,
		Store:      s,
		PublicPrefix: []string{
			"/api/email/unsubscribe",
			// Service-to-service, authenticated by X-Pipeline-Secret inside the
			// handler; there is no Clerk session to verify.
			"/api/internal/",
		},
		PublicReadPrefix: []string{
			"/api/workspaces/",
			"/api/files/",
			"/api/editor-assets/",
			"/api/materials/",
			"/api/quizzes/",
			"/api/decks/",
			"/api/explore/",
		},
	}))
	// After auth: limits are per user wherever there is one, and only fall back
	// to the client IP for anonymous public reads.
	r.Use(ratelimit.Middleware(a.limiter, uid))

	// Mount huma on the chi router. Doc/spec routes register at construction, so
	// this must come after all r.Use(...) calls.
	humaAPI := humachi.New(r, humaConfig())
	registerRoutes(humaAPI, a)

	// Raw (OpenAPI-excluded) routes.
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	r.Post("/webhooks/clerk", a.clerkWebhook)
	r.Post("/webhooks/stripe", a.stripeWebhook)
	r.Get("/api/notifications/stream", a.notificationEvents)
	r.Get("/api/email/unsubscribe", a.emailUnsubscribe)
	r.Post("/api/email/unsubscribe", a.emailUnsubscribe)
	if cfg.E2EAuth && a.mailRecorder != nil {
		r.Get("/api/e2e/emails", a.e2eEmails)
	}
	r.Post("/api/workspaces/{id}/sources", a.addSource)
	r.Post("/api/workspaces/{id}/editor-assets/uploads", a.reserveEditorAsset)
	r.Post("/api/workspaces/{id}/editor-assets/uploads/{uploadId}/complete", a.completeEditorAssetUpload)
	r.Get("/api/workspaces/{id}/ingest-events", a.ingestEvents)
	r.Get("/api/editor-assets/{assetId}/resolve", a.resolveEditorAsset)
	r.Post("/api/workspaces/{id}/chat/stream", a.chatStream)
	r.Post("/api/workspaces/{id}/complete/stream", a.completeStream)
	r.Post("/api/workspaces/{id}/ai/command", a.aiCommand)
	r.Post("/api/workspaces/{id}/ai/copilot", a.aiCopilot)
	if cfg.PipelineSecret != "" {
		r.Post("/api/internal/materials", a.internalCreateMaterial)
	}
	r.Get("/api/files/{id}/raw", a.getFileRaw)

	return r
}

/* ------------------------------------------------------------------ helpers */

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

// errGenerateEmpty is a 200-shaped pipeline miss: the model ran, but the
// reply could not become a material. Distinct from errAIUnavailable so a
// blank mindmap is not reported as the retrieval process being down.
var errGenerateEmpty = errors.New("the model returned no usable material")

func (a *api) fail(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "not found"})
		return
	}
	if errors.Is(err, store.ErrModelKeyRequired) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code":    "model_key_required",
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
	if errors.Is(err, store.ErrTitleTaken) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "title_taken",
			"message": "a material with this name already exists in this workspace",
		})
		return
	}
	var quota *store.QuotaExceededError
	if errors.As(err, &quota) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"code":                  "storage_quota_exceeded",
			"message":               "storage quota exceeded",
			"storageUsedBytes":      quota.UsedBytes,
			"storageReservedBytes":  quota.ReservedBytes,
			"storageRequestedBytes": quota.RequestedBytes,
			"storageLimitBytes":     quota.LimitBytes,
			"ownerUserId":           quota.UserID,
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
	if errors.Is(err, store.ErrInvalidLLMKey) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code":    "invalid_llm_key",
			"message": "the provider rejected this key",
		})
		return
	}
	if errors.Is(err, store.ErrLLMKeyFailed) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code":    "llm_key_failed",
			"message": "Something went wrong, please double check if the key is valid",
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
			"code":                  "llm_credits_exhausted",
			"message":               "monthly AI credits exhausted",
			"creditsUsedMicros":     credits.UsedMicros,
			"creditsReservedMicros": credits.ReservedMicros,
			"creditsLimitMicros":    credits.LimitMicros,
			"planTier":              string(credits.PlanTier),
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
	writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
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

func (a *api) assertWSRead(w http.ResponseWriter, r *http.Request, wsID string) bool {
	if _, err := a.s.WorkspaceAccess(r.Context(), uid(r), wsID); err != nil {
		a.fail(w, err)
		return false
	}
	return true
}

/* ------------------------------------------------------ raw source handlers */

// addSource handles both the real upload (multipart: stores bytes, marks the
// file 'pending', enqueues an ingest job) and the mock-compatible JSON
// metadata path (no bytes, lands 'ready').
//
// Storage is charged to the workspace owner, so the lifecycle and quota gate is
// the owner's and lives in gateStorageTx. An actor-level account check here
// would block an over-quota editor from contributing to a workspace whose owner
// has room, which no other upload path does.
func (a *api) addSource(w http.ResponseWriter, r *http.Request) {
	if !a.assertWS(w, r, id(r)) {
		return
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		a.uploadSource(w, r)
		return
	}
	var b struct {
		Name      string  `json:"name"`
		Kind      string  `json:"kind"`
		ChapterID *string `json:"chapterId"`
	}
	if err := decode(r, &b); err != nil {
		a.fail(w, err)
		return
	}
	if b.Kind == "" {
		b.Kind = kindFromName(b.Name)
	}
	res, err := a.s.AddSource(r.Context(), id(r), b.Name, b.Kind, b.ChapterID, int64(randInt(200, 3200)))
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 201, res)
}

// Multipart body ceiling. Per-file source caps are plan-aware (10 MB free /
// 30 MB Pro) and enforced after we know the workspace owner; this limit only
// stops an oversized request before that lookup.
const (
	uploadMaxBytes = sourceupload.UploadMaxBytes // multipart overhead headroom
)

func defaultParseMode(name, kind string) string {
	return sourceupload.DefaultParseMode(name, kind)
}

func validateParseMode(mode, name, kind string, size, maxBytes int64) error {
	return sourceupload.Validate(name, kind, mode, size, maxBytes)
}

func (a *api) sourceMaxBytes(ctx context.Context, wsID string) (int64, error) {
	if wsID != "" {
		tier, err := a.s.WorkspaceOwnerPlan(ctx, wsID)
		if err != nil {
			return 0, err
		}
		return sourceupload.SourceMaxBytes(tier == store.PlanPro), nil
	}
	me, err := a.s.Me(ctx, userID(ctx))
	if err != nil {
		return 0, err
	}
	return sourceupload.SourceMaxBytes(me.PlanTier == store.PlanPro), nil
}

func (a *api) uploadSource(w http.ResponseWriter, r *http.Request) {
	if a.blob == nil {
		a.fail(w, errors.New("blob store not configured"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, uploadMaxBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "upload too large or malformed: " + err.Error()})
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		a.fail(w, err)
		return
	}
	defer file.Close()

	name := r.FormValue("name")
	if name == "" {
		name = hdr.Filename
	}
	kind := r.FormValue("kind")
	if kind == "" {
		kind = kindFromName(name)
	}
	var chapterID *string
	if c := r.FormValue("chapterId"); c != "" {
		chapterID = &c
	}
	chapterName := strings.TrimSpace(r.FormValue("chapterName"))
	if len(chapterName) > 255 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "chapter name must be at most 255 characters"})
		return
	}
	if chapterID != nil && chapterName != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "chapterId and chapterName cannot both be set"})
		return
	}
	if chapterID != nil {
		chapterWorkspace, err := a.s.ChapterWorkspaceID(r.Context(), *chapterID)
		if err != nil || chapterWorkspace != id(r) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "chapter does not belong to this workspace"})
			return
		}
	}
	parseMode := r.FormValue("parseMode")
	if parseMode == "" {
		parseMode = defaultParseMode(name, kind)
	}
	maxBytes, err := a.sourceMaxBytes(r.Context(), id(r))
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := validateParseMode(parseMode, name, kind, hdr.Size, maxBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}
	captionImages := sourceupload.NormalizeCaptionImages(kind, parseMode, r.FormValue("captionImages") == "true")

	if sourceupload.NeedsIngestJob(kind, parseMode) {
		if err := a.s.AssertCreditsAvailable(r.Context(), uid(r)); err != nil {
			a.fail(w, err)
			return
		}
	}

	blobPath, size, err := a.blob.Put(sourceObjectKey(randID("blob")), file)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !sourceupload.NeedsIngestJob(kind, parseMode) {
		res, err := a.s.CreateSourceReady(r.Context(), id(r), uid(r), name, kind, chapterID, chapterName, size, blobPath)
		if err != nil {
			_ = a.blob.Delete(r.Context(), blobPath)
			a.fail(w, err)
			return
		}
		writeJSON(w, 201, res)
		return
	}
	res, _, err := a.s.CreateSourceWithJob(r.Context(), id(r), uid(r), name, kind, chapterID, chapterName, size, blobPath, a.parser, a.engine, parseMode, captionImages)
	if err != nil {
		_ = a.blob.Delete(r.Context(), blobPath)
		a.fail(w, err)
		return
	}
	writeJSON(w, 201, res)
}

func (a *api) getFileRaw(w http.ResponseWriter, r *http.Request) {
	// Owners plus link/public viewers (shared workspaces expose their sources).
	if _, err := a.fileRead(r.Context(), id(r)); err != nil {
		a.fail(w, err)
		return
	}
	blobPath, kind, content, url, err := a.s.FileBlob(r.Context(), id(r))
	if err != nil {
		a.fail(w, err)
		return
	}
	switch {
	case blobPath != "" && a.blob != nil:
		// B2 redirects to a short-lived presigned URL so bytes never proxy
		// through the gateway.
		signed, err := a.blob.PresignGet(r.Context(), blobPath)
		if err != nil {
			a.fail(w, err)
			return
		}
		http.Redirect(w, r, signed, http.StatusFound)
	case content != nil:
		w.Header().Set("Content-Type", contentType(kind))
		_, _ = w.Write([]byte(*content))
	case url != nil && *url != "" && !strings.HasPrefix(*url, "/api/"):
		http.Redirect(w, r, *url, http.StatusFound)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "no content"})
	}
}

func kindFromName(name string) string {
	return sourceupload.KindFromName(name)
}

func contentType(kind string) string {
	switch kind {
	case "pdf":
		return "application/pdf"
	case "md", "txt", "doc":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}
