package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// legacyUpload is a finalized legacy Office upload whose conversion job a
// worker claimed (attempt 1).
type legacyUpload struct {
	userID, fileID, jobID, reservationID, uploadedPath string
}

const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// zipBytes is a stand-in converted file of n bytes: the ZIP signature, padded.
func zipBytes(n int) []byte {
	return append([]byte("PK\x03\x04"), bytes.Repeat([]byte("x"), n-4)...)
}

// newLegacyUpload uploads a 100-byte legacy file as a new Free user, into a
// new workspace or (standalone) into none, and claims its conversion job.
func newLegacyUpload(t *testing.T, st *store.Store, name, kind, mode string, standalone bool) legacyUpload {
	t.Helper()
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	up := legacyUpload{userID: "u_legacy_" + suffix, uploadedPath: "sources/legacy-" + suffix + ".bin"}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
		VALUES ($1, 'Legacy', $2, 'free')`, up.userID, up.userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, up.userID)
	})
	wsID := ""
	if !standalone {
		ws, err := st.CreateWorkspace(ctx, up.userID, store.WorkspaceCreate{Name: "Legacy", Tags: nil})
		if err != nil {
			t.Fatal(err)
		}
		wsID = ws.ID
	}
	session, err := st.CreateUploadSession(ctx, store.NewUploadSession{
		ID: "up_legacy_" + suffix, WorkspaceID: wsID, CreatedBy: up.userID,
		ObjectPath: "incoming/up_legacy_" + suffix, FinalPath: up.uploadedPath,
		Name: name, Kind: kind, ContentType: "application/octet-stream",
		DeclaredSize: 100, ParseMode: mode, ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := st.FinalizeUploadSession(ctx, up.userID, session.ID, "etag-uploaded", strings.Repeat("a", 64), "docling")
	if err != nil {
		t.Fatal(err)
	}
	up.fileID = file.ID
	if err := st.Pool().QueryRow(ctx, `UPDATE jobs SET status='running', attempts=1, locked_at=now(),
			lease_expires_at=now()+interval '5 minutes'
		WHERE payload->>'fileId'=$1 RETURNING id, payload->>'reservationId'`, file.ID).
		Scan(&up.jobID, &up.reservationID); err != nil {
		t.Fatal(err)
	}
	return up
}

// request is the hand-over of converted as the job's first attempt, with
// override replacing fields.
func (up legacyUpload) request(convertTo string, converted []byte, override map[string]any) map[string]any {
	sum := sha256.Sum256(converted)
	body := map[string]any{
		"jobId": up.jobID, "attempt": 1, "fileId": up.fileID,
		"incomingKey": "incoming/legacy-convert/" + up.jobID + "." + convertTo,
		"actualSize":  len(converted), "sha256": hex.EncodeToString(sum[:]), "removedPictures": 2,
	}
	for field, value := range override {
		body[field] = value
	}
	return body
}

// handOver puts converted at the job's incoming key as contentType and posts
// its hand-over.
func (up legacyUpload) handOver(t *testing.T, h http.Handler, mem *blob.Memory, convertTo, contentType string, converted []byte, override map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	key := "incoming/legacy-convert/" + up.jobID + "." + convertTo
	if _, err := mem.PutObjectOnce(context.Background(), key, bytes.NewReader(converted), contentType, ""); err != nil {
		t.Fatal(err)
	}
	return doInternal(t, h, http.MethodPost, "/api/internal/files/convert", pipeSecret, up.request(convertTo, converted, override))
}

type convertedFile struct {
	name, blobPath, sha, etag, status string
	size, revision                    int64
}

func readConvertedFile(t *testing.T, st *store.Store, fileID string) convertedFile {
	t.Helper()
	var f convertedFile
	if err := st.Pool().QueryRow(context.Background(), `SELECT name, blob_path, source_sha256, source_etag, status, size_bytes, revision
		FROM files WHERE id=$1`, fileID).Scan(&f.name, &f.blobPath, &f.sha, &f.etag, &f.status, &f.size, &f.revision); err != nil {
		t.Fatal(err)
	}
	return f
}

// A converted legacy file replaces the uploaded bytes under the new ending,
// is charged at its new size, releases the uploaded blob and continues as an
// ordinary parse on the conversion's reservation; the conversion job is done,
// and a repeated hand-over answers the same (Epo 2026-11-11).
func TestLegacyConvertSwapsTheFileAndQueuesItsParse(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	up := newLegacyUpload(t, st, "old report.doc", "doc", "fast", false)
	converted := zipBytes(160) // 60 bytes more than uploaded

	unauthorized := doInternal(t, h, http.MethodPost, "/api/internal/files/convert", "", map[string]any{"jobId": up.jobID})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("hand-over without the secret: status=%d", unauthorized.Code)
	}
	ok := up.handOver(t, h, mem, "docx", docxType, converted, nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("hand-over status=%d body=%s", ok.Code, ok.Body.String())
	}
	var answer struct {
		FileID, Name, Status string
		ParseJobID           *string
	}
	if err := json.Unmarshal(ok.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.FileID != up.fileID || answer.Name != "old report.docx" || answer.Status != "converted" || answer.ParseJobID == nil {
		t.Fatalf("answer = %s", ok.Body.String())
	}

	sum := sha256.Sum256(converted)
	file := readConvertedFile(t, st, up.fileID)
	if file.name != "old report.docx" || file.size != 160 || file.sha != hex.EncodeToString(sum[:]) ||
		file.etag != "mem" || file.revision != 2 || file.status != "pending" ||
		!strings.HasPrefix(file.blobPath, "sources/blob_") || !strings.HasSuffix(file.blobPath, ".docx") {
		t.Fatalf("converted file = %+v", file)
	}
	if stored, _, found := mem.Object(file.blobPath); !found || !bytes.Equal(stored, converted) {
		t.Fatal("the converted bytes are not at the file's blob path")
	}
	// The triggers: the size change charged, the uploaded blob released to
	// the reaper, the new one referenced (which cancels its guard deletion).
	var used int64
	var uploadedQueued, convertedQueued bool
	if err := st.Pool().QueryRow(ctx, `SELECT (SELECT used_bytes FROM user_storage WHERE user_id=$1),
			EXISTS(SELECT 1 FROM pending_blob_deletions WHERE object_path=$2),
			EXISTS(SELECT 1 FROM pending_blob_deletions WHERE object_path=$3)`,
		up.userID, up.uploadedPath, file.blobPath).Scan(&used, &uploadedQueued, &convertedQueued); err != nil {
		t.Fatal(err)
	}
	if used != 160 || !uploadedQueued || convertedQueued {
		t.Fatalf("used=%d uploaded blob queued=%t converted blob queued=%t", used, uploadedQueued, convertedQueued)
	}

	var convertStatus, parseType, parseStatus, route, blobPath, reservation string
	var removed, revision int64
	var hasCap bool
	if err := st.Pool().QueryRow(ctx, `SELECT c.status, (c.payload->>'removedPictures')::bigint, p.type, p.status,
			p.payload->'processingPlan'->>'route', p.payload->>'blobPath', (p.payload->>'sourceRevision')::bigint,
			p.payload->>'reservationId', p.payload ? 'imageMaxBytes'
		FROM jobs c, jobs p WHERE c.id=$1 AND p.id=$2`, up.jobID, *answer.ParseJobID).
		Scan(&convertStatus, &removed, &parseType, &parseStatus, &route, &blobPath, &revision, &reservation, &hasCap); err != nil {
		t.Fatal(err)
	}
	if convertStatus != "done" || removed != 2 {
		t.Fatalf("conversion job: status %q removedPictures %d", convertStatus, removed)
	}
	if parseType != "parse" || parseStatus != "pending" || route != "document_parse" || blobPath != file.blobPath ||
		revision != 2 || reservation != up.reservationID || hasCap {
		t.Fatalf("parse job: type %q status %q route %q blob %q revision %d reservation %q picture cap %t",
			parseType, parseStatus, route, blobPath, revision, reservation, hasCap)
	}

	again := up.handOver(t, h, mem, "docx", docxType, converted, nil)
	if again.Code != http.StatusOK || again.Body.String() != ok.Body.String() {
		t.Fatalf("repeat status=%d body=%s; first=%s", again.Code, again.Body.String(), ok.Body.String())
	}
	if after := readConvertedFile(t, st, up.fileID); after != file {
		t.Fatalf("repeat changed the file: %+v", after)
	}
	// A rename sent with the uploaded ending after the swap is refused.
	stale := "renamed.doc"
	if _, err := st.UpdateFile(ctx, up.userID, up.fileID, store.FilePatch{Name: &stale}); !errors.Is(err, store.ErrFileExtensionChanged) {
		t.Fatalf("rename to the legacy ending = %v, want extension changed", err)
	}
}

// With parsing off the converted file is ready as a new-format upload with
// parsing off is, with no job and its system session closed. A name at the
// 120-character cap loses the end of its stem to the longer ending. A file
// that shrinks takes no storage gate, so a full account's converts too.
func TestLegacyConvertWithParsingOffLeavesTheFileReady(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	up := newLegacyUpload(t, st, strings.Repeat("é", 116)+".xls", "sheet", "none", false)
	if _, err := st.Pool().Exec(ctx, `UPDATE user_storage SET used_bytes=100000000 WHERE user_id=$1`, up.userID); err != nil {
		t.Fatal(err)
	}

	// No content type on the object: only one it carries is checked.
	ok := up.handOver(t, h, mem, "xlsx", "", zipBytes(7), nil)
	if ok.Code != http.StatusOK || !strings.Contains(ok.Body.String(), `"parseJobId":null`) {
		t.Fatalf("hand-over status=%d body=%s", ok.Code, ok.Body.String())
	}
	file := readConvertedFile(t, st, up.fileID)
	if file.name != strings.Repeat("é", 115)+".xlsx" || utf8.RuneCountInString(file.name) != 120 ||
		file.status != "ready" || file.size != 7 || file.revision != 2 {
		t.Fatalf("converted file = %+v", file)
	}
	var session string
	var queued int
	if err := st.Pool().QueryRow(ctx, `SELECT (SELECT status FROM provider_sessions WHERE id=$1),
			(SELECT count(*) FROM jobs WHERE payload->>'fileId'=$2 AND status IN ('pending','running'))`,
		up.reservationID, up.fileID).Scan(&session, &queued); err != nil {
		t.Fatal(err)
	}
	if session != "settled" || queued != 0 {
		t.Fatalf("session %q, jobs queued %d", session, queued)
	}
}

// A file outside any workspace converts the same way, for its owner alone.
func TestLegacyConvertOfAStandaloneFile(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	up := newLegacyUpload(t, st, "essay.doc", "doc", "fast", true)
	ok := up.handOver(t, h, mem, "docx", docxType, zipBytes(120), nil)
	if ok.Code != http.StatusOK || strings.Contains(ok.Body.String(), `"parseJobId":null`) {
		t.Fatalf("hand-over status=%d body=%s", ok.Code, ok.Body.String())
	}
	if file := readConvertedFile(t, st, up.fileID); file.name != "essay.docx" || file.status != "pending" || file.revision != 2 {
		t.Fatalf("converted file = %+v", file)
	}
}

// A hand-over that is not the job's live attempt, or whose file was trashed
// or moved to another revision, is a lost claim; a missing object is a fault
// to retry; one that does not match its job and bytes, is no OOXML file, is
// over the per-file cap or grows a full account is refused for good. The file
// keeps its uploaded name and bytes.
func TestLegacyConvertRefusals(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := st.Pool().Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	converted := zipBytes(101) // one byte more than uploaded: takes the storage gate
	for _, tc := range []struct {
		name        string
		setup       func(up legacyUpload)
		override    func(up legacyUpload) map[string]any
		converted   []byte
		contentType string
		missing     bool
		status      int
		code        string
	}{
		{name: "superseded attempt", override: func(legacyUpload) map[string]any { return map[string]any{"attempt": 2} },
			status: http.StatusConflict, code: "convert_claim_lost"},
		{name: "trashed file", setup: func(up legacyUpload) {
			if _, err := st.TrashFile(ctx, up.userID, up.fileID, store.AgentOperation{}); err != nil {
				t.Fatal(err)
			}
		}, status: http.StatusConflict, code: "convert_claim_lost"},
		{name: "revision moved", setup: func(up legacyUpload) { exec(`UPDATE files SET revision=revision+1 WHERE id=$1`, up.fileID) },
			status: http.StatusConflict, code: "convert_claim_lost"},
		{name: "missing object", missing: true, status: http.StatusServiceUnavailable, code: "object_unavailable"},
		{name: "not a conversion job", setup: func(up legacyUpload) {
			exec(`UPDATE jobs SET payload=jsonb_set(payload,'{processingPlan,route}','"document_parse"') WHERE id=$1`, up.jobID)
		}, status: http.StatusUnprocessableEntity, code: "convert_invalid"},
		{name: "wrong key", override: func(up legacyUpload) map[string]any {
			return map[string]any{"incomingKey": "incoming/legacy-convert/" + up.jobID + ".xlsx"}
		}, status: http.StatusUnprocessableEntity, code: "convert_invalid"},
		{name: "wrong hash", override: func(legacyUpload) map[string]any { return map[string]any{"sha256": strings.Repeat("b", 64)} },
			status: http.StatusUnprocessableEntity, code: "convert_invalid"},
		{name: "not a ZIP", converted: bytes.Repeat([]byte("x"), 101),
			status: http.StatusUnprocessableEntity, code: "convert_invalid"},
		{name: "wrong content type", contentType: "application/msword",
			status: http.StatusUnprocessableEntity, code: "convert_invalid"},
		{name: "over the file cap", override: func(legacyUpload) map[string]any { return map[string]any{"actualSize": 10<<20 + 1} },
			status: http.StatusRequestEntityTooLarge, code: "file_too_large"},
		{name: "storage full", setup: func(up legacyUpload) {
			exec(`UPDATE user_storage SET used_bytes=100000000 WHERE user_id=$1`, up.userID)
		}, status: http.StatusUnprocessableEntity, code: "storage_quota_exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			up := newLegacyUpload(t, st, "old report.doc", "doc", "fast", false)
			if tc.setup != nil {
				tc.setup(up)
			}
			var override map[string]any
			if tc.override != nil {
				override = tc.override(up)
			}
			body, contentType := converted, docxType
			if tc.converted != nil {
				body = tc.converted
			}
			if tc.contentType != "" {
				contentType = tc.contentType
			}
			var rec *httptest.ResponseRecorder
			if tc.missing {
				rec = doInternal(t, h, http.MethodPost, "/api/internal/files/convert", pipeSecret, up.request("docx", body, nil))
			} else {
				rec = up.handOver(t, h, mem, "docx", contentType, body, override)
			}
			if rec.Code != tc.status || !strings.Contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("status=%d body=%s, want %d %s", rec.Code, rec.Body.String(), tc.status, tc.code)
			}
			if file := readConvertedFile(t, st, up.fileID); file.name != "old report.doc" || file.blobPath != up.uploadedPath {
				t.Fatalf("refused hand-over changed the file: %+v", file)
			}
		})
	}
}
