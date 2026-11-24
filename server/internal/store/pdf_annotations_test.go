package store

import (
	"context"
	"errors"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// testMark is a valid mark of the kind on page 1, with a fresh ID.
func testMark(kind string) PDFAnnotation {
	mark := PDFAnnotation{ID: uid("ann"), Page: 1, Kind: kind, Color: "#d94848", Rects: []PDFRect{}, Strokes: [][]PDFPoint{}}
	switch kind {
	case "highlight", "underline":
		mark.Rects, mark.Text = []PDFRect{{X: 10, Y: 20, Width: 200, Height: 14}, {X: 10, Y: 36, Width: 120, Height: 14}}, "the cell membrane"
	case "pen", "marker":
		mark.Strokes, mark.Width = [][]PDFPoint{{{X: 10, Y: 20}, {X: 100, Y: 70}, {X: 210, Y: 20}}, {{X: 220, Y: 20}, {X: 240, Y: 40}}}, 3
	case "arrow":
		mark.Strokes, mark.Width = [][]PDFPoint{{{X: 10, Y: 20}, {X: 300, Y: 200}}}, 3
	case "rectangle", "ellipse":
		mark.Rects, mark.Width = []PDFRect{{X: 10, Y: 20, Width: 200, Height: 50}}, 3
	case "text":
		mark.Rects, mark.Size, mark.Text = []PDFRect{{X: 10, Y: 20, Width: 200, Height: 20}}, 15, "細胞 membrane"
	case "note":
		mark.Rects, mark.Comment = []PDFRect{{X: 900, Y: 20, Width: 24, Height: 24}}, "Ask about this"
	}
	return mark
}

func saveMarks(ctx context.Context, s *Store, actor, file string, marks ...PDFAnnotation) error {
	return s.ChangePDFAnnotations(ctx, actor, file, PDFAnnotationChanges{SourceIdentity: "revision:1", Save: marks, Remove: []string{}})
}

func removeMarks(ctx context.Context, s *Store, actor, file string, ids ...string) error {
	return s.ChangePDFAnnotations(ctx, actor, file, PDFAnnotationChanges{SourceIdentity: "revision:1", Save: []PDFAnnotation{}, Remove: ids})
}

func TestPDFMarksRoundTrip(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "pdf_marks_owner")
	_, file := sourceTestFile(t, s, owner, "marks.pdf", "pdf")
	var marks []PDFAnnotation
	for _, kind := range []string{"highlight", "underline", "marker", "pen", "text", "note", "rectangle", "ellipse", "arrow"} {
		mark := testMark(kind)
		mark.Comment = "why " + kind
		marks = append(marks, mark)
	}
	if err := saveMarks(ctx, s, owner, file.ID, marks...); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListPDFAnnotations(ctx, owner, file.ID)
	// One write's marks share created_at, so the list orders them by ID.
	slices.SortFunc(marks, func(a, b PDFAnnotation) int { return strings.Compare(a.ID, b.ID) })
	if err != nil || list.SourceIdentity != "revision:1" || !reflect.DeepEqual(list.Marks, marks) {
		t.Fatalf("round trip = %+v %v", list, err)
	}

	// One write saves over a mark, adds one and removes another.
	kind := func(k string) PDFAnnotation {
		return marks[slices.IndexFunc(marks, func(m PDFAnnotation) bool { return m.Kind == k })]
	}
	moved, removed := kind("pen"), kind("highlight")
	moved.Strokes = [][]PDFPoint{{{X: 20, Y: 30}, {X: 110, Y: 80}}}
	added := testMark("text")
	if err := s.ChangePDFAnnotations(ctx, owner, file.ID, PDFAnnotationChanges{SourceIdentity: "revision:1",
		Save: []PDFAnnotation{moved, added}, Remove: []string{removed.ID, "ann_0000000000"}}); err != nil {
		t.Fatal(err)
	}
	list, err = s.ListPDFAnnotations(ctx, owner, file.ID)
	if err != nil || len(list.Marks) != len(marks) {
		t.Fatalf("after one write = %d marks %v", len(list.Marks), err)
	}
	for _, mark := range list.Marks {
		if mark.ID == removed.ID {
			t.Fatal("removed mark still listed")
		}
		if mark.ID == moved.ID && !reflect.DeepEqual(mark, moved) {
			t.Fatalf("saved-over pen = %+v", mark)
		}
	}
}

