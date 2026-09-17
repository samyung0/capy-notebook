package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// curateMessage is seedAssistantMessage on a curate thread, which is the only
// kind of conversation that keeps a ledger.
func curateMessage(t *testing.T, st *store.Store, userID, wsID string) (msgID, convID string) {
	t.Helper()
	msgID = seedAssistantMessage(t, st, userID, wsID)
	if err := st.Pool().QueryRow(t.Context(),
		`UPDATE conversations SET curate=true
		   WHERE id=(SELECT conversation_id FROM messages WHERE id=$1) RETURNING id`, msgID).
		Scan(&convID); err != nil {
		t.Fatal(err)
	}
	return msgID, convID
}

func ledgerBody(msgID, userID string) map[string]any {
	return map[string]any{
		"workspaceId": "ws_e2e_private", "userId": userID, "assistantMessageId": msgID,
		"ledger": map[string]any{
			"requests":     []string{"three notes on linear regression"},
			"next_todo_id": 2,
			"todos": []map[string]any{
				{"id": 1, "text": "worked example"},
			},
			"materials": []map[string]any{
				{"id": "mat_1", "kind": "note", "title": "Least squares", "size": 4, "todo": 0},
			},
		},
	}
}

// The ledger is prompt state the pipeline owns: Go stores the JSON it is given
// and hands it back on the conversation's next turn.
func TestInternalConversationLedgerRoundTrips(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID, convID := curateMessage(t, st, "u_editor", "ws_e2e_private")

	rec := doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret,
		ledgerBody(msgID, "u_editor"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	conv, err := st.GetConversation(t.Context(), "u_editor", convID)
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Requests   []string `json:"requests"`
		NextTodoID int      `json:"next_todo_id"`
		Todos      []struct {
			ID   int    `json:"id"`
			Text string `json:"text"`
		} `json:"todos"`
	}
	if err := json.Unmarshal(conv.Ledger, &stored); err != nil {
		t.Fatalf("stored ledger %q: %v", conv.Ledger, err)
	}
	if len(stored.Requests) != 1 || stored.NextTodoID != 2 ||
		len(stored.Todos) != 1 || stored.Todos[0].ID != 1 {
		t.Fatalf("stored ledger = %s", conv.Ledger)
	}
}

// Only curate threads carry one, so an ordinary chat is refused rather than
// silently growing a column nothing reads back.
func TestInternalConversationLedgerRefusesAnOrdinaryChat(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")

	rec := doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret,
		ledgerBody(msgID, "u_editor"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// The trusted context is verified against the assistant row, so a claimed
// actor who does not own the conversation is not found.
func TestInternalConversationLedgerRejectsAForeignMessage(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID, _ := curateMessage(t, st, "u_editor", "ws_e2e_private")

	rec := doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret,
		ledgerBody(msgID, "u_other"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// The shared secret is the endpoint's only credential, as for every other
// /api/internal route.
func TestInternalConversationLedgerRequiresThePipelineSecret(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID, _ := curateMessage(t, st, "u_editor", "ws_e2e_private")

	rec := doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", "wrong-secret",
		ledgerBody(msgID, "u_editor"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// Prompt state is a workspace mutation like any other: the actor's account and
// editor role are re-checked, so a turn that outlives its account's suspension
// stops writing rows.
func TestInternalConversationLedgerRefusesALockedActor(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID, _ := curateMessage(t, st, "u_editor", "ws_e2e_private")
	if _, err := st.Pool().Exec(t.Context(),
		`UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id='u_editor'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(),
			`UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id='u_editor'`)
	})

	rec := doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret,
		ledgerBody(msgID, "u_editor"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// The pipeline writes the ledger from a finally block, so an aborted turn's
// late write can arrive after the next turn started. It carries the older
// turn's snapshot, so it is refused and only the newest turn may write. The
// fence lives in the UPDATE, so a refused write leaves the stored row alone.
func TestInternalConversationLedgerFencesAnOlderTurn(t *testing.T) {
	h, st := openInternalHTTP(t)
	older, convID := curateMessage(t, st, "u_editor", "ws_e2e_private")
	newer := older + "_next"
	if _, err := st.Pool().Exec(t.Context(),
		`INSERT INTO messages (id, conversation_id, role, status, created_at)
		 VALUES ($1,$2,'assistant','streaming', now() + interval '1 second')`, newer, convID); err != nil {
		t.Fatal(err)
	}

	rec := doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret,
		ledgerBody(older, "u_editor"))
	if rec.Code != http.StatusConflict {
		t.Fatalf("older turn: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || payload.Code != "stale_turn" {
		t.Fatalf("older turn body = %s", rec.Body.String())
	}

	rec = doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret,
		ledgerBody(newer, "u_editor"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("latest turn: status = %d body=%s", rec.Code, rec.Body.String())
	}

	// The aborted turn's write arriving after the newer one must not land.
	stale := ledgerBody(older, "u_editor")
	ledger, ok := stale["ledger"].(map[string]any)
	if !ok {
		t.Fatalf("ledger body shape = %T", stale["ledger"])
	}
	ledger["requests"] = []string{"the aborted turn's snapshot"}
	rec = doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret, stale)
	if rec.Code != http.StatusConflict {
		t.Fatalf("late write: status = %d body=%s", rec.Code, rec.Body.String())
	}
	conv, err := st.GetConversation(t.Context(), "u_editor", convID)
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Requests []string `json:"requests"`
	}
	if err := json.Unmarshal(conv.Ledger, &stored); err != nil {
		t.Fatalf("stored ledger %q: %v", conv.Ledger, err)
	}
	if len(stored.Requests) != 1 || stored.Requests[0] != "three notes on linear regression" {
		t.Fatalf("stored ledger = %s", conv.Ledger)
	}
}

// The 64 KiB ceiling bounds the request, so an oversized ledger is refused
// without the gateway buffering the whole body.
func TestInternalConversationLedgerRefusesAnOversizedBody(t *testing.T) {
	h, st := openInternalHTTP(t)
	msgID, _ := curateMessage(t, st, "u_editor", "ws_e2e_private")

	body := ledgerBody(msgID, "u_editor")
	ledger, ok := body["ledger"].(map[string]any)
	if !ok {
		t.Fatalf("ledger body shape = %T", body["ledger"])
	}
	ledger["requests"] = []string{strings.Repeat("x", 64<<10)}

	rec := doInternal(t, h, http.MethodPost, "/api/internal/conversations/ledger", pipeSecret, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}
