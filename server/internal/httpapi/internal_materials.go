package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// The chat agent can create study materials mid-conversation. It cannot do that
// by streaming a "material" event back through the SSE relay, because that
// channel is one-directional: the model would be told the quiz exists before Go
// had run the owner's storage quota check, and it would have no material id to
// refer to afterwards. The tool calls in here synchronously instead, so a quota
// rejection reaches the model in time for it to say so.
//
// Authentication is a shared secret rather than a user session. The retrieval
// service is trusted infrastructure — it already holds the same Postgres
// credentials as this process — so the secret only keeps the route off the
// public internet. The trusted context (actor, workspace, assistant message,
// tool call) is verified against the conversation the message belongs to, and
// the workspace-editor check constrains what may be written on whose behalf.
//
// Every committed creation leaves an agent_operations receipt in the same
// transaction. The same call replayed returns that receipt; a lost response is
// reconciled through GET /api/internal/agent-operations/{id}.
type internalMaterialReq struct {
	WorkspaceID        string   `json:"workspaceId"`
	UserID             string   `json:"userId"`
	AssistantMessageID string   `json:"assistantMessageId"`
	ToolCallID         string   `json:"toolCallId"`
	Kind               string   `json:"kind"`
	Title              string   `json:"title"`
	ChapterIDs         []string `json:"chapterIds"`
	FileIDs            []string `json:"fileIds"`

	Questions json.RawMessage `json:"questions"`
	Cards     []struct {
		Front string `json:"front"`
		Back  string `json:"back"`
	} `json:"cards"`
	Content string `json:"content"`
	// Library attribution resolved by the retrieval service from the excerpt
	// ids the model named. Absent for a workspace material.
	Provenance *store.Provenance `json:"provenance"`
}

// hashPayload is the normalized request identity: everything the model chose.
func (r internalMaterialReq) hashPayload() map[string]any {
	return map[string]any{
		"kind": r.Kind, "title": strings.TrimSpace(r.Title), "questions": r.Questions,
		"cards": r.Cards, "content": r.Content,
		"fileIds": r.FileIDs, "chapterIds": r.ChapterIDs, "provenance": r.Provenance,
	}
}

const (
	maxProvenanceBooks   = store.MaxProvenanceBooks
	maxProvenanceEntries = 32
	maxProvenanceAuthors = 32
)

// validateProvenance bounds one call's record: on top of the stored bounds,
// a single call may name at most 32 excerpt ids and 32 authors per book.
func validateProvenance(p *store.Provenance) (string, error) {
	if p == nil {
		return "", nil
	}
	// Web pages are credited only by the question bank, never by a model call.
	if len(p.Web) > 0 {
		return "invalid_input", errors.New("provenance may name library books only")
	}
	for i := range p.Books {
		book := &p.Books[i]
		if len(book.ExcerptIDs) > maxProvenanceEntries || len(book.Authors) > maxProvenanceAuthors {
			return "invalid_input", errors.New("provenance book carries too many authors or excerpts")
		}
	}
	return validateStoredProvenance(p)
}

func validateStoredProvenance(p *store.Provenance) (string, error) {
	return store.ValidateStoredProvenance(p)
}

// mergeProvenance folds an appended record into the stored one: books union by
// id, excerpt ids union per book in the order they were read, and the licence
// recomputed over the merged set. A family conflict refuses, leaving the
// stored record untouched. The merged record is bounded by the 32-book ceiling
// only, so a material stays editable however many excerpts it has grown from.
func mergeProvenance(stored, added *store.Provenance) (*store.Provenance, string, error) {
	if code, err := validateProvenance(added); err != nil {
		return nil, code, err
	}
	if stored == nil {
		return added, "", nil
	}
	merged := &store.Provenance{Books: make([]store.ProvenanceBook, len(stored.Books))}
	for i, book := range stored.Books {
		book.ExcerptIDs = slices.Clone(book.ExcerptIDs)
		merged.Books[i] = book
	}
	for _, book := range added.Books {
		at := slices.IndexFunc(merged.Books, func(b store.ProvenanceBook) bool { return b.ID == book.ID })
		if at < 0 {
			merged.Books = append(merged.Books, book)
			continue
		}
		for _, excerpt := range book.ExcerptIDs {
			if !slices.Contains(merged.Books[at].ExcerptIDs, excerpt) {
				merged.Books[at].ExcerptIDs = append(merged.Books[at].ExcerptIDs, excerpt)
			}
		}
	}
	if code, err := validateStoredProvenance(merged); err != nil {
		return nil, code, err
	}
	return merged, "", nil
}

