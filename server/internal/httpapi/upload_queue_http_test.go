package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
)

// fillUploadSlots takes the 32 tickets the gateway runs at once (Epo
// 2026-10-22); each turn holds its slot until it is used or passes. It
// returns the tickets and the metadata each was issued for.
func fillUploadSlots(t *testing.T, th thumbnailHarness, ws string) (tickets []string, metas []map[string]any) {
	t.Helper()
	for range 32 {
		ticket, meta := waitingTicket(t, th, ws, 0)
		tickets, metas = append(tickets, ticket), append(metas, meta)
	}
	return tickets, metas
}

// pdfMeta is an 8-byte PDF's metadata in a batch of its own (uploadPDF).
func pdfMeta() map[string]any { return sourceMeta("notes.pdf", "application/pdf", 8) }

func batchOf(meta map[string]any) string { return meta["batchId"].(string) }

// waitingTicket takes u_owner's ticket for a pdfMeta and checks its place; it
// returns the ticket and its metadata.
func waitingTicket(t *testing.T, th thumbnailHarness, ws string, position int) (string, map[string]any) {
	t.Helper()
	meta := pdfMeta()
	rec, turn := takeTicket(t, th.h, sourceUploads(ws), "u_owner", meta)
	if rec.Code != http.StatusCreated || turn.Position != position {
		t.Fatalf("ticket at %d: %d %s", position, rec.Code, rec.Body.String())
	}
	return turn.TicketID, meta
}

// batchNotified is whether a batch has settled every file and notified.
func batchNotified(t *testing.T, th thumbnailHarness, batch string) bool {
	t.Helper()
	var notified bool
	if err := th.st.Pool().QueryRow(context.Background(),
		`SELECT notified_at IS NOT NULL FROM source_batches WHERE id=$1`, batch).Scan(&notified); err != nil {
		t.Fatal(err)
	}
	return notified
}

// pollTicket long-polls a ticket from the place last seen.
func pollTicket(t *testing.T, th thumbnailHarness, id string, position int) *httptest.ResponseRecorder {
	return doReq(t, th.h, http.MethodGet, fmt.Sprintf("/api/uploads/tickets/%s?position=%d", id, position), "u_owner", nil)
}

func polledTurn(t *testing.T, rec *httptest.ResponseRecorder) ticketTurn {
	t.Helper()
	expectStatus(t, rec, http.StatusOK, "ticket poll")
	var turn ticketTurn
	if err := json.Unmarshal(rec.Body.Bytes(), &turn); err != nil {
		t.Fatal(err)
	}
	return turn
}

// uploadPDF uploads the 8-byte PDF meta names with ticket.
func uploadPDF(t *testing.T, th thumbnailHarness, ws, ticket string, meta map[string]any) (*httptest.ResponseRecorder, *countedBody) {
	t.Helper()
	body := []byte("%PDF-1.7")
	return postForm(t, th.h, sourceUploads(ws)+"?ticket="+ticket, "u_owner",
		metadataPart(t, meta), formPart{name: "file", contentType: "application/pdf", body: body})
}

// Past 32 uploads at once, the next ticket waits in line; its upload is
// refused unread until its turn, and its poll answers as soon as a finished
// upload frees a slot (Epo 2026-10-22).
func TestUploadQueueRunsThirtyTwoAndQueuesTheRest(t *testing.T) {
	httpapi.SetUploadQueueTimings(t, 30*time.Second, 5*time.Minute, 10*time.Second)
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	running, metas := fillUploadSlots(t, th, ws)
	waitingMeta := pdfMeta()
	rec, waiting := takeTicket(t, th.h, sourceUploads(ws), "u_owner", waitingMeta)
	if rec.Code != http.StatusCreated || waiting.Position != 1 {
		t.Fatalf("33rd ticket: %d %s", rec.Code, rec.Body.String())
	}
	early, read := uploadPDF(t, th, ws, waiting.TicketID, waitingMeta)
	if early.Code != http.StatusConflict || read.read != 0 {
		t.Fatalf("an upload before its turn: %d, read %d bytes", early.Code, read.read)
	}
	polled := make(chan *httptest.ResponseRecorder, 1)
	asked := time.Now()
	go func() { polled <- pollTicket(t, th, waiting.TicketID, 1) }()
	done, _ := uploadPDF(t, th, ws, running[0], metas[0])
	expectStatus(t, done, http.StatusCreated, "an upload with its turn")
	if turn := polledTurn(t, <-polled); turn.Position != 0 || time.Since(asked) > 5*time.Second {
		t.Fatalf("the poll answered %+v after %v", turn, time.Since(asked))
	}
	next, _ := uploadPDF(t, th, ws, waiting.TicketID, waitingMeta)
	expectStatus(t, next, http.StatusCreated, "the 33rd upload")
}

