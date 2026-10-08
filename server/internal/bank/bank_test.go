package bank

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/bankmigrations"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestBankMigrationAndReviewSurviveEdit(t *testing.T) {
	ctx := context.Background()
	dsn := testdb.URL(t)
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := fmt.Sprintf("bank_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)") }()
	parsed, _ := url.Parse(dsn)
	parsed.Path = "/" + name
	dsn = parsed.String()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for i := 0; i < 2; i++ {
		if err := store.MigrateFS(ctx, pool, bankmigrations.FS); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO exams VALUES ('exam','Exam',1,'Example exam','{"style":"type","color":"#7866cf"}');INSERT INTO subjects VALUES ('subject','exam','Subject',1);INSERT INTO topics VALUES ('topic','subject','Topic',1)`); err != nil {
		t.Fatal(err)
	}
	raw := `{"id":"q","stem":[{"type":"text","text":"Question"}],"parts":[{"id":"p","blocks":[{"type":"text","text":"Answer this"}],"answer":{"type":"short","accepted":["2"]},"marks":1,"solution":[{"type":"text","text":"Two"}]}],"layout":"paper","labels":"letters"}`
	if _, err := pool.Exec(ctx, `INSERT INTO questions(id,topic_id,position,content,run)VALUES('q','topic',1,$1,'run')`, raw); err != nil {
		t.Fatal(err)
	}
	bank := New(dsn, dsn, "https://figures.example", "")
	defer bank.Close()
	syllabus, err := bank.Syllabus(ctx)
	if err != nil || syllabus.Exams[0].Subjects[0].Topics[0].Total != 1 {
		t.Fatalf("syllabus: %#v %v", syllabus, err)
	}
	original, err := bank.Get(ctx, "q")
	if err != nil {
		t.Fatal(err)
	}
	if err := bank.Review(ctx, "q", "reviewer", true); err != nil {
		t.Fatal(err)
	}
	var question map[string]any
	if err := json.Unmarshal([]byte(raw), &question); err != nil {
		t.Fatal(err)
	}
	question["stem"] = []any{map[string]any{"type": "text", "text": "Edited"}}
	if err := bank.Save(ctx, "q", "editor", question, original.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	if err := bank.Save(ctx, "q", "editor", question, original.UpdatedAt); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale save: %v", err)
	}
	current, err := bank.Get(ctx, "q")
	if err != nil || current.ReviewedBy != "reviewer" || current.ReviewedAt == nil {
		t.Fatalf("review lost: %#v %v", current, err)
	}
	rows, err := bank.List(ctx, "topic")
	if err != nil || len(rows) != 1 || rows[0].Preview != "Edited" || rows[0].Marks != 1 {
		t.Fatalf("list: %#v %v", rows, err)
	}
	question["stem"] = []any{}
	if err := bank.Save(ctx, "q", "editor", question, current.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	rows, err = bank.List(ctx, "topic")
	if err != nil || rows[0].Preview != "Answer this" {
		t.Fatalf("part preview: %#v %v", rows, err)
	}
	if err := bank.Review(ctx, "q", "reviewer", false); err != nil {
		t.Fatal(err)
	}
	current, err = bank.Get(ctx, "q")
	if err != nil || current.ReviewedAt != nil || current.ReviewedBy != "" {
		t.Fatalf("undo: %#v %v", current, err)
	}
	// Column grants are the independent write boundary, even without HTTP checks.
	role := name + "_editor"
	if _, err := pool.Exec(ctx, "CREATE ROLE "+pgx.Identifier{role}.Sanitize()+" NOLOGIN"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = pool.Exec(ctx, "DROP OWNED BY "+pgx.Identifier{role}.Sanitize())
		_, _ = admin.Exec(ctx, "DROP ROLE "+pgx.Identifier{role}.Sanitize())
	}()
	grants := fmt.Sprintf("GRANT USAGE ON SCHEMA public TO %s; GRANT SELECT ON ALL TABLES IN SCHEMA public TO %s; GRANT UPDATE(content,updated_at,updated_by,reviewed_at,reviewed_by) ON questions TO %s", pgx.Identifier{role}.Sanitize(), pgx.Identifier{role}.Sanitize(), pgx.Identifier{role}.Sanitize())
	if _, err := pool.Exec(ctx, grants); err != nil {
		t.Fatal(err)
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SET ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = conn.Exec(ctx, "RESET ROLE") }()
	if _, err := conn.Exec(ctx, `UPDATE questions SET updated_by='allowed' WHERE id='q'`); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{`DELETE FROM questions WHERE id='q'`, `UPDATE questions SET sources='[]' WHERE id='q'`, `UPDATE topics SET label='forbidden' WHERE id='topic'`, `INSERT INTO questions(id,topic_id,position,content,run)VALUES('q2','topic',2,'{}','run')`} {
		if _, err := conn.Exec(ctx, sql); err == nil {
			t.Errorf("editor allowed: %s", sql)
		}
	}
}

func TestMissingBankConfigurationAndUnavailablePool(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := New("", "", "", "").Syllabus(ctx); !errors.Is(err, ErrUnconfigured) {
		t.Fatal(err)
	}
	b := New("postgres://unused:unused@127.0.0.1:1/bank?sslmode=disable", "", "", "")
	defer b.Close()
	if _, err := b.Syllabus(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("pool failure: %v", err)
	}
	if err := b.Review(ctx, "q", "u", true); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("read-only: %v", err)
	}
}
