package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
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
	// ChapterID is where the material is filed; empty leaves it unfiled.
	ChapterID string   `json:"chapterId"`
	FileIDs   []string `json:"fileIds"`

	Questions json.RawMessage `json:"questions"`
	Cards     []struct {
		Front string `json:"front"`
		Back  string `json:"back"`
	} `json:"cards"`
	Content string `json:"content"`
	// Library attribution resolved by the retrieval service from the excerpt
	// ids the model named. Absent for a workspace material.
	Provenance *store.Provenance `json:"provenance"`
	// FromBank is set by the bank copy route, never by a request body: the
	// questions come from the bank, so the workspace needs no indexed content.
	FromBank bool `json:"-"`
}

// hashPayload is the normalized request identity: everything the model chose.
func (r internalMaterialReq) hashPayload() map[string]any {
	return map[string]any{
		"kind": r.Kind, "title": strings.TrimSpace(r.Title), "questions": r.Questions,
		"cards": r.Cards, "content": r.Content,
		"fileIds": r.FileIDs, "chapterIds": r.ChapterIDs, "provenance": r.Provenance,
		"chapterId": r.ChapterID,
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
	// Web pages and question credits come only from the question bank, never
	// from a model call.
	if len(p.Web) > 0 || len(p.Questions) > 0 {
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
// id, excerpt ids union per book in the order they were read, question credits
// by question id, and the licence recomputed over the merged set. A family
// conflict refuses, leaving the stored record untouched. The merged record is
// bounded by the 32-book ceiling only, so a material stays editable however
// many excerpts it has grown from. Callers validate a model-supplied record
// first; the bank copy route's credits are the server's own.
func mergeProvenance(stored, added *store.Provenance) (*store.Provenance, string, error) {
	if stored == nil {
		return added, "", nil
	}
	merged := &store.Provenance{
		Books: make([]store.ProvenanceBook, len(stored.Books)),
		Web:   slices.Clone(stored.Web),
	}
	for i, book := range stored.Books {
		book.ExcerptIDs = slices.Clone(book.ExcerptIDs)
		merged.Books[i] = book
	}
	if len(stored.Questions)+len(added.Questions) > 0 {
		merged.Questions = maps.Clone(stored.Questions)
		if merged.Questions == nil {
			merged.Questions = map[string]store.QuestionCredit{}
		}
		maps.Copy(merged.Questions, added.Questions)
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
	if code, err := validateProvenance(req.Provenance); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": code, "message": err.Error()})
		return
	}
	a.createAgentMaterial(w, r, req)
}

// createAgentMaterial writes one chat material: the internal create route with
// a model's content, or the bank copy route with the bank's questions and their
// credits. Callers have checked the pipeline secret and the provenance origin.
func (a *api) createAgentMaterial(w http.ResponseWriter, r *http.Request, req internalMaterialReq) {
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

	// A material written from the knowledge library or copied from the bank is
	// grounded there, not in the workspace, so it needs no indexed content.
	_, fileNames, chapterNames, err := a.resolveScope(ctx, req.WorkspaceID, &generateOpts{
		FileIds: req.FileIDs, Chapters: req.ChapterIDs, AllowUnindexed: req.Provenance != nil || req.FromBank,
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
	var chapterID *string
	if req.ChapterID != "" {
		ok, err := a.s.ChapterInWorkspace(ctx, req.ChapterID, req.WorkspaceID)
		if err != nil {
			a.fail(w, err)
			return
		}
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"code": "invalid_input", "message": "chapter_id is not a chapter of this workspace; list_sources shows them",
			})
			return
		}
		chapterID = &req.ChapterID
	}
	cards := make([][2]string, 0, len(req.Cards))
	for _, c := range req.Cards {
		cards = append(cards, [2]string{c.Front, c.Back})
	}
	content, embedded := req.Content, []store.EmbeddedDraft(nil)
	if req.Kind == "note" {
		var ok bool
		if content, embedded, ok = a.convertAgentNote(w, r, req); !ok {
			return
		}
	}
	op, err := a.s.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: store.ChatMaterialID(req.AssistantMessageID, req.ToolCallID), ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, WorkspaceName: ws.Name, Kind: store.MaterialKind(req.Kind), Title: title,
		Questions: req.Questions, Cards: cards, Content: content, Embedded: embedded, ChapterID: chapterID,
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

// convertAgentNote turns the agent's note markdown into the editor's document
// through the collaboration service, with each quiz or flashcards fence
// pointed at the row created beside the note. The row ids derive from the
// tool call, so a replay creates nothing twice. ok is false once a response
// has been written.
func (a *api) convertAgentNote(w http.ResponseWriter, r *http.Request, req internalMaterialReq) (string, []store.EmbeddedDraft, bool) {
	converted, err := a.s.ConvertAgentMarkdown(r.Context(), req.Content)
	var refusal *store.EditRefusal
	if errors.As(err, &refusal) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": refusal.Message})
		return "", nil, false
	}
	if err != nil {
		a.failDocument(w, err)
		return "", nil, false
	}
	ids := make([]string, len(converted.Embedded))
	for i := range ids {
		ids[i] = store.ChatMaterialID(req.AssistantMessageID, fmt.Sprintf("%s/embedded/%d", req.ToolCallID, i))
	}
	content, err := materialdoc.ResolvePendingRefs(string(converted.Document), ids)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
		return "", nil, false
	}
	return content, converted.EmbeddedDrafts(ids), true
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
