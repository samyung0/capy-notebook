package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/ratelimit"
	"github.com/samyung0/capy-notebook/server/internal/reconcile"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string) bool {
	return os.Getenv(key) == "true"
}

// envList splits a comma-separated env var, dropping blanks. Empty yields nil
// so callers can distinguish "unset" from "set to nothing".
func envList(key string) []string {
	raw := strings.Split(os.Getenv(key), ",")
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// rateLimitConfig disables limiting under e2e, where Playwright drives hundreds
// of requests per second through a handful of fixed users and would otherwise
// trip every budget.
func rateLimitConfig(appEnv string) ratelimit.Config {
	cfg := ratelimit.DefaultConfig()
	if appEnv == "e2e" || envBool("RATE_LIMIT_DISABLED") {
		cfg.Disabled = true
		return cfg
	}
	if n := envInt("RATE_LIMIT_AI_PER_HOUR", 0); n > 0 {
		cfg.AI.Limit = n
	}
	return cfg
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func strongEmailSecret(value string) bool {
	if len(value) < 32 {
		return false
	}
	var classes uint8
	for _, ch := range value {
		switch {
		case ch >= 'a' && ch <= 'z':
			classes |= 1
		case ch >= 'A' && ch <= 'Z':
			classes |= 2
		case ch >= '0' && ch <= '9':
			classes |= 4
		default:
			classes |= 8
		}
	}
	count := 0
	for mask := uint8(1); mask <= 8; mask <<= 1 {
		if classes&mask != 0 {
			count++
		}
	}
	return count >= 3
}

func validateAuthConfiguration(
	appEnv string,
	authDisabled, e2eAuth bool,
	clerkSecret, clerkWebhookSecret string,
) error {
	if authDisabled && appEnv != "development" && !e2eAuth {
		return errors.New("AUTH_DISABLED=true is only allowed when APP_ENV=development")
	}
	if !authDisabled && !e2eAuth && strings.TrimSpace(clerkSecret) == "" {
		return errors.New("CLERK_SECRET_KEY is required unless AUTH_DISABLED or E2E_AUTH is enabled")
	}
	if !authDisabled && !e2eAuth && strings.TrimSpace(clerkWebhookSecret) == "" {
		return errors.New("CLERK_WEBHOOK_SECRET is required unless AUTH_DISABLED or E2E_AUTH is enabled")
	}
	return nil
}

func validateStripeConfiguration(secretKey, webhookSecret, pricePro string) error {
	billingEnabled := strings.TrimSpace(webhookSecret) != "" || strings.TrimSpace(pricePro) != ""
	if billingEnabled && strings.TrimSpace(secretKey) == "" {
		return errors.New("STRIPE_SECRET_KEY is required when Stripe billing is configured")
	}
	return nil
}

func openBlobStore(appEnv string) (blob.Store, error) {
	switch env("BLOB_BACKEND", "b2") {
	case "memory":
		if appEnv != "e2e" {
			return nil, errors.New("blob: memory backend is only allowed when APP_ENV=e2e")
		}
		log.Printf("blob store: in-memory (sharing E2E; upload URLs unsupported)")
		return blob.NewMemory(), nil
	case "disk":
		if appEnv != "e2e" {
			return nil, errors.New("blob: disk backend is only allowed when APP_ENV=e2e")
		}
		root := env("BLOB_DISK_ROOT", os.TempDir()+"/capy-blobs")
		store, err := blob.NewDisk(root)
		if err != nil {
			return nil, err
		}
		log.Printf("blob store: disk root=%s", root)
		return store, nil
	default:
		b2, err := blob.NewB2(blob.B2Config{
			Endpoint:     env("B2_ENDPOINT", ""),
			Region:       env("B2_REGION", ""),
			Bucket:       env("B2_BUCKET", ""),
			KeyID:        env("B2_KEY_ID", ""),
			AppKey:       env("B2_APP_KEY", ""),
			UsePathStyle: envBool("B2_FORCE_PATH_STYLE"),
			PresignTTL:   time.Duration(envInt("B2_PRESIGN_TTL", 900)) * time.Second,
		})
		if err != nil {
			return nil, err
		}
		hctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := b2.HealthCheck(hctx); err != nil {
			return nil, err
		}
		log.Printf("blob store: Backblaze B2 bucket=%s (presigned URLs)", env("B2_BUCKET", ""))
		return b2, nil
	}
}

func main() {
	dsn := env("DATABASE_URL", "postgres://capy:capy@localhost:5432/capy?sslmode=disable")
	addr := env("ADDR", ":8080")
	parser := env("CAPY_PARSER", "marker")
	engine := env("CAPY_ENGINE", "capy")
	appURL := env("APP_URL", "http://localhost:5173")
	appEnv := env("APP_ENV", "development")
	authDisabled := envBool("AUTH_DISABLED")
	clerkSecret := env("CLERK_SECRET_KEY", "")
	clerkWebhookSecret := env("CLERK_WEBHOOK_SECRET", "")
	stripeSecretKey := env("STRIPE_SECRET_KEY", "")
	stripeWebhookSecret := env("STRIPE_WEBHOOK_SECRET", "")
	stripePricePro := env("STRIPE_PRICE_PRO", "")

	// Before anything else logs: this redirects the stdlib logger used
	// throughout the process into structured output.
	obs.Init("gateway", appEnv)
	shutdownSentry := obs.InitSentry(obs.SentryConfig{
		DSN:         env("SENTRY_DSN", ""),
		Environment: env("SENTRY_ENVIRONMENT", appEnv),
		Release:     env("RELEASE_SHA", ""),
		SampleRate:  env("SENTRY_TRACES_SAMPLE_RATE", "0.1"),
		Service:     "gateway",
	})
	defer shutdownSentry()

	emailBackend := env("EMAIL_BACKEND", "")
	resendAPIKey := env("RESEND_API_KEY", "")
	emailFrom := env("EMAIL_FROM", "")
	emailReplyTo := env("EMAIL_REPLY_TO", "")
	emailUnsubscribeSecret := env("EMAIL_UNSUBSCRIBE_SECRET", "")
	if (emailBackend == "resend" || (emailBackend == "" && resendAPIKey != "")) &&
		!strongEmailSecret(emailUnsubscribeSecret) {
		log.Fatal("EMAIL_UNSUBSCRIBE_SECRET must be at least 32 bytes and contain at least 3 character classes when email delivery is enabled")
	}

	e2eAuth := envBool("E2E_AUTH")
	e2eSecret := env("E2E_AUTH_SECRET", "")
	e2eUserIDs := strings.Split(env("E2E_AUTH_USER_IDS", ""), ",")
	if e2eAuth && e2eSecret == "" {
		log.Fatal("E2E_AUTH=true requires a non-empty E2E_AUTH_SECRET")
	}
	if e2eAuth && appEnv != "e2e" {
		log.Fatal("E2E_AUTH=true is only allowed when APP_ENV=e2e")
	}
	if e2eAuth && (len(e2eUserIDs) == 0 || strings.TrimSpace(e2eUserIDs[0]) == "") {
		log.Fatal("E2E_AUTH=true requires E2E_AUTH_USER_IDS")
	}
	if err := validateAuthConfiguration(
		appEnv, authDisabled, e2eAuth, clerkSecret, clerkWebhookSecret,
	); err != nil {
		log.Fatal(err)
	}
	if err := validateStripeConfiguration(
		stripeSecretKey, stripeWebhookSecret, stripePricePro,
	); err != nil {
		log.Fatal(err)
	}
	for i := range e2eUserIDs {
		e2eUserIDs[i] = strings.TrimSpace(e2eUserIDs[i])
	}
	if e2eAuth {
		log.Println("E2E auth enabled (X-E2E-User-Id / X-E2E-Secret)")
	}

	ctx, cancelRuntime := context.WithCancel(context.Background())
	defer cancelRuntime()
	st, err := store.Open(ctx, dsn)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer st.Close()
	st.ConfigureCollaboration(
		env("COLLABORATION_INTERNAL_URL", ""),
		env("COLLABORATION_SECRET", ""),
	)

	blobStore, err := openBlobStore(appEnv)
	if err != nil {
		log.Fatalf("blob store: %v", err)
	}

	pipeSecret := env("PIPELINE_SECRET", "")
	var pipe *pipeline.Client
	if u := env("PIPELINE_URL", ""); u != "" {
		pipe = pipeline.New(u, pipeSecret)
		log.Printf("pipeline at %s", u)
	}

	var rdb *redis.Client
	if u := env("REDIS_URL", ""); u != "" {
		opt, err := redis.ParseURL(u)
		if err != nil {
			log.Fatalf("redis url: %v", err)
		}
		rdb = redis.NewClient(opt)
		defer rdb.Close()
		log.Printf("redis at %s", opt.Addr)
	}

	if env("MIGRATE", "true") == "true" {
		if err := st.Migrate(ctx); err != nil {
			log.Fatalf("migrate: %v", err)
		}
		if store.ShouldApplyDevSeed(appEnv) {
			if err := st.ApplyDevSeed(ctx); err != nil {
				log.Fatalf("dev seed: %v", err)
			}
		}
		log.Println("migrations applied")
	}
	if err := st.LoadPlanLimits(ctx); err != nil {
		log.Fatalf("plan limits: %v", err)
	}
	if err := st.AbortOrphanedStreams(ctx); err != nil {
		log.Fatalf("abort orphaned streams: %v", err)
	}

	modelReg, err := models.New(ctx, st.Pool())
	if err != nil {
		log.Fatalf("model registry: %v", err)
	}
	st.SetModelRegistry(modelReg)
	if credKey, err := store.ParseCredentialKey(env("LLM_CREDENTIALS_KEY", "")); err == nil {
		st.SetLLMCredentialKey(credKey)
	} else if env("LLM_CREDENTIALS_KEY", "") != "" {
		log.Printf("llm credentials key: %v", err)
	}
	go modelReg.Poll(ctx)

	emailSender, err := newEmailSender(appEnv, emailBackend, resendAPIKey, emailFrom, emailReplyTo)
	if err != nil {
		log.Fatalf("email sender: %v", err)
	}
	// E2E asserts on delivered mail over HTTP rather than by parsing container
	// stdout, which depends on the log driver and on flush timing.
	var mailRecorder *mail.RecordingSender
	if appEnv == "e2e" {
		mailRecorder = mail.NewRecordingSender(emailSender)
		emailSender = mailRecorder
	}
	emailDispatcherDone := make(chan struct{})
	go func() {
		defer close(emailDispatcherDone)
		runEmailDispatcher(ctx, st, emailSender, normalizeAppURL(appURL), emailUnsubscribeSecret)
	}()

	go func() {
		expire := func() {
			removed, count, err := st.ExpireWorkspaceInvitesWithResult(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("expire workspace invites: %v", err)
				}
				return
			}
			publishNotificationRemovals(ctx, rdb, removed)
			if count > 0 {
				log.Printf("expired %d workspace invite(s)", count)
			}
		}
		expire()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				expire()
			case <-ctx.Done():
				return
			}
		}
	}()

	go func() {
		prune := func() {
			count, err := st.PruneMaterialRevisions(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("prune material revisions: %v", err)
				}
				return
			}
			if count > 0 {
				log.Printf("pruned %d material revision(s)", count)
			}
		}
		prune()
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				prune()
			case <-ctx.Done():
				return
			}
		}
	}()

	// Upload sweep. Both upload flows share one table, so this is one call; it
	// only writes off reservations and queues object paths. The bucket is never
	// touched here — the reaper below owns that, which is what lets objects
	// orphaned by cascading deletes be collected by the same path.
	go func() {
		sweep := func() {
			if _, err := st.SweepExpiredUploads(ctx, 100); err != nil && ctx.Err() == nil {
				log.Printf("sweep expired uploads: %v", err)
			}
			if err := st.PruneUploadSessions(ctx); err != nil && ctx.Err() == nil {
				log.Printf("prune upload sessions: %v", err)
			}
		}
		sweep()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sweep()
			case <-ctx.Done():
				return
			}
		}
	}()

	go runBlobReaper(ctx, st, blobStore, artifactTTL{
		CaptionDays: envInt("CAPY_CAPTION_CACHE_TTL_DAYS", 90),
	})
	go runBlobSweep(ctx, st, blobStore)
	go runAccountPurgeWorker(ctx, st, clerkSecret != "")
	go runOverQuotaNoticeWorker(ctx, st)
	go runCollaborationEvictionWorker(ctx, st, rdb)

	cfg := httpapi.Config{
		ReleaseSHA:             env("RELEASE_SHA", ""),
		ClerkSecretKey:         clerkSecret,
		ClerkWebhookSecret:     clerkWebhookSecret,
		AuthDisabled:           authDisabled,
		DevUserID:              env("DEV_USER_ID", "u_1"),
		E2EAuth:                e2eAuth,
		E2ESecret:              e2eSecret,
		E2EUserIDs:             e2eUserIDs,
		StripeSecretKey:        stripeSecretKey,
		StripeWebhookSecret:    stripeWebhookSecret,
		StripePricePro:         stripePricePro,
		AppURL:                 appURL,
		EmailUnsubscribeSecret: emailUnsubscribeSecret,
		CollaborationSecret:    env("COLLABORATION_SECRET", "dev-collaboration-secret"),
		CollaborationURL:       env("COLLABORATION_URL", "ws://localhost:1234"),
		PipelineSecret:         pipeSecret,
		AllowedOrigins:         envList("CORS_ALLOWED_ORIGINS"),
		RateLimit:              rateLimitConfig(appEnv),
		ModelRegistry:          modelReg,
	}
	if mailRecorder != nil {
		cfg.MailRecorder = mailRecorder
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(st, blobStore, pipe, rdb, parser, engine, cfg),
		ReadHeaderTimeout: 10 * time.Second,
	}
	runUsageWorkers(ctx, st, reconcile.Config{
		StripeSecretKey: cfg.StripeSecretKey,
		StripePricePro:  cfg.StripePricePro,
	})

	go func() {
		log.Printf("capy-notebook gateway listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("shutting down…")
	cancelRuntime()
	shutCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	select {
	case <-emailDispatcherDone:
	case <-shutCtx.Done():
		log.Println("email dispatcher did not stop before shutdown deadline")
	}
	_ = srv.Shutdown(shutCtx)
}
