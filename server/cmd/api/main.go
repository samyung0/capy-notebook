package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	svix "github.com/svix/svix-webhooks/go"

	"github.com/samyung0/capy-notebook/server/internal/alibaba"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/jev"
	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/questions"
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
func rateLimitConfig(appEnv, shareLinkSecret string) ratelimit.Config {
	cfg := ratelimit.DefaultConfig()
	cfg.ShareReadSecret = []byte(shareLinkSecret)
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

// requiredPageCap reads a parser page limit the API shares with the ingest host
// through deploy/env-manifest.json. There is no default: a missing or bad
// value stops the API instead of serving a limit the parser does not enforce.
func requiredPageCap(key string) (int, error) {
	n, err := strconv.Atoi(os.Getenv(key))
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%s must be set to a positive page count", key)
	}
	return n, nil
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

// validateServiceSecrets refuses, outside development and e2e, a set
// PIPELINE_SECRET or the COLLABORATION_SECRET in use (its unset default is the
// development value) shorter than 32 characters, as SHARE_LINK_SECRET's floor.
// Local stacks keep their short development values.
func validateServiceSecrets(appEnv, pipelineSecret, collaborationSecret string) error {
	if appEnv == "development" || appEnv == "e2e" {
		return nil
	}
	if pipelineSecret != "" && len(pipelineSecret) < 32 {
		return errors.New("PIPELINE_SECRET must be at least 32 characters")
	}
	if len(collaborationSecret) < 32 {
		return errors.New("COLLABORATION_SECRET must be at least 32 characters and match the collaboration server's")
	}
	return nil
}

// validateTurnstileSecret refuses, outside development and e2e, a gateway
// without TURNSTILE_SECRET_KEY: every gateway serves signed-out grading, whose
// answer checks it verifies with Turnstile (Epo 2026-10-24, Q271). Local
// stacks set Cloudflare's published test secret.
func validateTurnstileSecret(appEnv, secret string) error {
	if appEnv == "development" || appEnv == "e2e" {
		return nil
	}
	if secret == "" {
		return errors.New("TURNSTILE_SECRET_KEY is required: signed-out answer checks are verified with Turnstile")
	}
	if slices.Contains(turnstileTestSecrets, secret) {
		return errors.New("TURNSTILE_SECRET_KEY is one of Cloudflare's published test secrets, which verify nothing")
	}
	return nil
}

// turnstileTestSecrets are Cloudflare's published test secrets: they pass,
// fail or spend every token, so a deployed gateway refuses them (Q308).
var turnstileTestSecrets = []string{
	"1x0000000000000000000000000000000AA",
	"2x0000000000000000000000000000000AA",
	"3x0000000000000000000000000000000AA",
}

// turnstileHosts are the hosts a signed-out check's Turnstile token must have
// been solved on (Q308): the app hosts of APP_URL, CORS_ALLOWED_ORIGINS and
// COLLABORATION_ALLOWED_ORIGINS (UAT's lists hold uat and local.uat). Development and e2e use Cloudflare's test keys, whose tokens
// name no app host, so they check none. Elsewhere an empty list would check
// no host, so the gateway refuses to boot (Q350).
func turnstileHosts(appEnv string, origins ...string) ([]string, error) {
	if appEnv == "development" || appEnv == "e2e" {
		return nil, nil
	}
	var hosts []string
	for _, origin := range origins {
		u, err := url.Parse(origin)
		if err != nil || u.Hostname() == "" {
			continue
		}
		if host := strings.ToLower(u.Hostname()); !slices.Contains(hosts, host) {
			hosts = append(hosts, host)
		}
	}
	if len(hosts) == 0 {
		return nil, errors.New("no app host for Turnstile tokens: APP_URL, CORS_ALLOWED_ORIGINS and COLLABORATION_ALLOWED_ORIGINS name none")
	}
	return hosts, nil
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
	// A malformed secret would answer every delivery 500 after reading it,
	// which the provider retries.
	if strings.TrimSpace(clerkWebhookSecret) != "" {
		if _, err := svix.NewWebhook(clerkWebhookSecret); err != nil {
			return errors.New("CLERK_WEBHOOK_SECRET is not a Svix signing secret (whsec_ followed by base64)")
		}
	}
	return nil
}

// originConfiguration reads the CORS allowlist and the origins whose Clerk
// session tokens are accepted (their azp: COLLABORATION_ALLOWED_ORIGINS). A
// deployed gateway refuses to boot without the first or with a `*` in it, or
// with Clerk on and without the second (human deployment-runbook and
// authorization, 2026-10-21). Development and e2e reach the API through a
// same-origin proxy, so they may run without.
func originConfiguration(appEnv string, clerkOn bool) (corsOrigins, authorizedParties []string, err error) {
	corsOrigins = envList("CORS_ALLOWED_ORIGINS")
	authorizedParties = envList("COLLABORATION_ALLOWED_ORIGINS")
	if appEnv == "development" || appEnv == "e2e" {
		return corsOrigins, authorizedParties, nil
	}
	if len(corsOrigins) == 0 {
		return nil, nil, errors.New("CORS_ALLOWED_ORIGINS is required outside development and e2e")
	}
	if strings.Contains(strings.Join(corsOrigins, ","), "*") {
		return nil, nil, errors.New("CORS_ALLOWED_ORIGINS must list exact origins, without *, outside development and e2e")
	}
	if clerkOn && len(authorizedParties) == 0 {
		return nil, nil, errors.New("COLLABORATION_ALLOWED_ORIGINS is required with Clerk outside development and e2e")
	}
	return corsOrigins, authorizedParties, nil
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
		log.Printf("blob store: in-memory (E2E; objects served under %s)", blob.ServedPath)
		return blob.NewServedMemory(), nil
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
			LinkTTL:      time.Duration(envInt("B2_LINK_TTL", 300)) * time.Second,
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
	parser := env("CAPY_PARSER", "opendataloader")
	appURL := env("APP_URL", "http://localhost:5173")
	// Every start names its environment, so local-only behaviour (AUTH_DISABLED,
	// API docs, the dev seed) never comes from a missing value.
	appEnv := os.Getenv("APP_ENV")
	if appEnv == "" {
		log.Fatal("APP_ENV must be set: development locally, e2e on the test stack, production when deployed")
	}
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
	cloudflareAccountID := env("CLOUDFLARE_ACCOUNT_ID", "")
	cloudflareEmailToken := env("CLOUDFLARE_EMAIL_TOKEN", "")
	emailFrom := env("EMAIL_FROM", "")
	emailReplyTo := env("EMAIL_REPLY_TO", "")
	emailUnsubscribeSecret := env("EMAIL_UNSUBSCRIBE_SECRET", "")
	if (emailBackend == "cloudflare" || (emailBackend == "" && cloudflareEmailToken != "")) &&
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
	corsOrigins, authorizedParties, err := originConfiguration(
		appEnv, strings.TrimSpace(clerkSecret) != "" && !authDisabled,
	)
	if err != nil {
		log.Fatal(err)
	}
	parseMaxPages, err := requiredPageCap("CAPY_PARSE_MAX_PAGES")
	if err != nil {
		log.Fatal(err)
	}
	parseMaxOCRPages, err := requiredPageCap("CAPY_PARSE_OCR_PAGE_CAP")
	if err != nil {
		log.Fatal(err)
	}
	voice, err := alibaba.New(env("ALIBABA_MODELSTUDIO_KEY", ""), env("ALIBABA_MODELSTUDIO_URL", ""))
	if err != nil {
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
	shareLinkSecret := os.Getenv("SHARE_LINK_SECRET")
	if len(shareLinkSecret) < 32 {
		log.Fatal("SHARE_LINK_SECRET must be at least 32 characters and match the site Worker's")
	}
	st.ConfigureShareLinks(shareLinkSecret)

	blobStore, err := openBlobStore(appEnv)
	if err != nil {
		log.Fatalf("blob store: %v", err)
	}

	pipeSecret := env("PIPELINE_SECRET", "")
	collaborationSecret := env("COLLABORATION_SECRET", "dev-collaboration-secret")
	if err := validateServiceSecrets(appEnv, pipeSecret, collaborationSecret); err != nil {
		log.Fatal(err)
	}
	turnstileSecret := env("TURNSTILE_SECRET_KEY", "")
	if err := validateTurnstileSecret(appEnv, turnstileSecret); err != nil {
		log.Fatal(err)
	}
	// Read only by Config below, so dropping it there fails the build.
	turnstileTokenHosts, err := turnstileHosts(appEnv, append(append([]string{appURL}, corsOrigins...), authorizedParties...)...)
	if err != nil {
		log.Fatal(err)
	}
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

	emailSender, err := newEmailSender(appEnv, emailBackend, cloudflareAccountID, cloudflareEmailToken, emailFrom, emailReplyTo)
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
			if err := st.PruneDailyUsage(ctx); err != nil && ctx.Err() == nil {
				log.Printf("prune anonymous grading usage: %v", err)
			}
			if err := st.PruneEditIncidents(ctx); err != nil && ctx.Err() == nil {
				log.Printf("prune edit incidents: %v", err)
			}
			if err := st.PruneBankCommentNotices(ctx); err != nil && ctx.Err() == nil {
				log.Printf("prune bank comment notices: %v", err)
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

	go runTrashSweep(ctx, st)
	go runBlobReaper(ctx, st, blobStore, artifactTTL{
		CaptionDays: envInt("CAPY_CAPTION_CACHE_TTL_DAYS", 90),
	})
	go runBlobSweep(ctx, st, blobStore)
	go runOverQuotaNoticeWorker(ctx, st)
	go runCollaborationEvictionWorker(ctx, st, rdb)
	go runSourceBatchWorker(ctx, st, rdb)
	go runBankCommentDigestWorker(ctx, st, emailSender, appURL)

	bankStore := bank.New(env("BANK_DATABASE_URL", ""), env("BANK_EDITOR_DATABASE_URL", ""), env("BANK_ASSETS_URL", ""), env("LIBRARY_DATABASE_URL", ""))
	go runAccountPurgeWorker(ctx, st, bankStore.ForgetUser, clerkSecret != "")
	// Questions copied from the bank into quizzes keep linking its figures.
	questions.QuizBankAssetsURL = env("BANK_ASSETS_URL", "")
	defer bankStore.Close()
	var bankAssets bank.AssetWriter
	if bankStore.Editable() && env("BANK_PUBLIC_B2_BUCKET", "") != "" {
		assets, err := blob.NewB2(blob.B2Config{Endpoint: env("BANK_PUBLIC_B2_ENDPOINT", ""), Region: env("BANK_PUBLIC_B2_REGION", ""), Bucket: env("BANK_PUBLIC_B2_BUCKET", ""), KeyID: env("BANK_PUBLIC_B2_KEY_ID", ""), AppKey: env("BANK_PUBLIC_B2_APP_KEY", "")})
		if err != nil {
			log.Printf("bank asset upload unavailable: %v", err)
		} else {
			bankAssets = assets
		}
	}
	cfg := httpapi.Config{
		BYOKEnabled:            env("BYOK_ENABLED", "false") == "true",
		Bank:                   bankStore,
		BankAssets:             bankAssets,
		BankAssetsURL:          env("BANK_ASSETS_URL", ""),
		BankCommentEmail:       env("BANK_COMMENT_EMAIL", ""),
		TurnstileSecret:        turnstileSecret,
		TurnstileHosts:         turnstileTokenHosts,
		ReleaseSHA:             env("RELEASE_SHA", ""),
		APIDocs:                appEnv == "development",
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
		CollaborationSecret:    collaborationSecret,
		CollaborationURL:       env("COLLABORATION_URL", "ws://localhost:1234"),
		PipelineSecret:         pipeSecret,
		ParseMaxPages:          parseMaxPages,
		ParseMaxOCRPages:       parseMaxOCRPages,
		AllowedOrigins:         corsOrigins,
		AuthorizedParties:      authorizedParties,
		RateLimit:              rateLimitConfig(appEnv, shareLinkSecret),
		ModelRegistry:          modelReg,
		Jev:                    jev.New(env("JEV_TYPESAFE_API_KEY", "")),
		Voice:                  voice,
	}
	if mailRecorder != nil {
		cfg.MailRecorder = mailRecorder
	}

	// Upload spools a crashed run left behind count against nothing now.
	httpapi.RemoveUploadSpools(os.TempDir())
	srv := httpapi.NewServer(addr, httpapi.New(st, blobStore, pipe, rdb, parser, cfg))
	runUsageWorkers(ctx, st, rdb, reconcile.Config{
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
