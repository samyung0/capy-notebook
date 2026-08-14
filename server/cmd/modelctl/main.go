// Command modelctl edits the model registry. There is no HTTP write path:
// membership of operators is the entire authorization model, and an escalation
// path reachable from the product would make every product bug a path to
// everyone's data. Same philosophy as cancel-deletion.
//
// Usage:
//
//	DATABASE_URL=... go run ./cmd/modelctl list
//	DATABASE_URL=... go run ./cmd/modelctl add -key deepseek-pro -display "DeepSeek Pro" \
//	  -provider deepseek -model deepseek-v4-pro -surfaces chat,generate \
//	  -in 775 -out 3100
//	DATABASE_URL=... go run ./cmd/modelctl disable -key deepseek-pro -version 1
//	DATABASE_URL=... go run ./cmd/modelctl set-default -key deepseek-flash -surface chat
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/evonotes/server/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	ctx := context.Background()
	st, err := store.New(ctx, env("DATABASE_URL", "postgres://evo:evo@localhost:5432/evo?sslmode=disable"))
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()

	switch os.Args[1] {
	case "list":
		if err := list(ctx, st); err != nil {
			log.Fatal(err)
		}
	case "add":
		if err := add(ctx, st, os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "disable":
		if err := disable(ctx, st, os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "set-default":
		if err := setDefault(ctx, st, os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `usage: modelctl <list|add|disable|set-default> [flags]

Rows are immutable. add writes a new version; disable keeps the row so pinned
conversations can still resolve it; set-default retargets is_default_for.
Embedding and vision defaults are frozen in running processes until restart.
`)
}

func list(ctx context.Context, st *store.Store) error {
	rows, err := st.Pool().Query(ctx, `
		SELECT model_key, version, display_name, provider_slug, provider_model_id,
		       surfaces, micros_per_input_token, micros_per_output_token,
		       enabled, is_default_for
		  FROM model_configs
		 ORDER BY model_key, version`)
	if err != nil {
		return err
	}
	defer rows.Close()
	fmt.Printf("%-20s %4s %-22s %-12s %-36s %-28s %6s %6s %8s %s\n",
		"KEY", "VER", "DISPLAY", "PROVIDER", "PROVIDER_ID", "SURFACES", "IN", "OUT", "ENABLED", "DEFAULT")
	for rows.Next() {
		var key, display, provider, providerID string
		var version int
		var surfaces, defaults []string
		var in, out int64
		var enabled bool
		if err := rows.Scan(&key, &version, &display, &provider, &providerID, &surfaces, &in, &out, &enabled, &defaults); err != nil {
			return err
		}
		fmt.Printf("%-20s %4d %-22s %-12s %-36s %-28s %6d %6d %8t %s\n",
			key, version, display, provider, providerID, strings.Join(surfaces, ","), in, out, enabled, strings.Join(defaults, ","))
	}
	return rows.Err()
}

func add(ctx context.Context, st *store.Store, args []string) error {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	key := fs.String("key", "", "stable model_key slug")
	display := fs.String("display", "", "display name")
	provider := fs.String("provider", "", "provider_slug (env key lookup)")
	baseURL := fs.String("base-url", "", "provider base URL")
	model := fs.String("model", "", "provider model id")
	surfaces := fs.String("surfaces", "", "comma-separated surfaces")
	paramsJSON := fs.String("params", "{}", "params jsonb")
	inRate := fs.Int64("in", 250, "micros per input token")
	outRate := fs.Int64("out", 1000, "micros per output token")
	usdIn := fs.Int64("usd-in", 0, "micro-USD per million input tokens")
	usdOut := fs.Int64("usd-out", 0, "micro-USD per million output tokens")
	_ = fs.Parse(args)
	if *key == "" || *display == "" || *provider == "" || *model == "" || *surfaces == "" {
		return fmt.Errorf("add requires -key -display -provider -model -surfaces")
	}
	surfaceList := splitCSV(*surfaces)
	tx, err := st.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var version int
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(max(version), 0) + 1 FROM model_configs WHERE model_key=$1`, *key,
	).Scan(&version); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			usd_micros_per_input_token, usd_micros_per_output_token, enabled, is_default_for
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'{}')`,
		*key, version, *display, *provider, *baseURL, *model,
		json.RawMessage(*paramsJSON), surfaceList, *inRate, *outRate, *usdIn, *usdOut,
	); err != nil {
		return err
	}
	if err := bump(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Printf("added %s v%d\n", *key, version)
	return nil
}

func disable(ctx context.Context, st *store.Store, args []string) error {
	fs := flag.NewFlagSet("disable", flag.ExitOnError)
	key := fs.String("key", "", "model_key")
	version := fs.Int("version", 0, "version to disable")
	_ = fs.Parse(args)
	if *key == "" || *version <= 0 {
		return fmt.Errorf("disable requires -key and -version")
	}
	tx, err := st.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var defaults []string
	if err := tx.QueryRow(ctx,
		`SELECT is_default_for FROM model_configs WHERE model_key=$1 AND version=$2 FOR UPDATE`,
		*key, *version).Scan(&defaults); err != nil {
		return err
	}
	if len(defaults) > 0 {
		return fmt.Errorf("refusing to disable %s v%d: it is the default for %s; set-default first",
			*key, *version, strings.Join(defaults, ","))
	}
	tag, err := tx.Exec(ctx,
		`UPDATE model_configs SET enabled=false WHERE model_key=$1 AND version=$2 AND enabled`,
		*key, *version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%s v%d not found or already disabled", *key, *version)
	}
	if err := bump(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Printf("disabled %s v%d\n", *key, *version)
	return nil
}

func setDefault(ctx context.Context, st *store.Store, args []string) error {
	fs := flag.NewFlagSet("set-default", flag.ExitOnError)
	key := fs.String("key", "", "model_key")
	surface := fs.String("surface", "", "surface to retarget")
	_ = fs.Parse(args)
	if *key == "" || *surface == "" {
		return fmt.Errorf("set-default requires -key and -surface")
	}
	tx, err := st.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var version int
	if err := tx.QueryRow(ctx, `
		SELECT version FROM model_configs
		 WHERE model_key=$1 AND enabled AND $2 = ANY(surfaces)
		 ORDER BY version DESC LIMIT 1`, *key, *surface).Scan(&version); err != nil {
		return fmt.Errorf("no enabled %s for surface %s: %w", *key, *surface, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE model_configs
		   SET is_default_for = array_remove(is_default_for, $1)
		 WHERE $1 = ANY(is_default_for)`, *surface); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE model_configs
		   SET is_default_for = array_append(is_default_for, $3)
		 WHERE model_key=$1 AND version=$2 AND NOT ($3 = ANY(is_default_for))`,
		*key, version, *surface); err != nil {
		return err
	}
	if err := bump(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Printf("default %s -> %s v%d\n", *surface, *key, version)
	return nil
}

func bump(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `UPDATE model_registry_state SET version = version + 1, updated_at = now() WHERE id = true`)
	return err
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
