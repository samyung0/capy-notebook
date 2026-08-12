package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/evonotes/server/internal/pipeline"
	"github.com/evonotes/server/internal/sourceupload"
	"github.com/evonotes/server/internal/store"
)

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
	notifMu      sync.Mutex
	notifByUser  map[string]int
	notifTotal   int
}

// New builds the full HTTP handler. huma owns every JSON operation (and the
// live OpenAPI spec at /openapi.yaml + docs at /docs); a handful of endpoints
// huma can't model — streaming SSE, multipart upload, blob download redirects,
// webhooks, and the pipeline chat/generate passthrough — stay on raw chi and
// are intentionally absent from the spec.
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
		notifByUser:  make(map[string]int),
	}
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{
			"Content-Type", "Authorization",
			auth.HeaderE2EUserID, auth.HeaderE2ESecret,
		},
		AllowCredentials: false,
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
	r.Post("/api/workspaces/{id}/sources/uploads", a.createSourceUpload)
	r.Post("/api/workspaces/{id}/sources/uploads/{uploadId}/complete", a.completeSourceUpload)
	r.Post("/api/workspaces/{id}/editor-assets/uploads", a.reserveEditorAsset)
	r.Post("/api/workspaces/{id}/editor-assets/uploads/{uploadId}/complete", a.completeEditorAssetUpload)
	r.Post("/api/workspaces/{id}/sources/import", a.importSources)
	r.Get("/api/workspaces/{id}/ingest-events", a.ingestEvents)
	r.Get("/api/editor-assets/{assetId}/resolve", a.resolveEditorAsset)
	r.Post("/api/workspaces/{id}/chat/stream", a.chatStream)
	r.Post("/api/workspaces/{id}/complete/stream", a.completeStream)
	r.Post("/api/workspaces/{id}/ai/command", a.aiCommand)
	r.Post("/api/workspaces/{id}/ai/copilot", a.aiCopilot)
	r.Post("/api/workspaces/{id}/generate", a.generate)
	r.Post("/api/transcribe", a.transcribe)
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

func (a *api) fail(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "not found"})
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
// file 'processing', enqueues an ingest job) and the mock-compatible JSON
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
		b.Kind = "pdf"
	}
	res, err := a.s.AddSource(r.Context(), id(r), b.Name, b.Kind, b.ChapterID, int64(randInt(200, 3200)))
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 201, res)
}

// Parse-mode limits. Advanced runs on the Modal MinerU hybrid backend (we cap
// uploads at 100 MB); normal uses the free MinerU lightweight cloud API
// (their hard limits: 10 MB / 20 pages, page count enforced by MinerU).
const (
	parseModeAdvanced = sourceupload.ParseModeAdvanced
	parseModeNormal   = sourceupload.ParseModeNormal
	parseModeNone     = sourceupload.ParseModeNone

	advancedMaxBytes = sourceupload.AdvancedMaxBytes
	normalMaxBytes   = sourceupload.NormalMaxBytes
	uploadMaxBytes   = sourceupload.UploadMaxBytes // multipart overhead headroom
)

func defaultParseMode(name, kind string) string {
	return sourceupload.DefaultParseMode(name, kind)
}

func validateParseMode(mode, name, kind string, size int64) error {
	return sourceupload.Validate(name, kind, mode, size)
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
	if err := validateParseMode(parseMode, name, kind, hdr.Size); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}

	blobPath, size, err := a.blob.Put(sourceObjectKey(randID("blob")), file)
	if err != nil {
		a.fail(w, err)
		return
	}
	if parseMode == parseModeNone && !sourceupload.IsTextKind(kind) {
		res, err := a.s.CreateSourceReady(r.Context(), id(r), uid(r), name, kind, chapterID, chapterName, size, blobPath)
		if err != nil {
			_ = a.blob.Delete(r.Context(), blobPath)
			a.fail(w, err)
			return
		}
		writeJSON(w, 201, res)
		return
	}
	res, _, err := a.s.CreateSourceWithJob(r.Context(), id(r), uid(r), name, kind, chapterID, chapterName, size, blobPath, a.parser, a.engine, parseMode)
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

/* -------------------------------------------------------------- generation

   Kept on raw chi because the pipeline path is a passthrough of arbitrary JSON
   and generate is polymorphic. */

