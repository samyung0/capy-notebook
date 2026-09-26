// Command office-maintenance runs the Office maintenance window
// (openwiki/deployment-runbook.md, "Office maintenance window"):
//
//	office-maintenance pause        # refuse Office editing; open rooms flush and go read-only
//	office-maintenance publish-all  # publish every Office source with unpublished edits
//	office-maintenance status       # the pause, unpublished files, work in flight; exit 1 until ready
//	office-maintenance resume       # allow Office editing again
//
// DATABASE_URL selects the database. The gateway image ships the command as
// /app/office-maintenance; run it inside the `server` container, which holds it.
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: office-maintenance pause|publish-all|status|resume")
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
	default:
		fmt.Fprintln(os.Stderr, "usage: office-maintenance pause|publish-all|status|resume")
		os.Exit(2)
	}
}
