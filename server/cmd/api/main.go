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

	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/pipeline"
	"github.com/evonotes/server/internal/store"
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

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
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
		root := env("BLOB_DISK_ROOT", os.TempDir()+"/evo-blobs")
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
	dsn := env("DATABASE_URL", "postgres://evo:evo@localhost:5432/evo?sslmode=disable")
	addr := env("ADDR", ":8080")
	parser := env("EVO_PARSER", "docling")
	engine := env("EVO_ENGINE", "linearrag")
	appURL := env("APP_URL", "http://localhost:5173")
	appEnv := env("APP_ENV", "development")

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
	for i := range e2eUserIDs {
		e2eUserIDs[i] = strings.TrimSpace(e2eUserIDs[i])
	}
	if e2eAuth {
		log.Println("E2E auth enabled (X-E2E-User-Id / X-E2E-Secret)")
	}

	ctx, cancelRuntime := context.WithCancel(context.Background())
	defer cancelRuntime()
	st, err := store.New(ctx, dsn)
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

	var pipe *pipeline.Client
	if u := env("PIPELINE_URL", ""); u != "" {
		pipe = pipeline.New(u)
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
		log.Println("migrations applied")
	}

	go func() {
		expire := func() {
			count, err := st.ExpireWorkspaceInvites(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("expire workspace invites: %v", err)
				}
				return
			}
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

	go func() {
		cleanup := func() {
			uploads, err := st.ExpiredUploadSessions(ctx, 100)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("list expired source uploads: %v", err)
				}
				return
			}
			for _, upload := range uploads {
				if err := st.MarkUploadExpired(ctx, upload.ID); err != nil {
					log.Printf("release source upload %s: %v", upload.ID, err)
					continue
				}
				if err := blobStore.Delete(ctx, upload.ObjectPath); err != nil {
					log.Printf("delete expired source upload %s: %v", upload.ID, err)
				}
				if err := blobStore.Delete(ctx, upload.FinalPath); err != nil {
					log.Printf("delete expired source final object %s: %v", upload.ID, err)
				}
			}
			assetUploads, err := st.ExpiredEditorAssetUploads(ctx, 100)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("list expired editor uploads: %v", err)
				}
			} else {
				for _, upload := range assetUploads {
					if err := st.MarkEditorAssetUploadExpired(ctx, upload.ID); err != nil {
						log.Printf("release editor upload %s: %v", upload.ID, err)
						continue
					}
					if err := blobStore.Delete(ctx, upload.ObjectPath); err != nil {
						log.Printf("delete expired editor upload %s: %v", upload.ID, err)
					}
					if asset, err := st.GetEditorAsset(ctx, upload.AssetID); err == nil {
						if err := blobStore.Delete(ctx, asset.ObjectPath); err != nil {
							log.Printf("delete expired editor asset %s: %v", asset.ID, err)
						}
					}
				}
			}
			_ = st.PruneUploadSessions(ctx)
			_ = st.PruneEditorAssetUploads(ctx)
		}
		cleanup()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				cleanup()
			case <-ctx.Done():
				return
			}
		}
	}()

	cfg := httpapi.Config{
		ClerkSecretKey:      env("CLERK_SECRET_KEY", ""),
		ClerkWebhookSecret:  env("CLERK_WEBHOOK_SECRET", ""),
		AuthDisabled:        envBool("AUTH_DISABLED"),
		DevUserID:           env("DEV_USER_ID", "u_1"),
		E2EAuth:             e2eAuth,
		E2ESecret:           e2eSecret,
		E2EUserIDs:          e2eUserIDs,
		StripeSecretKey:     env("STRIPE_SECRET_KEY", ""),
		StripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET", ""),
		StripePricePro:      env("STRIPE_PRICE_PRO", ""),
		AppURL:              appURL,
		CollaborationSecret: env("COLLABORATION_SECRET", "dev-collaboration-secret"),
		CollaborationURL:    env("COLLABORATION_URL", "ws://localhost:1234"),
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(st, blobStore, pipe, rdb, parser, engine, cfg),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("evo-notes gateway listening on %s", addr)
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
	_ = srv.Shutdown(shutCtx)
}
