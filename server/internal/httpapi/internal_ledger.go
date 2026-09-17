package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A curate turn keeps its progress ledger outside the message list, so the
// retrieval service writes it back through here at turn end and reads it from
// the next turn's stream request. The JSON is opaque to Go: the pipeline owns
// the shape, Go owns who may write it and how large it may get.
const maxConversationLedgerBytes = 64 << 10

type internalLedgerReq struct {
	WorkspaceID        string          `json:"workspaceId"`
	UserID             string          `json:"userId"`
	AssistantMessageID string          `json:"assistantMessageId"`
	Ledger             json.RawMessage `json:"ledger"`
}

// refuseLedgerWrite answers a refused ledger write and logs it. The pipeline
// writes the ledger fire and forget, so without this line a dropped turn of
// curate progress leaves no trace on the gateway at all. The conversation id is
// empty when the body never parsed, which is the only refusal reached before it
// is known; the trace id on the context still ties the line to the request.
func refuseLedgerWrite(w http.ResponseWriter, r *http.Request, status int, code, message, convID string) {
	obs.Log(r.Context()).Warn("curate ledger write refused",
		"code", code,
		"status", status,
		"conversation_id", convID,
	)
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}

func (a *api) internalWriteConversationLedger(w http.ResponseWriter, r *http.Request) {
	var req internalLedgerReq
	// The bound is on the request, not on the parsed value: a looping build
	// must not make the gateway buffer its whole body before the refusal.
	if err := decodeBoundedJSON(w, r, &req, maxConversationLedgerBytes); err != nil {
		refuseLedgerWrite(w, r, http.StatusBadRequest, "invalid_input",
			"the ledger request is malformed or larger than 64 KiB", "")
		return
	}
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, true) {
		return
	}
	if req.AssistantMessageID == "" || len(req.Ledger) == 0 {
		refuseLedgerWrite(w, r, http.StatusBadRequest, "invalid_input",
			"assistantMessageId and ledger are required", "")
		return
	}
	ctx := r.Context()
	convUser, convWS, convID, err := a.s.AssistantMessageContext(ctx, req.AssistantMessageID)
	if err != nil || convUser != req.UserID || convWS != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	conv, err := a.s.GetConversation(ctx, req.UserID, convID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !conv.Curate {
		refuseLedgerWrite(w, r, http.StatusBadRequest, "invalid_input",
			"only a curate conversation keeps a ledger", convID)
		return
	}
	// The write is fenced inside the UPDATE: the pipeline writes from a finally
	// block, so an aborted turn can still arrive after the next turn started,
	// carrying a value computed from the older snapshot.
	if err := a.s.SetConversationLedger(ctx, convID, req.AssistantMessageID, req.Ledger); err != nil {
		if errors.Is(err, store.ErrStaleTurn) {
			refuseLedgerWrite(w, r, http.StatusConflict, "stale_turn",
				"a newer turn has started in this conversation", convID)
			return
		}
		a.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
