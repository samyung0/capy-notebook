package httpapi

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestReportEditIncidentStoresTheCallersRow(t *testing.T) {
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

	size := int64(4096)
	a := &api{s: st}
	in := &editIncidentInput{Body: apimodel.ReportEditIncidentReq{
		FileID: "f_report", FileKind: "source_file", Kind: "draft_storage_failed",
		Reason: "quota", SizeBytes: &size,
	}}
	if _, err := a.reportEditIncident(auth.WithUserID(ctx, userID), in); err != nil {
		t.Fatal(err)
	}

	var fileID, fileKind, kind, reason string
	var stored int64
	if err := st.Pool().QueryRow(ctx, `SELECT file_id, file_kind, kind, reason, size_bytes
		FROM edit_incidents WHERE user_id=$1`, userID).
		Scan(&fileID, &fileKind, &kind, &reason, &stored); err != nil {
		t.Fatal(err)
	}
	if fileID != "f_report" || fileKind != "source_file" || kind != "draft_storage_failed" ||
		reason != "quota" || stored != size {
		t.Fatalf("row = %s %s %s %s %d", fileID, fileKind, kind, reason, stored)
	}
}
