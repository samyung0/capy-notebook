package httpapi_test

import (
	"bytes"
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
// 2026-10-22); each turn holds its slot until it is used or passes.
func fillUploadSlots(t *testing.T, th thumbnailHarness, ws string) []string {
	t.Helper()
	var tickets []string
	for range 32 {
		rec, turn := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
		if rec.Code != http.StatusCreated || turn.Position != 0 {
			t.Fatalf("ticket %d: %d %s", len(tickets)+1, rec.Code, rec.Body.String())
		}
		tickets = append(tickets, turn.TicketID)
	}
	return tickets
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
	running := fillUploadSlots(t, th, ws)
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
	fillUploadSlots(t, th, ws)
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

// A turn its upload does not take in time passes to the next ticket, and the
// passed ticket's upload is refused unread (Epo 2026-10-22).
func TestUploadTurnPassesOnWhenUnused(t *testing.T) {
	// Long enough for the 33 tickets to be taken before the first turn passes.
	httpapi.SetUploadQueueTimings(t, 2*time.Second, 5*time.Minute, 5*time.Second)
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	unused := fillUploadSlots(t, th, ws)
	_, waiting := takeTicket(t, th.h, sourceUploads(ws), "u_owner", sourceMeta("notes.pdf", "application/pdf", 8))
	if waiting.Position != 1 {
		t.Fatalf("33rd ticket waits at %d", waiting.Position)
	}
	if turn := polledTurn(t, pollTicket(t, th, waiting.TicketID, 1)); turn.Position != 0 {
		t.Fatalf("the waiting ticket is at %d after the turns passed", turn.Position)
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
	_ = res.Body.Close()
	if res.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("the stalled upload = %d, want 408", res.StatusCode)
	}
	if held, keys := leftovers(t, th, bucket, ws); held != 0 || len(keys) != 0 {
		t.Fatalf("the cut-off upload left %d held sessions and objects %q", held, keys)
	}
}
