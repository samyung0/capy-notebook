package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// TestRowCapsRefuseThePastTheLimitRow (security regression: rate-limit audit
// M9). A note stops at 500 live comments (opening comments and replies; a
// deleted one frees its place), one author's annotations on a file at 2,000,
// and a user's events at 5,000.
func TestRowCapsRefuseThePastTheLimitRow(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "row_caps_owner")
	ws, pdf := sourceTestFile(t, s, owner, "marks.pdf", "pdf")
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, Kind: "note", Title: "Note", Content: materialTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	rich := json.RawMessage(`[{"type":"p","children":[{"text":"hi"}]}]`)

	discussion, err := s.CreateCommentDiscussion(ctx, note.ID, owner, nil, nil, nil, 1, "", rich)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_comments (id, discussion_id, user_id, content_rich)
		SELECT 'com_cap_' || n, $1, $2, $3 FROM generate_series(2, $4::int) n`,
		discussion.ID, owner, rich, CommentsPerNote); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddComment(ctx, discussion.ID, owner, rich); !errors.Is(err, ErrTooManyComments) {
		t.Fatalf("reply past the cap: %v, want ErrTooManyComments", err)
	}
	if _, err := s.CreateCommentDiscussion(ctx, note.ID, owner, nil, nil, nil, 1, "", rich); !errors.Is(err, ErrTooManyComments) {
		t.Fatalf("discussion past the cap: %v, want ErrTooManyComments", err)
	}
	if err := s.SoftDeleteComment(ctx, "com_cap_2", owner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddComment(ctx, discussion.ID, owner, rich); err != nil {
		t.Fatalf("reply after a delete: %v", err)
	}

	mark := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "rectangle", Color: "#d94848",
		Rects: []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}}
	if _, err := s.pool.Exec(ctx, `INSERT INTO pdf_annotations (id, file_id, author_id, source_identity, page, kind, rects, color)
		SELECT 'ann_cap_' || n, $1, $2, 'revision:1', 1, 'rectangle', '[{"x":1,"y":1,"width":1,"height":1}]', '#d94848'
		FROM generate_series(1, $3::int) n`, pdf.ID, owner, AnnotationsPerFile); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SavePDFAnnotation(ctx, owner, pdf.ID, "", mark); !errors.Is(err, ErrTooManyAnnotations) {
		t.Fatalf("annotation past the cap: %v, want ErrTooManyAnnotations", err)
	}

	if _, err := s.pool.Exec(ctx, `INSERT INTO events (id, user_id, title, start_at, end_at)
		SELECT 'ev_cap_' || n, $1, 'Busy', now(), now() + interval '1 hour'
		FROM generate_series(1, $2::int) n`, owner, EventsPerUser); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateEvent(ctx, owner, Event{Title: "One more", Start: time.Now(), End: time.Now().Add(time.Hour)}); !errors.Is(err, ErrTooManyEvents) {
		t.Fatalf("event past the cap: %v, want ErrTooManyEvents", err)
	}
}
