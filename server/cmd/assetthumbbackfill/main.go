// Command assetthumbbackfill makes the Embeds tab thumbnails of editor images
// stored before migration 0131 (openwiki/thumbnails.md). One-shot and
// idempotent: it reads only ready images still without a thumbnail, makes
// one attempt each (a failure is logged and the card keeps its icon), and can
// be rerun. Nothing runs it at startup.
//
// Usage (the server container already has these variables):
//
//	DATABASE_URL=... B2_ENDPOINT=... B2_REGION=... B2_BUCKET=... \
//	B2_KEY_ID=... B2_APP_KEY=... assetthumbbackfill [-batch 100]
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"os"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/assetthumb"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Over the largest editor image the plans allow; a bigger object is skipped.
const maxImageBytes = 20 << 20

func main() {
	batch := flag.Int("batch", 100, "images read per query")
	flag.Parse()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" || *batch < 1 {
		log.Fatal("usage: DATABASE_URL=... B2_*=... assetthumbbackfill [-batch n]")
	}
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()
	objects, err := blob.NewB2(blob.B2Config{
		Endpoint:     os.Getenv("B2_ENDPOINT"),
		Region:       os.Getenv("B2_REGION"),
		Bucket:       os.Getenv("B2_BUCKET"),
		KeyID:        os.Getenv("B2_KEY_ID"),
		AppKey:       os.Getenv("B2_APP_KEY"),
		UsePathStyle: os.Getenv("B2_FORCE_PATH_STYLE") == "true",
	})
	if err != nil {
		log.Fatalf("blob: %v", err)
	}
	made, failed, after := 0, 0, ""
	for {
		images, err := st.EditorImagesWithoutThumbnails(ctx, after, *batch)
		if err != nil {
			log.Fatalf("backfill stopped after %d thumbnails: %v", made, err)
		}
		if len(images) == 0 {
			break
		}
		for _, img := range images {
			after = img.ID
			if err := thumbnail(ctx, objects, st, img); err != nil {
				failed++
				log.Printf("%s: %v", img.ID, err)
				continue
			}
			made++
		}
	}
	log.Printf("made %d editor image thumbnails; %d failed", made, failed)
}

func thumbnail(ctx context.Context, objects blob.Store, st *store.Store, img store.EditorImageToThumbnail) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, err := objects.Open(ctx, img.ObjectPath)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(r, maxImageBytes+1))
	r.Close()
	if err != nil {
		return err
	}
	if len(data) > maxImageBytes {
		return io.ErrShortBuffer
	}
	return assetthumb.Store(ctx, objects, st, img.ID, data)
}