// A full line refuses the ticket as busy: a user holds at most 20 waiting
// tickets (the line's 128 are in TestUploadQueueHoldsAtMost128And20PerUser).
func TestUploadQueueRefusesAFullLine(t *testing.T) {
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	_, _ = fillUploadSlots(t, th, ws)
	for i := 1; i <= 20; i++ {
		rec, turn := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
		if rec.Code != http.StatusCreated || turn.Position != i {
			t.Fatalf("waiting ticket %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	rec, _ := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
	if rec.Code != http.StatusServiceUnavailable || errorCode(t, rec) != "upload_queue_full" {
		t.Fatalf("21st waiting ticket: %d %s", rec.Code, rec.Body.String())
	}
}

// A turn its upload does not take in time passes to the next ticket, the
// passed ticket's batch settles it as failed at once, and its upload is
// refused unread (Epo 2026-10-22).
func TestUploadTurnPassesOnWhenUnused(t *testing.T) {
	// Long enough for the 33 tickets to be taken before the first turn passes.
	httpapi.SetUploadQueueTimings(t, 2*time.Second, 5*time.Minute, 5*time.Second)
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	unused, metas := fillUploadSlots(t, th, ws)
	waitingMeta := pdfMeta()
	_, waiting := takeTicket(t, th.h, sourceUploads(ws), "u_owner", waitingMeta)
	if waiting.Position != 1 {
		t.Fatalf("33rd ticket waits at %d", waiting.Position)
	}
	if turn := polledTurn(t, pollTicket(t, th, waiting.TicketID, 1)); turn.Position != 0 {
		t.Fatalf("the waiting ticket is at %d after the turns passed", turn.Position)
	}
	// The pass settles the batch right after it frees the slot.
	deadline := time.Now().Add(2 * time.Second)
	for !batchNotified(t, th, batchOf(metas[0])) {
		if time.Now().After(deadline) {
			t.Fatal("the passed ticket's batch did not settle")
		}
		time.Sleep(20 * time.Millisecond)
	}
	late, read := uploadPDF(t, th, ws, unused[0], metas[0])
	if late.Code != http.StatusGone || read.read != 0 {
		t.Fatalf("an upload after its turn passed: %d, read %d bytes", late.Code, read.read)
	}
	next, _ := uploadPDF(t, th, ws, waiting.TicketID, waitingMeta)
	expectStatus(t, next, http.StatusCreated, "the upload the turn passed to")
}

// An upload without a ticket, with a ticket for another route or another
// user, or with one already spent is refused before the gateway reads its
// body; a ticket shown on the wrong route still serves its own (security
// regression: human backend-storage-quota 2026-10-22 upload queue).
func TestUploadsRefuseABadTicketUnread(t *testing.T) {
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	note := uploadNote(t, th, ws)
	sourcesMeta := pdfMeta()
	_, sources := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourcesMeta)
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	assetParts := []formPart{
		metadataPart(t, map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": len(png), "contentType": "image/png"}),
		{name: "file", contentType: "image/png", body: png},
	}
	for what, ticket := range map[string]string{"no ticket": "", "an unknown ticket": "utk_unknown"} {
		rec, read := uploadPDF(t, th, ws, ticket, pdfMeta())
		if rec.Code != http.StatusGone || errorCode(t, rec) != "upload_ticket_gone" || read.read != 0 {
			t.Fatalf("an upload with %s: %d %s, read %d bytes", what, rec.Code, rec.Body.String(), read.read)
		}
	}
	rec, read := postForm(t, th.h, "/api/materials/"+note+"/editor-assets/uploads?ticket="+sources.TicketID, "u_owner", assetParts...)
	if rec.Code != http.StatusGone || read.read != 0 {
		t.Fatalf("an editor asset with a source ticket: %d, read %d bytes", rec.Code, read.read)
	}
	// u_editor edits ws_e2e_private too, but cannot spend u_owner's ticket.
	_, owners := takeTicket(t, th.h, sourceUploads("ws_e2e_private"), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
	rec, read = postForm(t, th.h, sourceUploads("ws_e2e_private")+"?ticket="+owners.TicketID, "u_editor",
		metadataPart(t, sourceMeta("notes.pdf", "application/pdf", 8)),
		formPart{name: "file", contentType: "application/pdf", body: []byte("%PDF-1.7")})
	if rec.Code != http.StatusGone || read.read != 0 {
		t.Fatalf("a co-editor with another's ticket: %d, read %d bytes", rec.Code, read.read)
	}
	spent, _ := uploadPDF(t, th, ws, sources.TicketID, sourcesMeta)
	expectStatus(t, spent, http.StatusCreated, "the source upload with its own ticket")
	rec, read = uploadPDF(t, th, ws, sources.TicketID, sourcesMeta)
	if rec.Code != http.StatusGone || read.read != 0 {
		t.Fatalf("an upload with a spent ticket: %d, read %d bytes", rec.Code, read.read)
	}
}

// An upload whose body is still arriving past its deadline (5 minutes, Epo
// 2026-10-22) is cut off with 408 and its reservation released; this runs on
// a real server, whose connection takes the deadline.
func TestUploadBodyIsCutOffAfterItsDeadline(t *testing.T) {
	httpapi.SetUploadQueueTimings(t, 30*time.Second, 300*time.Millisecond, 25*time.Second)
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	server := httptest.NewServer(th.h)
	t.Cleanup(server.Close)
	meta := sourceMeta("slow.pdf", "application/pdf", 1<<20)
	route := ticketed(t, th.h, sourceUploads(ws), "u_owner", meta)

	body, sending := io.Pipe()
	t.Cleanup(func() { _ = sending.Close() })
	form := multipart.NewWriter(sending)
	go func() {
		metadata, _ := json.Marshal(meta)
		part, _ := form.CreatePart(textproto.MIMEHeader{"Content-Disposition": {`form-data; name="metadata"`}})
		_, _ = part.Write(metadata)
		part, _ = form.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="file"; filename="upload"`},
			"Content-Type":        {"application/pdf"},
		})
		// A first slice of the file, then nothing: the browser stalls.
		_, _ = part.Write(bytes.Repeat([]byte{'a'}, 4096))
	}()
	req, err := http.NewRequest(http.MethodPost, server.URL+route, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set(auth.HeaderE2EUserID, "u_owner")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	// Without the deadline nothing answers; the client gives up once the test
	// ends the body.
	giveUp := time.AfterFunc(5*time.Second, func() { _ = sending.CloseWithError(errors.New("no answer")) })
	defer giveUp.Stop()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("the stalled upload got no answer: %v", err)
	}
	var answer struct {
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	_ = json.NewDecoder(res.Body).Decode(&answer)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusRequestTimeout || len(answer.Errors) != 1 || answer.Errors[0].Message != "upload_timeout" {
		t.Fatalf("the stalled upload = %d %+v, want 408 upload_timeout", res.StatusCode, answer)
	}
	if held, keys := leftovers(t, th, bucket, ws); held != 0 || len(keys) != 0 {
		t.Fatalf("the cut-off upload left %d held sessions and objects %q", held, keys)
	}
}

// A cancelled ticket gives up its place in line, or its turn's slot, to the
// next ticket at once, and leaves its batch to the retry that cancelled it;
// only its owner can cancel or poll it (Epo 2026-10-22; security regression:
// human backend-storage-quota 2026-10-22 upload queue).
func TestUploadTicketCancelGivesUpItsPlace(t *testing.T) {
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	running, metas := fillUploadSlots(t, th, ws)
	first, firstMeta := waitingTicket(t, th, ws, 1)
	second, _ := waitingTicket(t, th, ws, 2)
	cancel := func(user, ticket string) int {
		return doReq(t, th.h, http.MethodDelete, "/api/uploads/tickets/"+ticket, user, nil).Code
	}
	if status := cancel("u_other", first); status != http.StatusGone {
		t.Fatalf("another user's cancel = %d, want 410", status)
	}
	if poll := doReq(t, th.h, http.MethodGet, "/api/uploads/tickets/"+first, "u_other", nil); poll.Code != http.StatusGone {
		t.Fatalf("another user's poll = %d, want 410", poll.Code)
	}
	if status := cancel("u_owner", first); status != http.StatusNoContent || batchNotified(t, th, batchOf(firstMeta)) {
		t.Fatalf("cancel of a waiting ticket = %d (its batch must wait for the retry)", status)
	}
	if turn := polledTurn(t, pollTicket(t, th, second, -1)); turn.Position != 1 {
		t.Fatalf("after the cancel the next ticket waits at %d", turn.Position)
	}
	if status := cancel("u_owner", running[0]); status != http.StatusNoContent || batchNotified(t, th, batchOf(metas[0])) {
		t.Fatalf("cancel of a turn = %d", status)
	}
	if turn := polledTurn(t, pollTicket(t, th, second, -1)); turn.Position != 0 {
		t.Fatalf("after the cancelled turn the next ticket waits at %d", turn.Position)
	}
	rec, read := uploadPDF(t, th, ws, running[0], metas[0])
	if rec.Code != http.StatusGone || read.read != 0 {
		t.Fatalf("an upload with a cancelled ticket: %d, read %d bytes", rec.Code, read.read)
	}
}

// An upload must name what its ticket was issued for: a ticket taken for a
// small PDF does not admit a bigger file, another type, another name or
// another batch, and the refusal holds nothing and settles the ticket's batch
// (security regression: human backend-storage-quota 2026-10-22 upload queue).
func TestUploadMustMatchItsTicket(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	note := uploadNote(t, th, ws)
	for what, change := range map[string]func(map[string]any) []byte{
		"a bigger size": func(m map[string]any) []byte { m["sizeBytes"] = 64; return bytes.Repeat([]byte{'a'}, 64) },
		"another type": func(m map[string]any) []byte {
			m["name"], m["contentType"] = "notes.png", "image/png"
			return []byte("%PDF-1.")
		},
		"another name":  func(m map[string]any) []byte { m["name"] = "other.pdf"; return []byte("%PDF-1.") },
		"another batch": func(m map[string]any) []byte { m["batchId"] = "sb_other"; return []byte("%PDF-1.") },
	} {
		meta := sourceMeta("notes.pdf", "application/pdf", 7)
		route := ticketed(t, th.h, sourceUploads(ws), "u_owner", meta)
		upload := maps.Clone(meta)
		body := change(upload)
		rec, _ := postForm(t, th.h, route, "u_owner", metadataPart(t, upload),
			formPart{name: "file", contentType: upload["contentType"].(string), body: body})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("an upload with %s than its ticket: %d %s", what, rec.Code, rec.Body.String())
		}
		if !batchNotified(t, th, batchOf(meta)) {
			t.Fatalf("the ticket of an upload with %s left its batch open", what)
		}
	}
	png := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, bytes.Repeat([]byte{7}, 100)...)
	asset := map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": len(png) - 50, "contentType": "image/png"}
	path := "/api/materials/" + note + "/editor-assets/uploads"
	route := ticketed(t, th.h, path, "u_owner", asset)
	bigger := maps.Clone(asset)
	bigger["sizeBytes"] = len(png)
	rec, _ := postForm(t, th.h, route, "u_owner", metadataPart(t, bigger), formPart{name: "file", contentType: "image/png", body: png})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an editor asset bigger than its ticket: %d %s", rec.Code, rec.Body.String())
	}
	var assets int
	if err := th.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM editor_assets WHERE material_id=$1`, note).
		Scan(&assets); err != nil {
		t.Fatal(err)
	}
	if held, keys := leftovers(t, th, bucket, ws); held != 0 || assets != 0 || len(keys) != 0 {
		t.Fatalf("mismatched uploads left %d held sessions, %d assets and objects %q", held, assets, keys)
	}
}

// A ticket request whose JSON body is still arriving past its bound (10 s,
// shortened here) is cut off with 408, on a real server.
func TestUploadTicketBodyIsCutOffAfterItsBound(t *testing.T) {
	httpapi.SetUploadTicketReadBound(t, 300*time.Millisecond)
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	server := httptest.NewServer(th.h)
	t.Cleanup(server.Close)
	body, sending := io.Pipe()
	t.Cleanup(func() { _ = sending.Close() })
	go func() { _, _ = sending.Write([]byte(`{"name":"notes.pdf",`)) }()
	req, err := http.NewRequest(http.MethodPost, server.URL+sourceUploads(ws)+"/tickets", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderE2EUserID, "u_owner")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	giveUp := time.AfterFunc(5*time.Second, func() { _ = sending.CloseWithError(errors.New("no answer")) })
	defer giveUp.Stop()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("the stalled ticket request got no answer: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("the stalled ticket request = %d, want 408", res.StatusCode)
	}
}
