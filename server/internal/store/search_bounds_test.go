package store

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestSearchMatchesWildcardsLiterally (security regression: rate-limit audit
// L4). A % or _ in the query matches only itself, never every row.
func TestSearchMatchesWildcardsLiterally(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	for i, title := range []string{"Done 100% of it", "plain_title", "Something else"} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO events (id, user_id, title, start_at, end_at)
			VALUES ($1, $2, $3, now(), now() + interval '1 hour')`, uid("ev")+strconv.Itoa(i), userID, title); err != nil {
			t.Fatal(err)
		}
	}
	for q, want := range map[string]string{"%": "Done 100% of it", "_": "plain_title"} {
		results, err := s.Search(ctx, userID, q)
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0].Title != want {
			t.Errorf("Search(%q) = %+v, want only %q", q, results, want)
		}
	}
}

// TestSearchSectionsAreLimited (security regression: rate-limit audit L4).
// Every section a global search reads stops at searchSectionLimit rows; the
// results themselves stop at searchKindLimit of each kind, so the bound is read
// from Search's queries.
func TestSearchSectionsAreLimited(t *testing.T) {
	source, err := os.ReadFile("queries.go")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(source), "func (s *Store) Search(")
	end := strings.Index(string(source)[start:], "\n}\n")
	search := string(source)[start : start+end]
	queries := strings.Count(search, "s.pool.Query(")
	limited := strings.Count(search, "LIMIT `+strconv.Itoa(searchSectionLimit)")
	if queries == 0 || limited != queries || searchSectionLimit != 50 {
		t.Fatalf("Search runs %d section queries, %d limited to %d", queries, limited, searchSectionLimit)
	}
}

// Search finds every material by its title, canvases included (Epo
// 2026-11-13): a name starting with the query comes before one holding it, and
// a workspace's canvas opens on that workspace's Canvas panel.
func TestSearchFindsMaterialsAndCanvases(t *testing.T) {
	f := newStudyFixture(t, "search-materials")
	ctx := context.Background()
	for _, title := range []string{"Biology cells", "Cells overview"} {
		if _, err := f.s.CreateFlashcardSetWithCards(ctx, f.user, title, "blue", f.ws.ID, [][2]string{{"Q", "A"}}, "", nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	canvas, err := f.s.CreateCanvas(ctx, f.user, "Cells board", f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	results, err := f.s.Search(ctx, f.user, "cells")
	if err != nil {
		t.Fatal(err)
	}
	var sets []string
	var board *SearchResult
	for i, r := range results {
		switch r.Kind {
		case SearchKind(MaterialFlashcards):
			sets = append(sets, r.Title)
		case SearchKind(MaterialCanvas):
			board = &results[i]
		}
	}
	if len(sets) != 2 || sets[0] != "Cells overview" {
		t.Fatalf("flashcard sets %v, want Cells overview first", sets)
	}
	if board == nil || board.ID != canvas.ID || board.Href != "/workspaces/"+f.ws.ID+"?view=canvas" {
		t.Fatalf("canvas hit %+v", board)
	}
}

// A typo still finds a name (Epo 2026-11-13, migration 0172) once the query
// has four characters, after every exact or substring hit.
func searchTitles(t *testing.T, f studyFixture, q string) []string {
	t.Helper()
	results, err := f.s.Search(context.Background(), f.user, q)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, r := range results {
		if r.Kind == SearchKind(MaterialFlashcards) {
			out = append(out, r.Title)
		}
	}
	return out
}

func TestSearchToleratesTypos(t *testing.T) {
	f := newStudyFixture(t, "search-typos")
	ctx := context.Background()
	for _, title := range []string{"Biology 101", "Organelles", "Mats and rugs", "Advanced chemistry"} {
		if _, err := f.s.CreateFlashcardSetWithCards(ctx, f.user, title, "blue", f.ws.ID, [][2]string{{"Q", "A"}}, "", nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	for q, want := range map[string]string{
		"biolgy":         "Biology 101",
		"orgnelles":      "Organelles",
		"adv chemsitry":  "Advanced chemistry",
		"biolgy chemsit": "",
		"math":           "",
	} {
		got := searchTitles(t, f, q)
		if want == "" && len(got) != 0 || want != "" && (len(got) != 1 || got[0] != want) {
			t.Errorf("%q found %v, want %q", q, got, want)
		}
	}
}

func TestSearchLooksFurtherOnlyWhenHitsAreFew(t *testing.T) {
	f := newStudyFixture(t, "search-few")
	ctx := context.Background()
	create := func(title string) {
		if _, err := f.s.CreateFlashcardSetWithCards(ctx, f.user, title, "blue", f.ws.ID, [][2]string{{"Q", "A"}}, "", nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	create("Plants")
	create("Plant cells")
	if got := searchTitles(t, f, "plans"); len(got) != 2 {
		t.Fatalf("plans found %v, want both plant sets a typo away", got)
	}
	for _, title := range []string{"Plans A", "Plans B", "Plans C"} {
		create(title)
	}
	if got := searchTitles(t, f, "plans"); len(got) != 3 {
		t.Fatalf("plans found %v, want only the three exact sets", got)
	}
}
