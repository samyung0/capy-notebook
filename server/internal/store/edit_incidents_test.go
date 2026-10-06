package store

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestEditIncidentsRecordAndPrune(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := uid("u_incident")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1, 'Incident Test', $2)`, userID, fmt.Sprintf("%s@example.test", userID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})

	size := int64(2048)
	if err := s.RecordEditIncident(ctx, userID, EditIncident{
		FileID: "f_incident", FileKind: "source_file", Kind: "offline_episode",
		Reason: "unreachable", SizeBytes: &size,
	}); err != nil {
		t.Fatal(err)
	}
	// Reason and size are optional; an empty reason is stored as NULL.
	if err := s.RecordEditIncident(ctx, userID, EditIncident{
		FileID: "m_incident", FileKind: "material", Kind: "unconfirmed_edit",
	}); err != nil {
		t.Fatal(err)
	}
	// The table refuses a kind outside its list.
	if err := s.RecordEditIncident(ctx, userID, EditIncident{
		FileID: "f_incident", FileKind: "source_file", Kind: "anything",
	}); err == nil {
		t.Fatal("unknown kind was stored")
	}

	var rows int
	var reason *string
	var bytes *int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM edit_incidents WHERE user_id=$1`,
		userID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("rows = %d, want 2", rows)
	}
	if err := s.pool.QueryRow(ctx, `SELECT reason, size_bytes FROM edit_incidents
		WHERE user_id=$1 AND kind='unconfirmed_edit'`, userID).Scan(&reason, &bytes); err != nil {
		t.Fatal(err)
	}
	if reason != nil || bytes != nil {
		t.Fatalf("reason=%v size=%v, want both NULL", reason, bytes)
	}

	// Rows older than 90 days go; younger ones stay.
	if _, err := s.pool.Exec(ctx, `UPDATE edit_incidents SET created_at = now() - interval '91 days'
		WHERE user_id=$1 AND kind='offline_episode'`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE edit_incidents SET created_at = now() - interval '89 days'
		WHERE user_id=$1 AND kind='unconfirmed_edit'`, userID); err != nil {
		t.Fatal(err)
	}
	if err := s.PruneEditIncidents(ctx); err != nil {
		t.Fatal(err)
	}
	result, err := s.pool.Query(ctx, `SELECT kind FROM edit_incidents WHERE user_id=$1`, userID)
	if err != nil {
		t.Fatal(err)
	}
	kinds, err := pgx.CollectRows(result, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if len(kinds) != 1 || kinds[0] != "unconfirmed_edit" {
		t.Fatalf("kinds after prune = %v, want [unconfirmed_edit]", kinds)
	}
}
