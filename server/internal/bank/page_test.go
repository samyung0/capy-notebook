package bank

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

func pageIDs(p TopicPage) []string {
	ids := []string{}
	for _, row := range p.Items {
		ids = append(ids, row.ID)
	}
	return ids
}

func TestPageRows(t *testing.T) {
	now := time.Now()
	rows := []Row{}
	for i, id := range []string{"a", "b", "c", "d", "e"} {
		row := Row{ID: id, Position: (i + 1) * 10, Preview: "Question " + id, AnswerTypes: []string{"mcq"}}
		if i%2 == 1 {
			row.AnswerTypes = []string{"short", "mcq"}
			row.ReviewedAt = &now
		}
		rows = append(rows, row)
	}

	first, _ := PageRows(rows, ListFilter{Limit: 2})
	if !slices.Equal(pageIDs(first), []string{"a", "b"}) || first.PrevCursor != "" || !slices.Equal(first.AnswerTypes, []string{"mcq", "short"}) {
		t.Fatalf("first page = %+v", first)
	}
	second, _ := PageRows(rows, ListFilter{Limit: 2, Cursor: first.NextCursor})
	back, _ := PageRows(rows, ListFilter{Limit: 2, Cursor: second.PrevCursor})
	if !slices.Equal(pageIDs(second), []string{"c", "d"}) || !slices.Equal(pageIDs(back), []string{"a", "b"}) {
		t.Fatalf("second = %v, back = %v", pageIDs(second), pageIDs(back))
	}
	// Around lands on the page holding the question, page-aligned.
	around, _ := PageRows(rows, ListFilter{Limit: 2, Around: "d"})
	if !slices.Equal(pageIDs(around), []string{"c", "d"}) || around.PrevCursor == "" || around.NextCursor == "" {
		t.Fatalf("around = %+v", around)
	}

	// A row that stops matching between pages (answered while filtered) shifts nothing.
	notDone := ListFilter{Limit: 2, Statuses: []string{"notDone"}, Marks: map[string]float64{}}
	p1, _ := PageRows(rows, notDone)
	notDone.Marks = map[string]float64{"a": 1}
	notDone.Cursor = p1.NextCursor
	p2, _ := PageRows(rows, notDone)
	if !slices.Equal(pageIDs(p1), []string{"a", "b"}) || !slices.Equal(pageIDs(p2), []string{"c", "d"}) {
		t.Fatalf("status pages = %v then %v", pageIDs(p1), pageIDs(p2))
	}

	for name, f := range map[string]ListFilter{
		"type":       {Types: []string{"short"}},
		"status":     {Statuses: []string{"partial", "wrong"}, Marks: map[string]float64{"b": 0.5, "d": 0, "e": 1}},
		"search":     {Search: "QUESTION B"},
		"unreviewed": {Unreviewed: true},
	} {
		f.Limit = 10
		got, _ := PageRows(rows, f)
		want := map[string][]string{"type": {"b", "d"}, "status": {"b", "d"}, "search": {"b"}, "unreviewed": {"a", "c", "e"}}[name]
		if !slices.Equal(pageIDs(got), want) {
			t.Errorf("%s filter = %v, want %v", name, pageIDs(got), want)
		}
	}

	if _, err := PageRows(rows, ListFilter{Limit: 2, Cursor: "bad"}); !errors.Is(err, store.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
}
