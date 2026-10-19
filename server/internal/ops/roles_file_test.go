package ops

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// deploy/ops-roles.sql is applied by hand with psql, so nothing else notices a
// grant on a column a migration dropped until the file fails on a real
// environment (notification_prefs.email_membership, dropped in 0060, stayed
// granted). Every table and column it grants must exist after migrations.
func TestOpsRolesFileGrantsOnlyExistingColumns(t *testing.T) {
	sql, err := os.ReadFile("../../../deploy/ops-roles.sql")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, integrationDSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	grant := regexp.MustCompile(`(?is)GRANT\s+((?:SELECT|INSERT|UPDATE|DELETE)[^;]*?)\s+ON\s+(?:TABLE\s+)?([a-z_][a-z0-9_]*)\s+TO`)
	columnList := regexp.MustCompile(`\(([^)]*)\)`)
	matches := grant.FindAllStringSubmatch(string(sql), -1)
	if len(matches) < 10 {
		t.Fatalf("parsed only %d grants from deploy/ops-roles.sql", len(matches))
	}
	for _, match := range matches {
		table := match[2]
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1)`, table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Errorf("deploy/ops-roles.sql grants on missing table %s", table)
			continue
		}
		var columns []string
		for _, list := range columnList.FindAllStringSubmatch(match[1], -1) {
			columns = append(columns, strings.Split(list[1], ",")...)
		}
		for _, column := range columns {
			column = strings.TrimSpace(column)
			if column == "" {
				continue
			}
			if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2)`,
				table, column).Scan(&exists); err != nil {
				t.Fatal(err)
			}
			if !exists {
				t.Errorf("deploy/ops-roles.sql grants missing column %s.%s", table, column)
			}
		}
	}
}
