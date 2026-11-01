package store

import (
	"context"
	"encoding/json"
	"testing"
)

// TestStarterNoteFilesItsQuizAndCardsInTheChapter: the starter workspace's
// welcome note lands in the chapter it is given with two quiz questions and
// two flashcards embedded, in the account's locale.
func TestStarterNoteFilesItsQuizAndCardsInTheChapter(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_starter_note")
	if _, err := s.UpsertUserFromClerk(ctx, userID, "Starter User", userID+"@example.test", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET locale='zh' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	ws, err := s.CreateDefaultWorkspace(ctx, userID)
	if err != nil || ws.ID == "" || ws.Locale != "zh" {
		t.Fatalf("starter workspace = %+v, err %v", ws, err)
	}
	sample := StarterCopyFor(ws.Locale)
	chapter, err := s.AddChapter(ctx, ws.ID, userID, sample.Chapter)
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateStarterNote(ctx, userID, ws, chapter.ID)
	if err != nil {
		t.Fatal(err)
	}
	if note.ChapterID == nil || *note.ChapterID != chapter.ID || note.Title != sample.note.title {
		t.Fatalf("note chapter %v title %q", note.ChapterID, note.Title)
	}

	rows, err := s.pool.Query(ctx, `SELECT kind, content FROM materials
		WHERE parent_material_id=$1 ORDER BY kind`, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	children := map[string]int{}
	for rows.Next() {
		var kind, content string
		if err := rows.Scan(&kind, &content); err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Value []struct {
				Children []json.RawMessage `json:"children"`
			} `json:"value"`
		}
		if err := json.Unmarshal([]byte(content), &doc); err != nil || len(doc.Value) != 1 {
			t.Fatalf("%s content %s: %v", kind, content, err)
		}
		children[kind] = len(doc.Value[0].Children)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if children["quiz"] != 2 || children["flashcards"] != 2 || len(children) != 2 {
		t.Fatalf("embedded rows = %v, want a quiz of 2 questions and 2 cards", children)
	}

	// Provisioned once: a second call inserts nothing to fill.
	again, err := s.CreateDefaultWorkspace(ctx, userID)
	if err != nil || again.ID != "" {
		t.Fatalf("second provisioning = %+v, err %v", again, err)
	}
}
