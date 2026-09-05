package httpapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/store"
	"github.com/evonotes/server/internal/testdb"
)

func TestCompletedSourceImportReplaysBeforeMutableAdmission(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)

	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	actor := "u_import_replay_" + suffix
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email,plan_tier)
		VALUES ($1,'Import Replay',$2,'free')`, actor, actor+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, actor)
	})
	workspace, err := st.CreateWorkspace(ctx, actor, "Import replay", store.ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	chapter, err := st.AddChapter(ctx, workspace.ID, actor, "Selected")
	if err != nil {
		t.Fatal(err)
	}

	fileIDs := []string{"provider-a", "provider-b"}
	limit := mustPlanLimits(t, st, store.PlanFree).FilesPerWorkspace
	if _, err := st.Pool().Exec(ctx, `INSERT INTO files
		(id,workspace_id,user_id,created_by,name,kind,size_bytes,status,parse_mode)
		SELECT $1 || n::text,$2,$3,$3,'existing-' || n::text || '.txt','txt',0,'ready','none'
		FROM generate_series(1,$4) AS n`, "f_import_replay_"+suffix+"_",
		workspace.ID, actor, limit-len(fileIDs)); err != nil {
		t.Fatal(err)
	}

	requestID := "ireq_replay_" + suffix
	refs, err := integrations.ZipImportDriveIDs(fileIDs, nil)
	if err != nil {
		t.Fatal(err)
	}
	fingerprintBody, err := json.Marshal(struct {
		CaptionImages bool
		ChapterID     *string
		ChapterName   string
		ParseMode     string
		Provider      string
		Refs          []integrations.ImportRef
	}{
		ChapterID: &chapter.ID,
		ParseMode: "none",
		Provider:  integrations.ProviderGoogle,
		Refs:      refs,
	})
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(fingerprintBody))
	if _, complete, err := st.BeginSourceImportRequest(
		ctx, actor, workspace.ID, requestID, fingerprint,
	); err != nil || complete {
		t.Fatalf("begin complete=%v err=%v", complete, err)
	}

	imports := make([]store.NewSourceImport, 0, len(fileIDs))
	jobs := make([]apimodel.SourceImportAccepted, 0, len(fileIDs))
	for index, providerFileID := range fileIDs {
		uploadID := fmt.Sprintf("up_replay_%s_%d", suffix, index)
		jobID := fmt.Sprintf("imp_replay_%s_%d", suffix, index)
		name := fmt.Sprintf("imported-%d.txt", index)
		imports = append(imports, store.NewSourceImport{
			JobID: jobID,
			Upload: store.NewUploadSession{
				ID: uploadID, WorkspaceID: workspace.ID, CreatedBy: actor,
				ChapterID:  &chapter.ID,
				ObjectPath: "incoming/" + uploadID + "/file.txt",
				FinalPath:  "sources/" + uploadID + ".txt",
				Name:       name, Kind: "txt", ContentType: "text/plain",
				DeclaredSize: 1, ParseMode: "none",
				ExpiresAt: time.Now().UTC().Add(time.Hour),
			},
			Provider: integrations.ProviderGoogle, ProviderFileID: providerFileID,
			MaxBytes: 1024, IdempotencyKey: fmt.Sprintf("%s:%d", requestID, index),
		})
		jobs = append(jobs, apimodel.SourceImportAccepted{
			JobID: jobID, UploadID: uploadID, Name: name,
		})
	}
	want := apimodel.ImportSourcesAccepted{
		Jobs: jobs, Rejected: []apimodel.SourceImportRejected{},
	}
	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateSourceImportsAndCompleteRequest(
		ctx, actor, workspace.ID, requestID, fingerprint, imports, encoded,
	); err != nil {
		t.Fatal(err)
	}
	if err := st.AssertWorkspaceFileRoom(ctx, workspace.ID, len(fileIDs)); err == nil {
		t.Fatal("setup did not make current file-room admission reject the original batch")
	}

	body := map[string]any{
		"provider":  integrations.ProviderGoogle,
		"fileIds":   fileIDs,
		"chapterId": chapter.ID,
		"parseMode": "none",
		"requestId": requestID,
	}
	configured := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", "evo", httpapi.Config{
		AuthDisabled: true, DevUserID: actor,
		PipelineSecret: "test-pipeline-secret",
	})
	first := doReq(t, configured, http.MethodPost,
		"/api/workspaces/"+workspace.ID+"/sources/import", "", body)
	if first.Code != http.StatusAccepted {
		t.Fatalf("full-room replay status=%d body=%s", first.Code, first.Body.String())
	}
	var got apimodel.ImportSourcesAccepted
	if err := json.Unmarshal(first.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("full-room replay body=%#v want=%#v", got, want)
	}

	if err := st.DeleteChapter(ctx, actor, chapter.ID); err != nil {
		t.Fatal(err)
	}
	withoutChapter := doReq(t, configured, http.MethodPost,
		"/api/workspaces/"+workspace.ID+"/sources/import", "", body)
	if withoutChapter.Code != http.StatusAccepted ||
		withoutChapter.Body.String() != first.Body.String() {
		t.Fatalf("deleted-chapter replay status=%d body=%s want=%s",
			withoutChapter.Code, withoutChapter.Body.String(), first.Body.String())
	}

	unavailable := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", "evo", httpapi.Config{
		AuthDisabled: true, DevUserID: actor,
	})
	withoutRelay := doReq(t, unavailable, http.MethodPost,
		"/api/workspaces/"+workspace.ID+"/sources/import", "", body)
	if withoutRelay.Code != http.StatusAccepted ||
		withoutRelay.Body.String() != first.Body.String() {
		t.Fatalf("relay-unavailable replay status=%d body=%s want=%s",
			withoutRelay.Code, withoutRelay.Body.String(), first.Body.String())
	}
	body["parseMode"] = "fast"
	conflict := doReq(t, unavailable, http.MethodPost,
		"/api/workspaces/"+workspace.ID+"/sources/import", "", body)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("changed replay status=%d body=%s", conflict.Code, conflict.Body.String())
	}
}