func (a *api) internalCreateMaterial(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}

	var req internalMaterialReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if req.WorkspaceID == "" || req.UserID == "" || req.AssistantMessageID == "" || req.ToolCallID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "workspaceId, userId, assistantMessageId and toolCallId are required",
		})
		return
	}
	switch req.Kind {
	case "quiz", "flashcards", "mindmap", "diagram", "note":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "unsupported material kind " + req.Kind})
		return
	}
	if code, err := validateProvenance(req.Provenance); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": code, "message": err.Error()})
		return
	}
	ctx := r.Context()
	actorStatus, err := a.s.AccountAccess(ctx, req.UserID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !actorStatus.CanAuthenticate() {
		a.fail(w, actorStatus.Err())
		return
	}
	// Bind the callback to the real conversation: the actor and workspace it
	// claims must be the ones this assistant message belongs to. A deleted turn
	// is not valid authorization for a late callback.
	convUser, convWS, convID, err := a.s.AssistantMessageContext(ctx, req.AssistantMessageID)
	if err != nil || convUser != req.UserID || convWS != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	if err := a.s.AssertWorkspaceEditor(ctx, req.UserID, req.WorkspaceID); err != nil {
		a.fail(w, err)
		return
	}

	opID := store.ChatOperationID(req.AssistantMessageID, req.ToolCallID)
	hash, err := store.RequestHash(req.hashPayload())
	if err != nil {
		a.fail(w, err)
		return
	}
	// A committed receipt answers a replay without rerunning mutable admission
	// (scope, quota); a different payload under the same id is a conflict.
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, err)
		return
	}

	// A material written from the knowledge library is grounded in the library,
	// not in the workspace, so it does not require indexed workspace content.
	_, fileNames, chapterNames, err := a.resolveScope(ctx, req.WorkspaceID, &generateOpts{
		FileIds: req.FileIDs, Chapters: req.ChapterIDs, AllowUnindexed: req.Provenance != nil,
	})
	if err != nil {
		if errors.Is(err, errScopeNoIndexedContent) {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"code": "scope_has_no_indexed_content", "message": errScopeNoIndexedContent.Error(),
			})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_scope", "message": "The requested scope is invalid or unavailable.",
		})
		return
	}
	// Do not recheck inference credits here. The provider call that emitted this
	// accepted tool may have exhausted them, and the turn contract requires its
	// already-paid tools to finish. The pipeline secret plus the editor check
	// above authorize the write; storage quota is still enforced by the store.

	ws, err := a.s.GetWorkspaceShared(ctx, req.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = ws.Name + " " + req.Kind
	}
	title, err = a.s.DisambiguateMaterialTitle(ctx, req.WorkspaceID, title)
	if err != nil {
		a.fail(w, err)
		return
	}
	cards := make([][2]string, 0, len(req.Cards))
	for _, c := range req.Cards {
		cards = append(cards, [2]string{c.Front, c.Back})
	}
	op, err := a.s.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: store.ChatMaterialID(req.AssistantMessageID, req.ToolCallID), ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, WorkspaceName: ws.Name, Kind: store.MaterialKind(req.Kind), Title: title,
		Questions: req.Questions, Cards: cards, Content: req.Content,
		ScopeChapters: chapterNames, ScopeFileNames: fileNames, Provenance: req.Provenance,
	}, store.AgentOperation{
		ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, ConversationID: convID,
		MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	})
	if err != nil {
		if errors.Is(err, store.ErrEmptyMaterial) {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"code": "invalid_input", "message": "The material has no content.",
			})
			return
		}
		if errors.Is(err, materialdoc.ErrInvalid) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
			return
		}
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

// internalGetAgentOperation is the reconciliation read for a lost response:
// the recorded receipt, only to the actor and workspace it belongs to.
func (a *api) internalGetAgentOperation(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	operationID := chi.URLParam(r, "operationId")
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if operationID == "" || workspaceID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "operationId, workspaceId and userId are required"})
		return
	}
	actorStatus, err := a.s.AccountAccess(r.Context(), userID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !actorStatus.CanAuthenticate() {
		a.fail(w, actorStatus.Err())
		return
	}
	op, err := a.s.GetAgentOperation(r.Context(), operationID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if op.ActorUserID != userID || op.WorkspaceID != workspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

// internalMaterialIndexText hands the ingest worker the text of a workspace
// note; 404 covers a trashed, standalone or missing note, which ends the job.
func (a *api) internalMaterialIndexText(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	workspaceID := r.URL.Query().Get("workspaceId")
	if workspaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "workspaceId is required"})
		return
	}
	text, err := a.s.MaterialIndexText(r.Context(), chi.URLParam(r, "id"), workspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, text)
}

func (a *api) pipelineSecretOK(r *http.Request) bool {
	secret := a.cfg.PipelineSecret
	return secret != "" &&
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Pipeline-Secret")), []byte(secret)) == 1
}
