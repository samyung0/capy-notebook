// Command office-maintenance runs the Office maintenance window
// (openwiki/deployment-runbook.md, "Office maintenance window"):
//
//	office-maintenance pause        # refuse Office editing; open rooms flush and go read-only
//	office-maintenance publish-all  # publish every Office source with unpublished edits
//	office-maintenance status       # the pause, unpublished files, work in flight; exit 1 until ready
//	office-maintenance resume       # allow Office editing again
//	office-maintenance seed-manifest # JSON lines of every seed a stored Office change was taken over
//
// DATABASE_URL selects the database, and seed-manifest signs base links with
// the gateway's B2_* settings (B2_LINK_TTL, seconds, sets how long they last).
// The gateway image ships the command as /app/office-maintenance; run it
// inside the `server` container, which holds both.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

const usage = "usage: office-maintenance pause|publish-all|status|resume|seed-manifest"

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://capy:capy@localhost:5432/capy?sslmode=disable"
	}
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()

	switch os.Args[1] {
	case "pause", "resume":
		if err = st.SetOfficeEditingPaused(ctx, os.Args[1] == "pause"); err != nil {
			log.Fatalf("%s: %v", os.Args[1], err)
		}
		if os.Args[1] == "pause" {
			fmt.Println("Office editing paused; within about 15 seconds every open room has flushed and closed its editors")
		} else {
			fmt.Println("Office editing resumed")
		}
	case "publish-all":
		registry, err := models.New(ctx, st.Pool())
		if err != nil {
			log.Fatalf("model registry: %v", err)
		}
		st.SetModelRegistry(registry)
		published, err := st.PublishAllOfficeSources(ctx)
		if err != nil {
			log.Fatalf("publish-all: %v", err)
		}
		failed := 0
		for _, p := range published {
			mode := "republish"
			if p.ExportOnly {
				mode = "export-only"
			}
			if p.Err != nil {
				failed++
				fmt.Printf("%s\t%s\tfailed: %v\n", p.FileID, mode, p.Err)
				continue
			}
			fmt.Printf("%s\t%s\t%s\n", p.FileID, mode, p.JobID)
		}
		fmt.Printf("%d requested, %d refused\n", len(published)-failed, failed)
	case "status":
		ready, err := st.OfficeReadiness(ctx)
		if err != nil {
			log.Fatalf("status: %v", err)
		}
		if ready.Paused {
			fmt.Println("Office editing paused")
		} else {
			fmt.Println("Office editing NOT paused: run office-maintenance pause first")
		}
		for _, u := range ready.Unpublished {
			fmt.Printf("unpublished\t%s\t%s\tcheckpoint %d, indexed %d\tjob %s\t%s\n", u.FileID, u.Format, u.Checkpoint, u.IndexedCheckpoint, u.RunningJobID, u.RefreshError)
		}
		for _, j := range ready.InFlight {
			fmt.Printf("in flight\t%s\t%s\t%s\tfile %s\n", j.ID, j.Type, j.Status, j.FileID)
		}
		fmt.Printf("%d unpublished, %d in flight\n", len(ready.Unpublished), len(ready.InFlight))
		if !ready.Ready() {
			os.Exit(1)
		}
	case "seed-manifest":
		// The pin bump's seed check (pnpm office:seed-check) reads these lines.
		if err = seedManifest(ctx, st); err != nil {
			log.Fatalf("seed-manifest: %v", err)
		}
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
}

func seedManifest(ctx context.Context, st *store.Store) error {
	ttl, err := strconv.Atoi(os.Getenv("B2_LINK_TTL"))
	if err != nil {
		ttl = 300 // the gateway's default (cmd/api)
	}
	b2, err := blob.NewB2(blob.B2Config{
		Endpoint: os.Getenv("B2_ENDPOINT"), Region: os.Getenv("B2_REGION"), Bucket: os.Getenv("B2_BUCKET"),
		KeyID: os.Getenv("B2_KEY_ID"), AppKey: os.Getenv("B2_APP_KEY"),
		UsePathStyle: os.Getenv("B2_FORCE_PATH_STYLE") == "true",
		LinkTTL:      time.Duration(ttl) * time.Second,
	})
	if err != nil {
		return err
	}
	seeds, err := st.OfficeSeeds(ctx)
	if err != nil {
		return err
	}
	out := json.NewEncoder(os.Stdout)
	for _, seed := range seeds {
		url, err := b2.PresignGet(ctx, seed.BaseBlobPath)
		if err != nil {
			return err
		}
		if err = out.Encode(struct {
			store.OfficeSeed
			SourceURL string `json:"sourceURL"`
		}{seed, url}); err != nil {
			return err
		}
	}
	return nil
}
