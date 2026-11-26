package store

import (
	"context"
	"errors"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
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

// Staff mark what a member handed in (Epo 2026-11-25, mock
// B6H1Z7o4byVFBVyCRSUK3B): once it is handed in on a graded Assignment, every
// staff member reads and changes every staff mark, each with its maker; the
// member reads them read only, and only once their grade shows, as their file's
// Marked (Feedback given) does. An ungraded one takes no marks.
func TestStaffMarkASubmissionItsMemberReadsThem(t *testing.T) {
	f := newAssignmentFixture(t, "submission-marks")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, f.gradedForm(now.Add(time.Hour), 20), now)
	if err != nil {
		t.Fatal(err)
	}
	file := addHandInFile(t, f, created.ID, f.viewer, now)
	if _, err := f.s.ListPDFAnnotations(ctx, f.user, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff before it is handed in: %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	list, err := f.s.ListPDFAnnotations(ctx, f.user, file.ID)
	if err != nil || !list.Shared || list.ReadOnly {
		t.Fatalf("staff list = %+v, %v", list, err)
	}
	change := func(actor string, save []PDFAnnotation, remove ...string) error {
		return f.s.ChangePDFAnnotations(ctx, actor, file.ID, PDFAnnotationChanges{
			SourceIdentity: list.SourceIdentity, Save: save, Remove: append([]string{}, remove...)})
	}
	if err := change(f.viewer, []PDFAnnotation{testMark("pen")}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("the member marks their own work: %v", err)
	}
	if err := change(f.other, []PDFAnnotation{testMark("pen")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another member marks it: %v", err)
	}
	first, second := testMark("highlight"), testMark("note")
	if err := change(f.user, []PDFAnnotation{first}); err != nil {
		t.Fatal(err)
	}
	// The teaching assistant changes the owner's mark, which keeps its maker,
	// adds their own and removes nothing of anyone else's by accident.
	first.Comment = "Say why"
	if err := change(f.editor, []PDFAnnotation{first, second}); err != nil {
		t.Fatal(err)
	}
	marks := func(actor string) PDFAnnotationList {
		t.Helper()
		out, err := f.s.ListPDFAnnotations(ctx, actor, file.ID)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	got := marks(f.user).Marks
	if len(got) != 2 || got[0].Comment != "Say why" || got[0].Author == nil || got[0].Author.ID != f.user ||
		got[1].Author == nil || got[1].Author.ID != f.editor {
		t.Fatalf("staff marks = %+v", got)
	}
	marked := func() bool {
		t.Helper()
		mine, err := f.s.GetAssignment(ctx, f.viewer, created.ID, now)
		if err != nil || mine.Mine == nil || len(mine.Mine.HandIn) != 1 {
			t.Fatalf("member's assignment = %+v, %v", mine.Mine, err)
		}
		return mine.Mine.HandIn[0].Marked
	}
	// Nothing about marks shows before the grade (S1).
	if own := marks(f.viewer); len(own.Marks) != 0 || !own.ReadOnly || marked() {
		t.Fatalf("member before the grade = %+v", own)
	}
	points := 17.0
	if _, err := f.s.SetAssignmentGrade(ctx, f.user, created.ID, f.viewer, &points, now); err != nil {
		t.Fatal(err)
	}
	if own := marks(f.viewer); len(own.Marks) != 2 || !own.ReadOnly || !marked() {
		t.Fatalf("member after the grade = %+v", own)
	}
	if err := change(f.editor, nil, first.ID); err != nil {
		t.Fatal(err)
	}
	if got := marks(f.viewer).Marks; len(got) != 1 || got[0].ID != second.ID {
		t.Fatalf("after staff removed one = %+v", got)
	}

	// Graded off (T3): staff read it, but mark nothing.
	form := f.gradedForm(now.Add(time.Hour), 20)
	form.Points = nil
	ungraded, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	plain := addHandInFile(t, f, ungraded.ID, f.viewer, now)
	if err := f.s.SetAssignmentDone(ctx, f.viewer, ungraded.ID, true, now); err != nil {
		t.Fatal(err)
	}
	read, err := f.s.ListPDFAnnotations(ctx, f.user, plain.ID)
	if err != nil || !read.ReadOnly {
		t.Fatalf("ungraded staff list = %+v, %v", read, err)
	}
	if err := f.s.ChangePDFAnnotations(ctx, f.user, plain.ID, PDFAnnotationChanges{
		SourceIdentity: read.SourceIdentity, Save: []PDFAnnotation{testMark("pen")}, Remove: []string{}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ungraded mark: %v", err)
	}
}

// TestStaffMarkAPhotoOnItsOnePage: a handed-in photo is marked as a page its
// own size (mock B6H1Z7o4byVFBVyCRSUK3B T2), so a mark lands on page 1 only.
func TestStaffMarkAPhotoOnItsOnePage(t *testing.T) {
	f := newAssignmentFixture(t, "photo-marks")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, f.gradedForm(now.Add(time.Hour), 20), now)
	if err != nil {
		t.Fatal(err)
	}
	file := addHandInFile(t, f, created.ID, f.viewer, now)
	if _, err := f.s.pool.Exec(ctx, `UPDATE files SET kind='image' WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	list, err := f.s.ListPDFAnnotations(ctx, f.user, file.ID)
	if err != nil || list.ReadOnly {
		t.Fatalf("staff list = %+v, %v", list, err)
	}
	mark := testMark("rectangle")
	if err := f.s.ChangePDFAnnotations(ctx, f.user, file.ID, PDFAnnotationChanges{
		SourceIdentity: list.SourceIdentity, Save: []PDFAnnotation{mark}}); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.ListPDFAnnotations(ctx, f.user, file.ID); err != nil || len(got.Marks) != 1 {
		t.Fatalf("photo marks = %+v, %v", got, err)
	}
}

// TestStaffMarkAWordFileOnItsCopy: a handed-in .docx is marked on the PDF
// copy the first staff browser stores (mock B6H1Z7o4byVFBVyCRSUK3B C1).
func TestStaffMarkAWordFileOnItsCopy(t *testing.T) {
	f := newAssignmentFixture(t, "word-copy")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, f.gradedForm(now.Add(time.Hour), 20), now)
	if err != nil {
		t.Fatal(err)
	}
	file := addHandInFile(t, f, created.ID, f.viewer, now)
	if _, err := f.s.pool.Exec(ctx, `UPDATE files SET kind='doc', name='essay.docx' WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if err := f.s.AssertMarkedCopy(ctx, f.editor, file.ID, "copies/"+file.ID+"/a.pdf"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetMarkedCopy(ctx, f.editor, file.ID, "copies/"+file.ID+"/a.pdf"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetMarkedCopy(ctx, f.user, file.ID, "copies/"+file.ID+"/b.pdf"); !errors.Is(err, ErrMarkedCopyTaken) {
		t.Fatalf("a second copy: %v", err)
	}
	blob, err := f.s.HandInFileBlob(ctx, f.user, created.ID, file.ID)
	if err != nil || blob.Copy != "copies/"+file.ID+"/a.pdf" {
		t.Fatalf("staff links = %+v, %v", blob, err)
	}
	// Its member gets the copy once the grade shows, not before (S1).
	points := 15.0
	if _, err := f.s.SetAssignmentGrade(ctx, f.user, created.ID, f.viewer, &points, now); err != nil {
		t.Fatal(err)
	}
	if own, err := f.s.HandInFileBlob(ctx, f.viewer, created.ID, file.ID); err != nil || own.Copy == "" {
		t.Fatalf("member links after the grade = %+v, %v", own, err)
	}
	list, err := f.s.ListPDFAnnotations(ctx, f.user, file.ID)
	if err != nil || list.ReadOnly {
		t.Fatalf("staff list = %+v, %v", list, err)
	}
	if err := f.s.ChangePDFAnnotations(ctx, f.user, file.ID, PDFAnnotationChanges{
		SourceIdentity: list.SourceIdentity, Save: []PDFAnnotation{testMark("pen")}}); err != nil {
		t.Fatal(err)
	}
}
