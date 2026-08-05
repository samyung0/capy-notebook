// Command cancel-deletion is a support tool that reactivates an account still
// inside its deletion grace window. Users cannot cancel deletion themselves;
// after they request deletion, sessions are revoked and auth is refused until
// support runs this.
//
// Usage:
//
//	DATABASE_URL=... go run ./cmd/cancel-deletion -user <user_id>
//	DATABASE_URL=... go run ./cmd/cancel-deletion -email <email>
//
// Optional -notify sends the account-deletion-cancelled email + in-app notice.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/evonotes/server/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	userID := flag.String("user", "", "user id to reactivate")
	email := flag.String("email", "", "active account email to reactivate")
	notify := flag.Bool("notify", false, "send deletion-cancelled email and in-app notification")
	flag.Parse()

	if (*userID == "") == (*email == "") {
		fmt.Fprintln(os.Stderr, "usage: cancel-deletion -user <id> | -email <email> [-notify]")
		os.Exit(2)
	}

	dsn := env("DATABASE_URL", "postgres://evo:evo@localhost:5432/evo?sslmode=disable")
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()

	id := strings.TrimSpace(*userID)
	if id == "" {
		id, err = st.FindActiveUserIDByEmail(ctx, strings.TrimSpace(*email))
		if errors.Is(err, store.ErrNotFound) {
			log.Fatalf("no active user with email %q", *email)
		}
		if err != nil {
			log.Fatalf("resolve email: %v", err)
		}
	}

	before, err := st.AccountAccess(ctx, id)
	if err != nil {
		log.Fatalf("account status: %v", err)
	}
	if before.State == store.AccountDeleted {
		log.Fatalf("user %s is already purged; cannot cancel", id)
	}
	if before.State != store.AccountDeletionPending {
		log.Fatalf("user %s is %s, not deletion_pending", id, before.State)
	}

	status, err := st.CancelAccountDeletion(ctx, id)
	if errors.Is(err, store.ErrForbidden) {
		log.Fatalf("user %s has already been purged", id)
	}
	if err != nil {
		log.Fatalf("cancel: %v", err)
	}
	log.Printf("cancelled deletion for user=%s state=%s", id, status.State)

	if *notify {
		if err := st.NotifyAccountDeletionCancelled(ctx, id); err != nil {
			log.Fatalf("notify: %v", err)
		}
		log.Printf("sent deletion-cancelled notice to user=%s", id)
	}
}