type generateOpts struct {
	Kind         store.MaterialKind `json:"kind"`
	Length       string             `json:"length"`
	Format       string             `json:"format"`
	Count        int                `json:"count"`
	Style        string             `json:"style"`
	Types        []string           `json:"types"`
	Levels       []string           `json:"levels"`      // cognitive levels: recall|application|analysis
	Difficulty   []string           `json:"difficulty"`  // legacy alias, still accepted
	Chapters     []string           `json:"chapters"`    // chapter ids; resolved to files + names in resolveScope
	FileIds      []string           `json:"fileIds"`     // file-scoped retrieval filtering
	Detail       string             `json:"detail"`      // mindmap: brief|standard|detailed
	DiagramType  string             `json:"diagramType"` // diagram: auto|flowchart|sequence|class|state|er
	TimeLimitMin *int               `json:"timeLimitMin"`
}

// cognitiveLevels resolves the requested levels, accepting the legacy
// difficulty field and mapping its values onto the new labels.
func (o generateOpts) cognitiveLevels() []string {
	if len(o.Levels) > 0 {
		return o.Levels
	}
	if len(o.Difficulty) > 0 {
		mapped := make([]string, 0, len(o.Difficulty))
		for _, d := range o.Difficulty {
			switch d {
			case "easy":
				mapped = append(mapped, "recall")
			case "hard":
				mapped = append(mapped, "analysis")
			default:
				mapped = append(mapped, "application")
			}
		}
		return mapped
	}
	return []string{"recall", "application"}
}

func (a *api) generate(w http.ResponseWriter, r *http.Request) {
	if !a.assertWS(w, r, id(r)) {
		return
	}
	// Model spend is the actor's; the material it produces is the workspace
	// owner's and is gated by gateStorageTx further down.
	if err := a.generationCreditsAllowed(r.Context(), uid(r)); err != nil {
		a.fail(w, err)
		return
	}
	var opts generateOpts
	if err := decode(r, &opts); err != nil {
		a.fail(w, err)
		return
	}
	wsID := id(r)
	wsName := "Workspace"
	if ws, err := a.s.GetWorkspaceShared(r.Context(), wsID); err == nil {
		wsName = ws.Name
	}

	userID := uid(r)
	if a.pipe != nil {
		if payload, ok, err := a.generateViaPipe(r.Context(), userID, wsID, wsName, &opts); err != nil {
			a.fail(w, err)
			return
		} else if ok {
			writeJSON(w, 200, payload)
			return
		}
	}
	payload, err := a.generateLocal(r.Context(), userID, wsID, wsName, opts)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, payload)
}

// resolveScope maps the requested generation scope into concrete file ids for
// retrieval filtering, file-name snapshots for material provenance, and
// chapter-name snapshots for display and the pipeline's scope hint.
//
// Chapters arrive as ids (stable across rename), matched by id against the
// workspace's chapter records; their member files union with any explicitly
// selected file ids. Requested order is preserved for names. An empty fileIDs
// result means "whole workspace" (no filtering).
func (a *api) resolveScope(ctx context.Context, wsID string, opts *generateOpts) (fileIDs, fileNames, chapterNames []string) {
	seen := map[string]struct{}{}
	fileIDs = make([]string, 0, len(opts.FileIds))
	fileNamesByID := map[string]string{}
	if files, err := a.s.ListFiles(ctx, "", wsID); err == nil {
		for _, file := range files {
			fileNamesByID[file.ID] = file.Name
		}
	}
	add := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		fileIDs = append(fileIDs, id)
	}
	for _, id := range opts.FileIds {
		add(id)
	}
	if len(opts.Chapters) > 0 {
		if chapters, err := a.s.ListChapters(ctx, wsID); err == nil {
			byID := make(map[string]store.Chapter, len(chapters))
			for _, ch := range chapters {
				byID[ch.ID] = ch
			}
			for _, id := range opts.Chapters {
				ch, ok := byID[id]
				if !ok {
					continue
				}
				chapterNames = append(chapterNames, ch.Name)
				for _, fid := range ch.FileIDs {
					add(fid)
				}
			}
		}
	}
	fileNames = make([]string, 0, len(fileIDs))
	for _, id := range fileIDs {
		if name, ok := fileNamesByID[id]; ok {
			fileNames = append(fileNames, name)
		}
	}
	return fileIDs, fileNames, chapterNames
}

