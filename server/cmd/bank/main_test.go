package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/bankmigrations"
)

func TestPublicationNeverOverwritesExistingQuestions(t *testing.T) {
	if os.Getenv("CAPY_GO_DISPOSABLE_DATABASE") != "1" {
		t.Skip("use pnpm test:go for a disposable database")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, cfg.Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("bank_publish_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE")
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	names, err := fs.Glob(bankmigrations.FS, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		sql, err := bankmigrations.FS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(sql)); err != nil {
			t.Fatal(err)
		}
	}
	p := publication{Run: "first", Questions: []entry{{Content: map[string]any{"id": "question-1", "text": "original"}, Sources: json.RawMessage("[]")}}}
	p.Syllabus.Exam = node{ID: "exam", Label: "Exam"}
	p.Syllabus.Subject = node{ID: "subject", Label: "Subject"}
	p.Syllabus.Topic = node{ID: "topic", Label: "Topic"}
	if err = insertPublication(ctx, pool, p); err != nil {
		t.Fatal(err)
	}
	var position int
	if err = pool.QueryRow(ctx, "SELECT position FROM questions WHERE id='question-1'").Scan(&position); err != nil || position != 1 {
		t.Fatalf("first question position=%d err=%v", position, err)
	}
	if _, err = pool.Exec(ctx, "UPDATE questions SET reviewed_at=now(),reviewed_by='reviewer' WHERE id='question-1'"); err != nil {
		t.Fatal(err)
	}
	p.Run = "second"
	p.Questions[0].Content["text"] = "overwrite attempt"
	if err = insertPublication(ctx, pool, p); err != nil {
		t.Fatal(err)
	}
	var text, run, reviewer string
	var count int
	if err = pool.QueryRow(ctx, "SELECT content->>'text',run,reviewed_by FROM questions WHERE id='question-1'").Scan(&text, &run, &reviewer); err != nil {
		t.Fatal(err)
	}
	if text != "original" || run != "first" || reviewer != "reviewer" {
		t.Fatalf("existing question changed: %q %q %q", text, run, reviewer)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM questions").Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

func TestSourceReferenceContract(t *testing.T) {
	for _, raw := range []string{
		`null`,
		`[{"excerptId":"e","bookId":"b","version":1}]`,
		`[{"kind":"library","excerptId":"e","bookId":"b","version":0}]`,
		`[{"kind":"library","excerptId":"e","bookId":"b","version":1,"extra":true}]`,
		`[{"kind":"library","excerptId":"e","bookId":"b","version":1,"url":"https://x.org"}]`,
		`[{"kind":"web","url":"https://x.org/a","title":"A","license":"CC BY-ND 4.0","retrievedAt":"2026-10-02"}]`,
		`[{"kind":"web","url":"https://x.org/a","title":"A","license":"CC BY-NC-SA 4.0","retrievedAt":"2026-10-02"}]`,
		`[{"kind":"web","url":"https://x.org/a","title":"A","license":"CC BY 4.0","retrievedAt":"yesterday"}]`,
	} {
		if _, err := parseSources(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`[{"kind":"library","excerptId":"e","bookId":"b","version":1}]`,
		`[{"kind":"web","url":"https://x.org/a","title":"A","authors":["B"],"publisher":"P","license":"CC BY 4.0","licenseUrl":"https://creativecommons.org/licenses/by/4.0/","retrievedAt":"2026-10-02"}]`,
	} {
		if _, err := parseSources(json.RawMessage(raw)); err != nil {
			t.Fatal(err)
		}
	}
}
