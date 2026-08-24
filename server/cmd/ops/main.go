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
	appEnv := env("APP_ENV", "development")
	obs.Init("ops", appEnv)
	shutdownSentry := obs.InitSentry(obs.SentryConfig{
		DSN: env("SENTRY_DSN", ""), Environment: appEnv,
		Release:    env("RELEASE_SHA", ""),
		SampleRate: env("SENTRY_TRACES_SAMPLE_RATE", "0.1"), Service: "ops",
	})
	defer shutdownSentry()

	security := ops.SecurityConfig{
		ClerkSecretKey:         env("CLERK_SECRET_KEY", ""),
		CloudflareAccessIssuer: env("OPS_CF_ACCESS_ISSUER", ""),
		CloudflareAccessAUD:    env("OPS_CF_ACCESS_AUDIENCE", ""),
		CloudflareAccessJWKS:   env("OPS_CF_ACCESS_JWKS_URL", ""),
	}
	if err := security.Validate(); err != nil {
		log.Fatalf("ops security configuration: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	readPool := openPool(ctx, env("OPS_DATABASE_URL", ""), "OPS_DATABASE_URL")
	readApp := store.NewWithPool(readPool)
	defer readApp.Close()
	sessionPool := openPool(
		ctx,
		env("OPS_SESSION_DATABASE_URL", ""),
		"OPS_SESSION_DATABASE_URL",
	)
	defer sessionPool.Close()
	registryDSN := env("OPS_REGISTRY_DATABASE_URL", "")
	if appEnv == "production" {
		if err := ops.ValidateDatabaseRole(ctx, readPool, ops.ReadDatabaseRole); err != nil {
			log.Fatalf("OPS_DATABASE_URL: %v", err)
		}
		if err := ops.ValidateDatabaseRole(
			ctx, sessionPool, ops.AuthDatabaseRole,
		); err != nil {
			log.Fatalf("OPS_SESSION_DATABASE_URL: %v", err)
		}
	}
	read := ops.NewReadStore(readApp)
	registry := ops.NewLazyRegistryStore(
		readApp.Pool(),
		registryDSN,
	)
	defer registry.Close()
	handler := ops.NewHandler(read, registry, ops.HandlerConfig{
		StaticDir:       env("OPS_STATIC_DIR", ""),
		StuckJobMinutes: envInt("OPS_STUCK_JOB_MINUTES", 30),
	})
	accessVerifier, err := ops.NewAccessVerifier(ops.AccessConfig{
		Issuer: security.CloudflareAccessIssuer, Audience: security.CloudflareAccessAUD,
		JWKSURL: security.CloudflareAccessJWKS,
	})
	if err != nil {
		log.Fatalf("Cloudflare Access: %v", err)
	}
	clerkVerifier, err := ops.NewClerkVerifier(security.ClerkSecretKey)
	if err != nil {
		log.Fatalf("Clerk: %v", err)
	}
	handler = (ops.Authenticator{
		Cloudflare: accessVerifier,
		Clerk:      clerkVerifier,
		Operators: ops.NewOperatorDirectory(
			read, ops.NewAuthStore(sessionPool),
		),
	}).Middleware(handler)
	handler = obs.SentryMiddleware(obs.Middleware(handler))

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
