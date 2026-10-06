package httpapi

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// The row is the authenticated caller's: the body names no user.
func TestReportEditIncidentIsTheCallers(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	userID := "u_edit_incident_report"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email)
		VALUES ($1,'Edit Incident Test',$2)`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})

	a := &api{s: st}
	in := &editIncidentInput{Body: apimodel.ReportEditIncidentReq{
		FileID: "f_report", FileKind: "source_file", Kind: "draft_storage_failed", Reason: "quota",
	}}
	if _, err := a.reportEditIncident(auth.WithUserID(ctx, userID), in); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := st.Pool().QueryRow(ctx, `SELECT count(*) FROM edit_incidents
		WHERE user_id=$1 AND file_id='f_report' AND kind='draft_storage_failed'`, userID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("caller's rows = %d, want 1", rows)
	}
}