// generateViaPipe asks the retrieval service to produce grounded output, then
// persists it (quiz -> quizzes, flashcards -> deck+cards, mindmap/diagram ->
// materials) so every artifact shows up in the workspace materials list.
func (a *api) generateViaPipe(
	ctx context.Context,
	userID, wsID, wsName string,
	opts *generateOpts,
) (any, bool, error) {
	fileIDs, fileNames, chapterNames := a.resolveScope(ctx, wsID, opts)
	body := map[string]any{
		"workspaceId": wsID, "kind": opts.Kind, "length": opts.Length, "format": opts.Format,
		"count": opts.Count, "style": opts.Style, "types": opts.Types, "levels": opts.cognitiveLevels(),
		"chapters": chapterNames, "fileIds": fileIDs,
		"detail": opts.Detail, "diagramType": opts.DiagramType, "timeLimitMin": opts.TimeLimitMin,
	}
	raw, err := a.pipe.PostRaw(ctx, "/generate", body)
	if err != nil {
		return nil, false, nil
	}
	var head struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &head) != nil {
		return nil, false, nil
	}
	switch head.Kind {
	case "quiz":
		var qp struct {
			Name         string          `json:"name"`
			Chapters     []string        `json:"chapters"`
			Questions    json.RawMessage `json:"questions"`
			TimeLimitMin *int            `json:"timeLimitMin"`
		}
		_ = json.Unmarshal(raw, &qp)
		name := qp.Name
		if name == "" {
			name = wsName + " quiz"
		}
		chapters := qp.Chapters
		if chapters == nil {
			chapters = chapterNames
		}
		quiz, err := a.s.CreateQuiz(ctx, store.Quiz{
			UserID: userID, Name: name, WorkspaceID: wsID, WorkspaceName: wsName, Chapters: chapters,
			Questions: qp.Questions, Privacy: "private", TimeLimitMin: qp.TimeLimitMin,
		})
		if err != nil {
			return nil, false, err
		}
		return map[string]any{"kind": "quiz", "quiz": quiz}, true, nil
	case "flashcards":
		var fp struct {
			Cards []struct {
				Front string `json:"front"`
				Back  string `json:"back"`
			} `json:"cards"`
		}
		_ = json.Unmarshal(raw, &fp)
		fronts := make([][2]string, 0, len(fp.Cards))
		for _, c := range fp.Cards {
			fronts = append(fronts, [2]string{c.Front, c.Back})
		}
		res, err := a.persistDeck(ctx, userID, wsID, wsName, fronts)
		if err != nil {
			return nil, false, err
		}
		return res, true, nil
	case "mindmap", "diagram":
		var mp struct {
			Title   string `json:"title"`
			Content string `json:"content"`
		}
		_ = json.Unmarshal(raw, &mp)
		res, err := a.persistMaterial(ctx, userID, wsID, wsName, store.MaterialKind(head.Kind), mp.Title, mp.Content, opts, chapterNames, fileNames)
		if err != nil {
			return nil, false, err
		}
		return res, true, nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil, false, nil
	}
	return m, true, nil
}

