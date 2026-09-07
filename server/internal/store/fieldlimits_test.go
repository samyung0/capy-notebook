package store

import (
	"context"
	"regexp"
	"strconv"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// TestColumnLimits keeps the migration's char_length CHECKs equal to
// fieldlimits: every listed column has a CHECK with the constant's value, and
// every char_length CHECK in the schema is listed.
func TestColumnLimits(t *testing.T) {
	s := openAccessTestStore(t)
	rows, err := s.pool.Query(context.Background(), `
		SELECT c.conrelid::regclass::text, pg_get_constraintdef(c.oid)
		FROM pg_constraint c
		JOIN pg_namespace n ON n.oid = c.connamespace
		WHERE c.contype = 'c' AND n.nspname = 'public'
		  AND pg_get_constraintdef(c.oid) LIKE '%char_length(%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	limit := regexp.MustCompile(`char_length\((\w+)\)\s*(?:<=|BETWEEN 1 AND)\s*(\d+)`)
	found := map[string]int{}
	for rows.Next() {
		var table, def string
		if err := rows.Scan(&table, &def); err != nil {
			t.Fatal(err)
		}
		m := limit.FindStringSubmatch(def)
		if m == nil {
			t.Errorf("%s: unrecognised length CHECK %q", table, def)
			continue
		}
		max, _ := strconv.Atoi(m[2])
		found[table+"."+m[1]] = max
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for column, want := range fieldlimits.Columns {
		if got, ok := found[column]; !ok {
			t.Errorf("%s: no char_length CHECK in 0001_init.sql (want %d)", column, want)
		} else if got != want {
			t.Errorf("%s: CHECK is %d, fieldlimits says %d", column, got, want)
		}
	}
	for column := range found {
		if _, ok := fieldlimits.Columns[column]; !ok {
			t.Errorf("%s: char_length CHECK is not listed in fieldlimits.Columns", column)
		}
	}
}
