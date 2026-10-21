package store

import (
	"context"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/migrations"
)

// An account Clerk gives no name is named after its address's local part, at
// most 60 characters, never the whole address (human authorization,
// 2026-10-21).
func TestClerkProfileSyncNamesAnUnnamedAccountAfterItsEmailLocalPart(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	for _, local := range []string{"Ada.Lovelace+notes", strings.Repeat("a", 70)} {
		userID := uid("u_local_name")
		t.Cleanup(func() {
			_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
		})
		local += "." + userID
		if _, err := s.UpsertUserFromClerk(ctx, userID, "", local+"@example.test", ""); err != nil {
			t.Fatal(err)
		}
		var name string
		if err := s.pool.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, userID).Scan(&name); err != nil {
			t.Fatal(err)
		}
		if want := local[:min(len(local), 60)]; name != want {
			t.Fatalf("name = %q, want the local part %q", name, want)
		}
	}
}

// Migration 0102 renames accounts named after their whole address (any case,
// cut to 60 characters) to the local part and leaves typed names alone.
func TestUnnamedUserMigrationRenamesEmailNamesToTheLocalPart(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	sql, err := migrations.FS.ReadFile("0102_unnamed_user_names.sql")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	id := uid("u_email_name")
	short := "Grace.Hopper." + id + "@example.test"
	long := strings.Repeat("b", 50) + "." + id + "@example.test"
	users := []struct{ id, name, email, want string }{
		{id + "_short", strings.ToUpper(short), short, "Grace.Hopper." + id},
		{id + "_long", long[:60], long, (strings.Repeat("b", 50) + "." + id)[:60]},
		{id + "_typed", "Typed Name", "typed." + id + "@example.test", "Typed Name"},
	}
	for _, u := range users {
		if _, err := tx.Exec(ctx, `INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, u.id, u.name, u.email); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, string(sql)); err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		var name string
		if err := tx.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, u.id).Scan(&name); err != nil {
			t.Fatal(err)
		}
		if name != u.want {
			t.Fatalf("%s: name = %q, want %q", u.id, name, u.want)
		}
	}
}
