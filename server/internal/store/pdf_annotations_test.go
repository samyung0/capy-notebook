package store

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestPDFDrawingAnnotations(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "pdf_drawing_owner")
	_, file := sourceTestFile(t, s, owner, "drawing.pdf", "pdf")
	body := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "pen", Color: "#d94848", Rects: []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}, Points: []PDFPoint{{X: 10, Y: 20}, {X: 100, Y: 70}, {X: 210, Y: 20}}}
	mark, err := s.SavePDFAnnotation(ctx, owner, file.ID, "", body)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.ListPDFAnnotations(ctx, owner, file.ID)
	if err != nil || len(rows) != 1 || !reflect.DeepEqual(rows[0].PDFAnnotationBody, body) {
		t.Fatalf("pen round trip: %+v %v", rows, err)
	}
	body.Kind, body.Points, body.Text = "text", nil, "細胞 membrane"
	updated, err := s.SavePDFAnnotation(ctx, owner, file.ID, mark.ID, body)
	if err != nil || updated.Text != body.Text || len(updated.Points) != 0 || updated.ID != mark.ID {
		t.Fatalf("text update: %+v %v", updated, err)
	}
	rows, err = s.ListPDFAnnotations(ctx, owner, file.ID)
	if err != nil || len(rows) != 1 || rows[0].Kind != "text" || rows[0].Text != body.Text || len(rows[0].Points) != 0 {
		t.Fatalf("text round trip: %+v %v", rows, err)
	}
}

func TestPDFDrawingValidation(t *testing.T) {
	base := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "pen", Color: "#d94848", Rects: []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}, Points: []PDFPoint{{X: 10, Y: 20}, {X: 200, Y: 30}}}
	for name, mutate := range map[string]func(*PDFAnnotationBody){
		"one point":       func(b *PDFAnnotationBody) { b.Points = b.Points[:1] },
		"too many points": func(b *PDFAnnotationBody) { b.Points = make([]PDFPoint, 4097) },
		"outside page":    func(b *PDFAnnotationBody) { b.Points = []PDFPoint{{X: -1}, {X: 1001}} },
		"nonfinite":       func(b *PDFAnnotationBody) { b.Points = []PDFPoint{{X: math.NaN()}, {Y: math.Inf(1)}} },
		"points on shape": func(b *PDFAnnotationBody) { b.Kind = "rectangle" },
		"empty text":      func(b *PDFAnnotationBody) { b.Kind, b.Points, b.Text = "text", nil, " \n" },
		"long text":       func(b *PDFAnnotationBody) { b.Kind, b.Points, b.Text = "text", nil, strings.Repeat("字", 2001) },
		"text on pen":     func(b *PDFAnnotationBody) { b.Text = "unexpected" },
	} {
		t.Run(name, func(t *testing.T) {
			body := base
			mutate(&body)
			if err := validatePDFAnnotation(body); !errors.Is(err, ErrInvalidPDFAnnotation) {
				t.Fatalf("invalid annotation accepted: %v", err)
			}
		})
	}
	base.Kind, base.Points, base.Text = "text", nil, strings.Repeat("字", 2000)
	if err := validatePDFAnnotation(base); err != nil {
		t.Fatalf("valid unicode text rejected: %v", err)
	}
}

// Marks are private to their author, so purge must remove them even on files in
// a workspace the author does not own (which outlives the purge).
func TestPurgeUserDeletesPDFAnnotations(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "pdf_purge_owner")
	member := newBlobTestUser(t, s, "pdf_purge_member")
	ws, file := sourceTestFile(t, s, owner, "shared.pdf", "pdf")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`, ws.ID, member); err != nil {
		t.Fatal(err)
	}
	body := PDFAnnotationBody{SourceIdentity: "revision:1", Page: 1, Kind: "highlight", Color: "#d94848", Rects: []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}}
	for _, actor := range []string{owner, member} {
		if _, err := s.SavePDFAnnotation(ctx, actor, file.ID, "", body); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := s.RequestAccountDeletion(ctx, member, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, member); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM pdf_annotations WHERE author_id=$1`, member).Scan(&n); err != nil || n != 0 {
		t.Fatalf("purged user's marks = %d %v", n, err)
	}
	if rows, err := s.ListPDFAnnotations(ctx, owner, file.ID); err != nil || len(rows) != 1 {
		t.Fatalf("owner's marks = %+v %v", rows, err)
	}
}
