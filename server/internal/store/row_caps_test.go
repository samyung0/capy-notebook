package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// TestRowCapsRefuseThePastTheLimitRow (security regression: rate-limit audit
// M9; review M-3, L-5). A note stops at 500 comments in its open discussions
// (opening comments and replies, deleted ones included, so a reply-then-delete
// loop still reaches it), a file at 2,000 annotations whoever wrote them, and
// a user at 5,000 events.
func TestRowCapsRefuseThePastTheLimitRow(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "row_caps_owner")
	reader := newBlobTestUser(t, s, "row_caps_reader")
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
	// The opening comment and 497 more leave room for two replies.
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_comments (id, discussion_id, user_id, content_rich)
		SELECT 'com_cap_' || n, $1, $2, $3 FROM generate_series(2, $4::int) n`,
		discussion.ID, owner, rich, CommentsPerNote-2); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		reply, err := s.AddComment(ctx, discussion.ID, owner, rich)
		if err != nil {
			t.Fatalf("reply under the cap: %v", err)
		}
		if err := s.SoftDeleteComment(ctx, reply.ID, owner); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AddComment(ctx, discussion.ID, owner, rich); !errors.Is(err, ErrTooManyComments) {
		t.Fatalf("reply after replies and deletes filled the cap: %v, want ErrTooManyComments", err)
	}
	if _, err := s.CreateCommentDiscussion(ctx, note.ID, owner, nil, nil, nil, 1, "", rich); !errors.Is(err, ErrTooManyComments) {
		t.Fatalf("discussion past the cap: %v, want ErrTooManyComments", err)
	}

	mark := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "rectangle", Color: "#d94848",
		Rects: []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}}
	if _, err := s.pool.Exec(ctx, `INSERT INTO pdf_annotations (id, file_id, author_id, source_identity, page, kind, rects, color)
		SELECT 'ann_cap_' || n, $1, $2, 'revision:1', 1, 'rectangle', '[{"x":1,"y":1,"width":1,"height":1}]', '#d94848'
		FROM generate_series(1, $3::int) n`, pdf.ID, reader, AnnotationsPerFile); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SavePDFAnnotation(ctx, owner, pdf.ID, "", mark); !errors.Is(err, ErrTooManyAnnotations) {
		t.Fatalf("annotation on a file another author filled: %v, want ErrTooManyAnnotations", err)
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
