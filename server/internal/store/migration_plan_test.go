package store

import (
	"testing"
	"testing/fstest"
)

func TestMigrationPlanBaseline(t *testing.T) {
	fsys := fstest.MapFS{
		"0001_init.sql": {Data: []byte("one")}, "0002_change.sql": {Data: []byte("two")},
		"0003_change.sql": {Data: []byte("three")}, "B0001_snapshot.sql": {Data: []byte("base-one")}, "B0002_snapshot.sql": {Data: []byte("base-two")},
	}
	cases := []struct {
		name    string
		applied map[string]string
		states  map[string]string
		empty   bool
	}{
		{"fresh", nil, map[string]string{"B0001_snapshot.sql": "ignored-baseline", "B0002_snapshot.sql": "pending", "0001_init.sql": "covered-by-baseline", "0002_change.sql": "covered-by-baseline", "0003_change.sql": "pending"}, true},
		{"existing", map[string]string{"0001_init.sql": checksumSQL([]byte("one"))}, map[string]string{"B0002_snapshot.sql": "ignored-baseline", "0001_init.sql": "applied", "0002_change.sql": "pending"}, false},
		{"baseline", map[string]string{"B0002_snapshot.sql": checksumSQL([]byte("base-two"))}, map[string]string{"B0002_snapshot.sql": "applied", "0001_init.sql": "covered-by-baseline", "0003_change.sql": "pending"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := planMigrations(fsys, tc.applied)
			if err != nil {
				t.Fatal(err)
			}
			if plan.needsEmpty != tc.empty {
				t.Fatalf("empty guard=%v", plan.needsEmpty)
			}
			for _, status := range plan.status {
				if want, ok := tc.states[status.Filename]; ok && want != status.State {
					t.Errorf("%s: got %s want %s", status.Filename, status.State, want)
				}
			}
		})
	}
}

func TestMigrationPlanRejectsInvalidHistory(t *testing.T) {
	cases := []struct {
		name    string
		files   fstest.MapFS
		applied map[string]string
	}{
		{"fresh gap", fstest.MapFS{"0001_a.sql": {}, "0003_c.sql": {}}, nil},
		{"upgrade gap", fstest.MapFS{"0001_a.sql": {}, "0003_c.sql": {}}, map[string]string{"0001_a.sql": checksumSQL(nil)}},
		{"fresh baseline gap", fstest.MapFS{"B0002_base.sql": {}, "0004_d.sql": {}}, nil},
		{"applied baseline gap", fstest.MapFS{"B0002_base.sql": {}, "0004_d.sql": {}}, map[string]string{"B0002_base.sql": checksumSQL(nil)}},
		{"zero ledger forward", fstest.MapFS{"0001_a.sql": {}}, map[string]string{"0000_old.sql": checksumSQL(nil)}},
		{"zero ledger baseline", fstest.MapFS{"0001_a.sql": {}}, map[string]string{"B0000_old.sql": checksumSQL(nil)}},
		{"duplicate", fstest.MapFS{"0001_a.sql": {}, "0001_b.sql": {}}, nil},
		{"duplicate baseline", fstest.MapFS{"B0001_a.sql": {}, "B0001_b.sql": {}}, nil},
		{"malformed", fstest.MapFS{"001_a.sql": {}}, nil},
		{"malformed baseline", fstest.MapFS{"B0001.sql": {}}, nil},
		{"wild baseline", fstest.MapFS{"b0001_a.sql": {}}, nil},
		{"checksum preflight", fstest.MapFS{"0001_a.sql": {}, "0002_b.sql": {}}, map[string]string{"0002_b.sql": "edited"}},
		{"missing baseline", fstest.MapFS{"0001_a.sql": {}}, map[string]string{"B0001_a.sql": checksumSQL(nil)}},
		{"baseline checksum", fstest.MapFS{"B0001_a.sql": {}}, map[string]string{"B0001_a.sql": "edited"}},
		{"covered recorded checksum", fstest.MapFS{"0001_a.sql": {}, "B0001_a.sql": {}}, map[string]string{"B0001_a.sql": checksumSQL(nil), "0001_a.sql": "edited"}},
		{"multiple applied baselines", fstest.MapFS{"B0001_a.sql": {}, "B0002_b.sql": {}}, map[string]string{"B0001_a.sql": checksumSQL(nil), "B0002_b.sql": checksumSQL(nil)}},
		{"gap", fstest.MapFS{"0001_a.sql": {}, "0003_c.sql": {}}, map[string]string{"0001_a.sql": checksumSQL(nil), "0003_c.sql": checksumSQL(nil)}},
		{"unapplied old file", fstest.MapFS{"0001_a.sql": {}, "0002_b.sql": {}}, map[string]string{"0002_b.sql": checksumSQL(nil)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := planMigrations(tc.files, tc.applied); err == nil {
				t.Fatal("expected history rejection")
			}
		})
	}
}

func TestMigrationPlanOlderBinary(t *testing.T) {
	fsys := fstest.MapFS{"0001_a.sql": {}}
	plan, err := planMigrations(fsys, map[string]string{"0001_a.sql": checksumSQL(nil), "0002_newer.sql": "not in this binary"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.status[0].State != "applied" {
		t.Fatal(plan.status)
	}
}