func TestPDFMarkValidation(t *testing.T) {
	for name, mutate := range map[string]func(*PDFAnnotation){
		"bad id":             func(m *PDFAnnotation) { m.ID = "mark_1" },
		"one-point stroke":   func(m *PDFAnnotation) { m.Strokes = [][]PDFPoint{{{X: 1, Y: 1}}} },
		"too many points":    func(m *PDFAnnotation) { m.Strokes = [][]PDFPoint{make([]PDFPoint, 4097)} },
		"outside page":       func(m *PDFAnnotation) { m.Strokes = [][]PDFPoint{{{X: -1}, {X: 1001}}} },
		"nonfinite":          func(m *PDFAnnotation) { m.Strokes = [][]PDFPoint{{{X: math.NaN()}, {Y: math.Inf(1)}}} },
		"pen without width":  func(m *PDFAnnotation) { m.Width = 0 },
		"pen too wide":       func(m *PDFAnnotation) { m.Width = 81 },
		"strokes on a shape": func(m *PDFAnnotation) { m.Kind = "rectangle" },
		"text on a pen":      func(m *PDFAnnotation) { m.Text = "unexpected" },
		"long comment":       func(m *PDFAnnotation) { m.Comment = strings.Repeat("字", 3001) },
		"empty text":         func(m *PDFAnnotation) { *m = testMark("text"); m.Text = " \n" },
		"text without size":  func(m *PDFAnnotation) { *m = testMark("text"); m.Size = 0 },
		"long text":          func(m *PDFAnnotation) { *m = testMark("text"); m.Text = strings.Repeat("字", 2001) },
		"empty note":         func(m *PDFAnnotation) { *m = testMark("note"); m.Comment = " " },
		"arrow of three": func(m *PDFAnnotation) {
			*m = testMark("arrow")
			m.Strokes[0] = append(m.Strokes[0], PDFPoint{X: 5, Y: 5})
		},
		"band off the page": func(m *PDFAnnotation) { *m = testMark("highlight"); m.Rects[0].Width = 1000 },
	} {
		t.Run(name, func(t *testing.T) {
			mark := testMark("pen")
			mutate(&mark)
			if err := validatePDFAnnotation(mark); !errors.Is(err, ErrInvalidPDFAnnotation) {
				t.Fatalf("invalid mark accepted: %v", err)
			}
		})
	}
	mark := testMark("text")
	mark.Text, mark.Comment = strings.Repeat("字", 2000), strings.Repeat("字", 3000)
	if err := validatePDFAnnotation(mark); err != nil {
		t.Fatalf("valid unicode text rejected: %v", err)
	}
	// Corners rounded to hundredths may sum a float's hair over the page.
	band := testMark("highlight")
	band.Rects[0].X, band.Rects[0].Width = 226.73, 773.27
	if err := validatePDFAnnotation(band); err != nil {
		t.Fatalf("band to the page's edge rejected: %v", err)
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
	for _, actor := range []string{owner, member} {
		if err := saveMarks(ctx, s, actor, file.ID, testMark("highlight")); err != nil {
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
	if list, err := s.ListPDFAnnotations(ctx, owner, file.ID); err != nil || len(list.Marks) != 1 {
		t.Fatalf("owner's marks = %+v %v", list, err)
	}
}

// A trashed PDF opened from the Trash shows its reader's own marks, read-only
// (Epo 2026-11-12): the list reads them, a save still refuses, and anyone who
// cannot see it in a Trash list reads nothing.
func TestTrashedPDFAnnotationsReadOnly(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "pdf_trashed_owner")
	stranger := newBlobTestUser(t, s, "pdf_trashed_stranger")
	_, file := sourceTestFile(t, s, owner, "trashed.pdf", "pdf")
	if err := saveMarks(ctx, s, owner, file.ID, testMark("pen")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TrashFile(ctx, owner, file.ID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	if list, err := s.ListPDFAnnotations(ctx, owner, file.ID); err != nil || len(list.Marks) != 1 {
		t.Fatalf("owner marks on a trashed PDF = %+v %v", list, err)
	}
	if err := saveMarks(ctx, s, owner, file.ID, testMark("pen")); err == nil {
		t.Fatal("a trashed PDF took a new mark")
	}
	if _, err := s.ListPDFAnnotations(ctx, stranger, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger marks on a trashed PDF = %v", err)
	}
}
