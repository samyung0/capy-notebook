package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
// returns the tickets and their batches.
func fillUploadSlots(t *testing.T, th thumbnailHarness, ws string) (tickets, batches []string) {
	t.Helper()
	for range 32 {
		ticket, batch := waitingTicket(t, th, ws, 0)
		tickets, batches = append(tickets, ticket), append(batches, batch)
	}
	return tickets, batches
}

// waitingTicket takes u_owner's ticket in a batch of its own and checks its
// place; it returns the ticket and its batch.
func waitingTicket(t *testing.T, th thumbnailHarness, ws string, position int) (string, string) {
	t.Helper()
	meta := sourceMeta("notes.pdf", "application/pdf", 8)
	rec, turn := takeTicket(t, th.h, sourceUploads(ws), "u_owner", meta)
	if rec.Code != http.StatusCreated || turn.Position != position {
		t.Fatalf("ticket at %d: %d %s", position, rec.Code, rec.Body.String())
	}
	return turn.TicketID, meta["batchId"].(string)
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

func uploadPDF(t *testing.T, th thumbnailHarness, ws, ticket string) (*httptest.ResponseRecorder, *countedBody) {
	t.Helper()
	body := []byte("%PDF-1.7")
	meta := sourceMeta("notes.pdf", "application/pdf", len(body))
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
	running, _ := fillUploadSlots(t, th, ws)
	rec, waiting := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
	if rec.Code != http.StatusCreated || waiting.Position != 1 {
		t.Fatalf("33rd ticket: %d %s", rec.Code, rec.Body.String())
	}
	early, read := uploadPDF(t, th, ws, waiting.TicketID)
	if early.Code != http.StatusConflict || read.read != 0 {
		t.Fatalf("an upload before its turn: %d, read %d bytes", early.Code, read.read)
	}
	polled := make(chan *httptest.ResponseRecorder, 1)
	asked := time.Now()
	go func() { polled <- pollTicket(t, th, waiting.TicketID, 1) }()
	done, _ := uploadPDF(t, th, ws, running[0])
	expectStatus(t, done, http.StatusCreated, "an upload with its turn")
	if turn := polledTurn(t, <-polled); turn.Position != 0 || time.Since(asked) > 5*time.Second {
		t.Fatalf("the poll answered %+v after %v", turn, time.Since(asked))
	}
	next, _ := uploadPDF(t, th, ws, waiting.TicketID)
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
	unused, batches := fillUploadSlots(t, th, ws)
	_, waiting := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
	if waiting.Position != 1 {
		t.Fatalf("33rd ticket waits at %d", waiting.Position)
	}
	if turn := polledTurn(t, pollTicket(t, th, waiting.TicketID, 1)); turn.Position != 0 {
		t.Fatalf("the waiting ticket is at %d after the turns passed", turn.Position)
	}
	// The pass settles the batch right after it frees the slot.
	deadline := time.Now().Add(2 * time.Second)
	for !batchNotified(t, th, batches[0]) {
		if time.Now().After(deadline) {
			t.Fatal("the passed ticket's batch did not settle")
		}
		time.Sleep(20 * time.Millisecond)
	}
	late, read := uploadPDF(t, th, ws, unused[0])
	if late.Code != http.StatusGone || read.read != 0 {
		t.Fatalf("an upload after its turn passed: %d, read %d bytes", late.Code, read.read)
	}
	next, _ := uploadPDF(t, th, ws, waiting.TicketID)
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
	_, sources := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	assetParts := []formPart{
		metadataPart(t, map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": len(png), "contentType": "image/png"}),
		{name: "file", contentType: "image/png", body: png},
	}
	for what, ticket := range map[string]string{"no ticket": "", "an unknown ticket": "utk_unknown"} {
		rec, read := uploadPDF(t, th, ws, ticket)
		if rec.Code != http.StatusGone || read.read != 0 {
			t.Fatalf("an upload with %s: %d, read %d bytes", what, rec.Code, read.read)
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
	spent, _ := uploadPDF(t, th, ws, sources.TicketID)
	expectStatus(t, spent, http.StatusCreated, "the source upload with its own ticket")
	rec, read = uploadPDF(t, th, ws, sources.TicketID)
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
// next ticket at once and settles its batch; only its owner can cancel it
// (Epo 2026-10-22).
func TestUploadTicketCancelGivesUpItsPlace(t *testing.T) {
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	running, batches := fillUploadSlots(t, th, ws)
	first, firstBatch := waitingTicket(t, th, ws, 1)
	second, _ := waitingTicket(t, th, ws, 2)
	cancel := func(user, ticket string) int {
		return doReq(t, th.h, http.MethodDelete, "/api/uploads/tickets/"+ticket, user, nil).Code
	}
	if status := cancel("u_other", first); status != http.StatusGone {
		t.Fatalf("another user's cancel = %d, want 410", status)
	}
	if status := cancel("u_owner", first); status != http.StatusNoContent || !batchNotified(t, th, firstBatch) {
		t.Fatalf("cancel of a waiting ticket = %d", status)
	}
	if turn := polledTurn(t, pollTicket(t, th, second, -1)); turn.Position != 1 {
		t.Fatalf("after the cancel the next ticket waits at %d", turn.Position)
	}
	if status := cancel("u_owner", running[0]); status != http.StatusNoContent || !batchNotified(t, th, batches[0]) {
		t.Fatalf("cancel of a turn = %d", status)
	}
	if turn := polledTurn(t, pollTicket(t, th, second, -1)); turn.Position != 0 {
		t.Fatalf("after the cancelled turn the next ticket waits at %d", turn.Position)
	}
	rec, read := uploadPDF(t, th, ws, running[0])
	if rec.Code != http.StatusGone || read.read != 0 {
		t.Fatalf("an upload with a cancelled ticket: %d, read %d bytes", rec.Code, read.read)
	}
}
