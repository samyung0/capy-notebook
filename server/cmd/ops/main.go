package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/ops"
	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
}

func openPool(ctx context.Context, dsn, name string) *pgxpool.Pool {
	if dsn == "" {
		log.Fatalf("%s is required", name)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	config.MaxConns = 2
	if name == "OPS_DATABASE_URL" {
		config.MaxConns = 4
	}
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		log.Fatalf("%s ping: %v", name, err)
	}
	return pool
}

func main() {
	cfg := ops.ConfigFromEnv()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("ops security configuration: %v", err)
	}

	obs.Init("ops", cfg.AppEnv)
	shutdownSentry := obs.InitSentry(obs.SentryConfig{
		DSN: env("SENTRY_DSN", ""), Environment: cfg.AppEnv,
		Release:    env("RELEASE_SHA", ""),
		SampleRate: env("SENTRY_TRACES_SAMPLE_RATE", "0.1"), Service: "ops",
	})
	defer shutdownSentry()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	readPool := openPool(ctx, cfg.DatabaseURL, "OPS_DATABASE_URL")
	readApp := store.NewWithPool(readPool)
	defer readApp.Close()
	if !cfg.AllowOwnerDSN() {
		if err := ops.ValidateDatabaseRole(ctx, readPool, ops.ReadDatabaseRole); err != nil {
			log.Fatalf("OPS_DATABASE_URL: %v", err)
		}
		if err := ops.ProbeDatabaseRole(
			ctx, cfg.AdminDatabaseURL, ops.AdminDatabaseRole,
		); err != nil {
			log.Fatalf("OPS_ADMIN_DATABASE_URL: %v", err)
		}
	}
	read := ops.NewReadStore(readApp)
	admin := ops.NewLazyAdminStore(cfg.AdminDatabaseURL)
	if cfg.AllowOwnerDSN() {
		admin.SkipRoleValidation()
	}
	defer admin.Close()
	registry := ops.NewRegistryStoreWithAdmin(readApp.Pool(), admin)
	handler := ops.NewHandler(read, registry, admin, ops.HandlerConfig{
		StaticDir:       env("OPS_STATIC_DIR", ""),
		StuckJobMinutes: envInt("OPS_STUCK_JOB_MINUTES", 30),
	})
	authenticator := ops.Authenticator{
		Operators:    ops.NewOperatorDirectory(read, ops.NewAuthStore(readPool)),
		AuthDisabled: cfg.AuthDisabled,
		DevUserID:    cfg.DevUserID,
	}
	var accessVerifier *ops.AccessVerifier
	if !cfg.AccessDisabled {
		var err error
		accessVerifier, err = ops.NewAccessVerifier(cfg.AccessConfig())
		if err != nil {
			log.Fatalf("Cloudflare Access: %v", err)
		}
	}
	if !cfg.AuthDisabled {
		clerkVerifier, err := ops.NewClerkVerifier(cfg.ClerkSecretKey)
		if err != nil {
			log.Fatalf("Clerk: %v", err)
		}
		authenticator.Clerk = clerkVerifier
	}
	handler = authenticator.Middleware(handler)
	if accessVerifier != nil {
		handler = ops.AccessMiddleware(accessVerifier)(handler)
	}
	handler = obs.Middleware(obs.SentryMiddleware(handler))

	server := &http.Server{
		Addr: env("OPS_ADDR", ":8082"), Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
	}
	go func() {
		log.Printf("operator dashboard listening on %s", server.Addr)
		if err := server.ListenAndServe(); err != nil &&
			!errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownCtx)
}
