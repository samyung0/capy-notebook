// Command migrate applies numbered SQL files once and records them in
// schema_migrations. The serving API should leave MIGRATE=false in production
// and run this binary from the same image as an explicit deploy step.
//
//	migrate            apply pending files
//	migrate -status    print applied vs pending (no writes except the ledger table)
//	migrate -seed      apply pending files, then the local demo rows
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/evonotes/server/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	status := flag.Bool("status", false, "print pending and applied files, then exit")
	seed := flag.Bool("seed", false, "apply the local demo seed after migrations")
	flag.Parse()

	dsn := env("DATABASE_URL", "postgres://evo:evo@localhost:5432/evo?sslmode=disable")
	ctx := context.Background()
	st, err := store.Open(ctx, dsn)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()

	if *status {
		if err := printStatus(ctx, st); err != nil {
			log.Fatalf("status: %v", err)
		}
		return
	}

	pending, err := st.MigrationStatus(ctx)
	if err != nil {
		log.Fatalf("status: %v", err)
	}
	for _, row := range pending {
		if row.ChecksumMismatch {
			log.Fatalf("migrate: %s checksum mismatch; add a new numbered file", row.Filename)
		}
		if !row.Applied {
			log.Printf("applying %s", row.Filename)
		}
	}
	if err := st.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if *seed {
		if err := st.ApplyDevSeed(ctx); err != nil {
			log.Fatalf("dev seed: %v", err)
		}
		log.Println("dev seed applied")
	}
	log.Println("migrations applied")
}

func printStatus(ctx context.Context, st *store.Store) error {
	rows, err := st.MigrationStatus(ctx)
	if err != nil {
		return err
	}
	pending := 0
	for _, row := range rows {
		switch {
		case row.ChecksumMismatch:
			fmt.Printf("MISMATCH %s\n", row.Filename)
			pending++
		case row.Applied:
			fmt.Printf("applied  %s\n", row.Filename)
		default:
			fmt.Printf("pending  %s\n", row.Filename)
			pending++
		}
	}
	if pending == 0 {
		fmt.Println("up to date")
	}
	return nil
}
