package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// TestPurgeBlanksTheAccountOnBankQuestions (security regression: rate-limit
// audit r3 N-3, Q350). A due purge blanks the account's id on bank questions
// before PurgeUser; while the bank cannot answer, the account is not purged
// and stays due for the next tick.
func TestPurgeBlanksTheAccountOnBankQuestions(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	dueUser := func(label string) string {
		id := fmt.Sprintf("u_%s_%d", label, time.Now().UnixNano())
		if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email) VALUES ($1, 'Purge Test', $2)`,
			id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id) })
		if _, err := st.RequestAccountDeletion(ctx, id, true); err != nil {
			t.Fatal(err)
		}
		return id
	}
	purged := func(id string) bool {
		var done bool
		if err := st.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM users WHERE id=$1`, id).Scan(&done); err != nil {
			t.Fatal(err)
		}
		return done
	}

	down := dueUser("purge_bank_down")
	purgeAccount(ctx, st, func(context.Context, string) error { return errors.New("bank unavailable") }, false, down)
	if purged(down) {
		t.Fatal("purged while the bank could not blank the account")
	}

	var forgotten []string
	leaver := dueUser("purge_bank")
	purgeAccount(ctx, st, func(_ context.Context, id string) error {
		forgotten = append(forgotten, id)
		return nil
	}, false, leaver)
	if !slices.Equal(forgotten, []string{leaver}) || !purged(leaver) {
		t.Fatalf("bank blanked %v, purged %v; want the account blanked and purged", forgotten, purged(leaver))
	}
}
