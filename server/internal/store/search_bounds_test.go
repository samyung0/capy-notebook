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
// results themselves stop at 20, so the bound is read from Search's queries.
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
