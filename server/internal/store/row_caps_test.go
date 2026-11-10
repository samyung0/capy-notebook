package store

import (
	"context"
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
	commentText := "hi"

	discussion, err := s.CreateCommentDiscussion(ctx, note.ID, owner, nil, nil, nil, 1, "", commentText)
	if err != nil {
		t.Fatal(err)
	}
	// The opening comment and 497 more leave room for two replies.
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_comments (id, discussion_id, user_id, text)
		SELECT 'com_cap_' || n, $1, $2, $3 FROM generate_series(2, $4::int) n`,
		discussion.ID, owner, commentText, CommentsPerNote-2); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		reply, err := s.AddComment(ctx, discussion.ID, owner, commentText)
		if err != nil {
			t.Fatalf("reply under the cap: %v", err)
		}
		if err := s.SoftDeleteComment(ctx, reply.ID, owner); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AddComment(ctx, discussion.ID, owner, commentText); !errors.Is(err, ErrTooManyComments) {
		t.Fatalf("reply after replies and deletes filled the cap: %v, want ErrTooManyComments", err)
	}
	if _, err := s.CreateCommentDiscussion(ctx, note.ID, owner, nil, nil, nil, 1, "", commentText); !errors.Is(err, ErrTooManyComments) {
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

// TestAssignmentCaps (Epo 2026-11-10): a class holds at most
// OpenAssignmentsPerClass open assignments and AssignmentsPerClass in all.
// Making one published, publishing a draft and reopening a closed one each
// need a place among the open ones; closing or deleting one makes room.
func TestAssignmentCaps(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-caps")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	task := func(draft bool) AssignmentForm {
		return AssignmentForm{Kind: AssignmentUnmarked, Title: "Read it", Attempts: 1, Draft: draft,
			AssignAll: true, Assignees: []string{}, Marking: MarkingAIApprove, ShowAnswers: AnswersAfterClose, ShowGrades: GradesAutomatic,
			Files: []AssignmentFileRef{}}
	}
	first, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, task(false), now)
	if err != nil {
		t.Fatal(err)
	}
	// Copies of the first one, open or closed.
	seed := func(prefix string, count int, closed bool) {
		t.Helper()
		if _, err := f.s.pool.Exec(ctx, `INSERT INTO assignments (id, workspace_id, created_by, kind, title, attempts_allowed,
				no_late, late_penalty_pct, assign_all, draft, marking, answers_shown, grades_shown, shuffle, allow_uploads, posted_at, created_at, closed_at)
			SELECT $2 || n, a.workspace_id, a.created_by, a.kind, a.title, a.attempts_allowed,
				a.no_late, a.late_penalty_pct, a.assign_all, false, a.marking, a.answers_shown, a.grades_shown, a.shuffle, a.allow_uploads, a.posted_at, a.created_at,
				CASE WHEN $4 THEN a.created_at END
			FROM assignments a, generate_series(1, $3::int) n WHERE a.id=$1`, first.ID, prefix, count, closed); err != nil {
			t.Fatal(err)
		}
	}
	seed("as_cap_open_", OpenAssignmentsPerClass-1, false)
	if _, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, task(false), now); !errors.Is(err, ErrTooManyOpenAssignments) {
		t.Fatalf("an open one past the cap: %v, want ErrTooManyOpenAssignments", err)
	}
	draft, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, task(true), now)
	if err != nil {
		t.Fatalf("a draft with the open ones full: %v", err)
	}
	if _, err := f.s.PublishAssignment(ctx, f.user, draft.ID, nil, now); !errors.Is(err, ErrTooManyOpenAssignments) {
		t.Fatalf("publishing past the cap: %v, want ErrTooManyOpenAssignments", err)
	}
	// Closing one makes room for the draft; reopening it then has none.
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, first.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.PublishAssignment(ctx, f.user, draft.ID, nil, now); err != nil {
		t.Fatalf("publishing after one closed: %v", err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, first.ID, false, now); !errors.Is(err, ErrTooManyOpenAssignments) {
		t.Fatalf("reopening past the cap: %v, want ErrTooManyOpenAssignments", err)
	}

	// 101 so far; closed copies fill the class.
	seed("as_cap_closed_", AssignmentsPerClass-OpenAssignmentsPerClass-1, true)
	if _, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, task(true), now); !errors.Is(err, ErrTooManyAssignments) {
		t.Fatalf("a draft in a full class: %v, want ErrTooManyAssignments", err)
	}
	if err := f.s.DeleteAssignment(ctx, f.user, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, task(true), now); err != nil {
		t.Fatalf("a draft after one was deleted: %v", err)
	}
}
