// Command previewbackfill fills materials.preview for materials written before
// migration 0073, so their list cards show a preview before their next edit.
// One-shot and idempotent: it touches only rows still without a preview and can
// be rerun. Nothing runs it at startup.
//
// Usage:
//
//	DATABASE_URL=... go run ./cmd/previewbackfill [-batch 200]
package main

import (
	"context"
	"flag"
	"log"
	"os"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

func main() {
	batch := flag.Int("batch", 200, "materials read per query")
	flag.Parse()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" || *batch < 1 {
		log.Fatal("usage: DATABASE_URL=... previewbackfill [-batch n]")
	}
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()
	filled, skipped, err := st.BackfillMaterialPreviews(ctx, *batch)
	if err != nil {
		log.Fatalf("backfill stopped after %d previews: %v", filled, err)
	}
	log.Printf("filled %d material previews; %d materials could not be read", filled, skipped)
}