// generateLocal is the offline fallback (and the mock-parity generator).
func (a *api) generateLocal(ctx context.Context, userID, wsID, wsName string, opts generateOpts) (any, error) {
	_, fileNames, chapterNames := a.resolveScope(ctx, wsID, &opts)
	switch opts.Kind {
	case "flashcards":
		n := opts.Count
		if n <= 0 {
			n = 10
		}
		cards := make([][2]string, 0, n)
		for i := 0; i < n; i++ {
			cards = append(cards, [2]string{fmt.Sprintf("Term %d", i+1), fmt.Sprintf("Definition for term %d.", i+1)})
		}
		return a.persistDeck(ctx, userID, wsID, wsName, cards)
	case "mindmap", "diagram":
		return a.persistMaterial(ctx, userID, wsID, wsName, opts.Kind, "", localMaterialContent(wsName, opts), &opts, chapterNames, fileNames)
	default:
		quiz, err := a.s.CreateQuiz(ctx, store.Quiz{
			UserID: userID, Name: wsName + " quiz", WorkspaceID: wsID, WorkspaceName: wsName,
			Chapters: chapterNames, Questions: buildQuestions(opts), Privacy: "private", TimeLimitMin: opts.TimeLimitMin,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"kind": "quiz", "quiz": quiz}, nil
	}
}

// persistDeck creates a real deck + cards so generated flashcards appear in the
// library and the workspace materials list.
func (a *api) persistDeck(ctx context.Context, userID, wsID, wsName string, cards [][2]string) (any, error) {
	deck, err := a.s.CreateDeckWithCards(
		ctx, userID, wsName+" flashcards", "green", wsID, cards,
	)
	if err != nil {
		return nil, err
	}
	out, err := a.s.ListCards(ctx, deck.ID)
	if err != nil {
		return nil, err
	}
	deck, _ = a.s.GetDeck(ctx, deck.ID)
	return map[string]any{"kind": "flashcards", "deck": deck, "cards": out}, nil
}

// persistMaterial stores a generated mindmap/diagram markdown document.
// Scope values are immutable display-name snapshots, not entity references.
//
// userID is the author. Without it CreateMaterial falls back to the workspace
// owner, which records a generation an editor ran as the owner's own work.
func (a *api) persistMaterial(ctx context.Context, userID, wsID, wsName string, kind store.MaterialKind, title, content string, opts *generateOpts, chapterNames, fileNames []string) (any, error) {
	if title == "" {
		title = wsName + " " + string(kind)
	}
	if content == "" {
		content = localMaterialContent(wsName, *opts)
	}
	mt, err := a.s.CreateMaterial(ctx, store.Material{
		CreatedBy: userID, WorkspaceID: wsID, WorkspaceName: wsName, Kind: kind, Title: title,
		Content: content, ScopeChapters: chapterNames, ScopeFileNames: fileNames, Privacy: "private",
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"kind": kind, "material": mt}, nil
}

// localMaterialContent is the offline mermaid document for mindmaps/diagrams.
func localMaterialContent(wsName string, opts generateOpts) string {
	if opts.Kind == "mindmap" {
		return "# " + wsName + " mindmap\n\n```mermaid\nmindmap\n  root((Topic))\n    Key idea A\n      Detail 1\n      Detail 2\n    Key idea B\n      Detail 3\n```"
	}
	return "# " + wsName + " diagram\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Process]\n  B --> C{Decision}\n  C -->|Yes| D[Outcome 1]\n  C -->|No| E[Outcome 2]\n```"
}

// buildQuestions mirrors the generator in src/mocks/handlers.ts so generated
// quizzes match the QuestionRunner's expected shapes for every type. Free-text
// arrays (options/accepted/items) are object-wrapped ({value}) so the frontend
// can bind them with react-hook-form useFieldArray.
func buildQuestions(opts generateOpts) json.RawMessage {
	types := opts.Types
	if len(types) == 0 {
		types = []string{"mcq"}
	}
	levels := opts.cognitiveLevels()
	n := opts.Count
	if n <= 0 {
		n = 5
	}
	arr := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		t := types[i%len(types)]
		lvl := levels[i%len(levels)]
		q := map[string]any{"id": randID("q"), "type": t, "level": lvl, "prompt": fmt.Sprintf("Generated %s question %d?", t, i+1)}
		switch t {
		case "boolean":
			q["correct"] = true
			q["explanation"] = "This statement is true based on your sources."
		case "fill", "short":
			q["accepted"] = wrapValues("answer")
			q["explanation"] = "The accepted answer follows from the source material."
		case "ordering":
			q["items"] = wrapValues("First", "Second", "Third")
		case "matching":
			q["pairs"] = []map[string]string{{"left": "A", "right": "1"}, {"left": "B", "right": "2"}}
		case "multi":
			q["options"] = wrapOptions(
				[2]string{"A", "Correct — supported by the material."},
				[2]string{"B", "Incorrect for this question."},
				[2]string{"C", "Correct — also supported."},
				[2]string{"D", "Incorrect for this question."},
			)
			q["correct"] = []int{0, 2}
		default:
			q["type"] = "mcq"
			q["options"] = wrapOptions(
				[2]string{"A", "Correct — this is the best answer."},
				[2]string{"B", "Incorrect — a common distractor."},
				[2]string{"C", "Incorrect for this question."},
				[2]string{"D", "Incorrect for this question."},
			)
			q["correct"] = []int{0}
		}
		arr = append(arr, q)
	}
	b, _ := json.Marshal(arr)
	return b
}

// wrapValues shapes bare strings as [{value}] for useFieldArray compatibility.
func wrapValues(ss ...string) []map[string]string {
	out := make([]map[string]string, len(ss))
	for i, s := range ss {
		out[i] = map[string]string{"value": s}
	}
	return out
}

// wrapOptions shapes [value, explanation] pairs as [{value, explanation}] so
// mcq/multi options carry per-option explanations (why each is right/wrong).
func wrapOptions(pairs ...[2]string) []map[string]string {
	out := make([]map[string]string, len(pairs))
	for i, p := range pairs {
		out[i] = map[string]string{"value": p[0], "explanation": p[1]}
	}
	return out
}
