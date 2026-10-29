package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/obs"
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
	// WorkspaceID is the turn's workspace, or with Scope "account" where the
	// material lands: a workspace the actor edits, or "" for No workspace.
	WorkspaceID        string `json:"workspaceId"`
	UserID             string `json:"userId"`
	Scope              string `json:"scope"`
	AssistantMessageID string `json:"assistantMessageId"`
	ToolCallID         string `json:"toolCallId"`
	Kind               string `json:"kind"`
	Title              string `json:"title"`
	// ChapterID is where the material is filed; empty leaves it unfiled.
	ChapterID string `json:"chapterId"`
	// Sources is the model's made-from line (resolveSources).
	Sources []string `json:"sources"`

	Questions json.RawMessage `json:"questions"`
	Cards     []struct {
		Front string `json:"front"`
		Back  string `json:"back"`
	} `json:"cards"`
	Content string `json:"content"`
	// Library attribution resolved by the retrieval service from the excerpt
	// ids the model named. Absent for a workspace material.
	Provenance *store.Provenance `json:"provenance"`
	// The library figures a note's markdown places, rendered by the retrieval
	// service; each becomes an editor asset of the note.
	Figures []agentFigure `json:"figures"`
}

// hashPayload is the normalized request identity: everything the model chose.
func (r internalMaterialReq) hashPayload() map[string]any {
	return hashFigures(map[string]any{
		"kind": r.Kind, "title": strings.TrimSpace(r.Title), "questions": r.Questions,
		"cards": r.Cards, "content": r.Content,
		"sources": r.Sources, "provenance": r.Provenance,
		"chapterId": r.ChapterID,
	}, r.Figures)
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

// sourcesBounds is the one refusal an agent's sources can get: their format.
var sourcesBounds = fmt.Sprintf("sources: send at most %d sources of at most %d characters each.",
	fieldlimits.MaterialSources, fieldlimits.MaterialSource)

// validSources counts a repeated source once and a blank one not at all, as
// resolveSources stores them.
func validSources(sources []string) bool {
	distinct := map[string]struct{}{}
	for _, source := range sources {
		source = strings.TrimSpace(source)
		if source == "" {
			continue
		}
		if utf8.RuneCountInString(source) > fieldlimits.MaterialSource {
			return false
		}
		distinct[source] = struct{}{}
	}
	return len(distinct) <= fieldlimits.MaterialSources
}

// resolveSources turns an agent's sources, its made-from line in plain strings
// (Epo 2026-10-21), into the names stored with what it made: the id of a
// workspace file, top-level material of any kind or chapter becomes that
// item's current name, and anything else (an exact name, which already is the
// current one, a lecture, a web address) stays as written, trimmed. Duplicates
// are kept once and a blank source is dropped (Epo 2026-10-21); no sources
// stores none.
func (a *api) resolveSources(ctx context.Context, wsID string, sources []string) ([]string, error) {
	names := []string{}
	if len(sources) == 0 {
		return names, nil
	}
	items, err := a.s.SourceItems(ctx, wsID)
	if err != nil {
		return nil, err
	}
	chapters, err := a.s.ListChapters(ctx, wsID)
	if err != nil {
		return nil, err
	}
	nameByID := make(map[string]string, len(items)+len(chapters))
	for _, ch := range chapters {
		nameByID[ch.ID] = ch.Name
	}
	for _, item := range items {
		nameByID[item.ID] = item.Name
	}
	for _, source := range sources {
		source = strings.TrimSpace(source)
		if source == "" {
			continue
		}
		if name, ok := nameByID[source]; ok {
			source = name
		}
		if !slices.Contains(names, source) {
			names = append(names, source)
		}
	}
	return names, nil
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
	account, ok := a.internalScope(w, r, req.Scope)
	if !ok {
		return
	}
	if (req.WorkspaceID == "" && !account) || req.UserID == "" || req.AssistantMessageID == "" || req.ToolCallID == "" {
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
	if len(req.Figures) > 0 && req.Kind != "note" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "only a note shows figures"})
		return
	}
	if !validSources(req.Sources) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": sourcesBounds})
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
	// claims must be the ones this assistant message belongs to (an account
	// call's, the actor's account conversation). A deleted turn is not valid
	// authorization for a late callback.
	var convID string
	if account {
		if convID, ok = a.accountConversation(w, r, req.UserID, req.AssistantMessageID); !ok ||
			!a.accountDestination(w, r, req.UserID, req.WorkspaceID) {
			return
		}
	} else if convID, ok = a.workspaceConversation(w, r, req.UserID, req.WorkspaceID, req.AssistantMessageID); !ok {
		return
	} else if err := a.s.AssertWorkspaceEditor(ctx, req.UserID, req.WorkspaceID); err != nil {
		if errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrNotFound) {
			// The role or membership changed after the turn started; the write
			// is refused, not lost (an unmapped error read as an unknown outcome).
			permissionRefusal(w)
			return
		}
		a.fail(w, err)
		return
	}

	opID := store.ChatOperationID(req.AssistantMessageID, req.ToolCallID)
	payload := req.hashPayload()
	if account {
		// The model chose where it lands.
		payload["workspaceId"] = req.WorkspaceID
	}
	hash, err := store.RequestHash(payload)
	if err != nil {
		a.fail(w, err)
		return
	}
	// A committed receipt answers a replay without rerunning mutable admission
	// (sources, quota); a different payload under the same id is a conflict.
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, err)
		return
	}

	var sourceNames []string
	if account {
		sourceNames, err = a.resolveAccountSources(ctx, req.UserID, req.Sources)
	} else {
		sourceNames, err = a.resolveSources(ctx, req.WorkspaceID, req.Sources)
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	// Do not recheck inference credits here. The provider call that emitted this
	// accepted tool may have exhausted them, and the turn contract requires its
	// already-paid tools to finish. The pipeline secret plus the editor check
	// above authorize the write; storage quota is still enforced by the store.

	// A standalone material has no workspace name, and an untitled one is
	// "Untitled" (DisambiguateMaterialTitle).
	var ws store.Workspace
	if req.WorkspaceID != "" {
		if ws, err = a.s.GetWorkspaceShared(ctx, req.WorkspaceID); err != nil {
			a.fail(w, err)
			return
		}
	}
	title := strings.TrimSpace(req.Title)
	if title == "" && req.WorkspaceID != "" {
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
				"code": "unknown_chapter", "message": "chapter_id is not a chapter of the workspace the item is created in",
			})
			return
		}
		chapterID = &req.ChapterID
	}
	cards := make([][2]string, 0, len(req.Cards))
	for i, c := range req.Cards {
		if err := materialdoc.ValidateCardText(c.Front, c.Back); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"code": "invalid_input", "message": fmt.Sprintf("cards[%d]: %v", i, err),
			})
			return
		}
		cards = append(cards, [2]string{c.Front, c.Back})
	}
	content, embedded := req.Content, []store.EmbeddedDraft(nil)
	var assets []store.AgentAsset
	var figures *agentFigures
	if req.Kind == "note" {
		figures = newAgentFigures(req.AssistantMessageID, req.ToolCallID, req.Figures)
		var ok bool
		if content, embedded, ok = a.convertAgentNote(w, r, req, figures); !ok {
			return
		}
		// A note always has text beside its fences and cannot say which
		// sources went where: each fence's item records all of them, and so
		// does the note (Epo 2026-10-10: over-credit).
		for i := range embedded {
			embedded[i].Provenance = req.Provenance
		}
		// Its figures are stored first and inserted with it, charged to the
		// actor like the note.
		if len(figures.used) > 0 {
			imageMaxBytes, err := a.s.ImageMaxBytes(ctx, req.UserID)
			if err != nil {
				a.fail(w, err)
				return
			}
			if assets, err = a.putAgentFigures(ctx, figures, imageMaxBytes); err != nil {
				a.failDocument(w, err)
				return
			}
		}
	}
	op, created, err := a.s.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: store.ChatMaterialID(req.AssistantMessageID, req.ToolCallID), ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, WorkspaceName: ws.Name, Kind: store.MaterialKind(req.Kind), Title: title,
		Questions: req.Questions, Cards: cards, Content: content, Embedded: embedded, Assets: assets,
		ChapterID: chapterID, ScopeFileNames: sourceNames, Provenance: req.Provenance,
	}, store.AgentOperation{
		ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, ConversationID: convID,
		MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	})
	if err != nil || !created {
		a.deleteAgentAssets(ctx, assets)
	} else if len(assets) > 0 {
		ids := make([]string, len(assets))
		for i, asset := range assets {
			ids[i] = asset.ID
		}
		a.thumbnailFigures(ctx, figures, ids)
	}
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
	if req.Kind == "note" && op.Effect != nil {
		op.Effect.BlockIDs = topBlockIDs(content)
	}
	writeJSON(w, http.StatusOK, op)
}

// topBlockIDs are a note document's top-level block ids, in order.
func topBlockIDs(content string) []string {
	var doc struct {
		Value []struct {
			ID string `json:"id"`
		} `json:"value"`
	}
	if json.Unmarshal([]byte(content), &doc) != nil {
		return nil
	}
	ids := make([]string, 0, len(doc.Value))
	for _, block := range doc.Value {
		ids = append(ids, block.ID)
	}
	return ids
}

// convertAgentNote turns the agent's note markdown into the editor's document
// through the collaboration service, with each quiz or flashcards fence
// pointed at the row created beside the note and each figure at its asset.
// The ids derive from the tool call, so a replay creates nothing twice. ok is
// false once a response has been written.
func (a *api) convertAgentNote(w http.ResponseWriter, r *http.Request, req internalMaterialReq, figures *agentFigures) (string, []store.EmbeddedDraft, bool) {
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
	if err == nil {
		content, err = figures.resolve(content)
	}
	if errors.As(err, &refusal) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": string(refusal.Code), "message": refusal.Message})
		return "", nil, false
	}
	// An agent's note is a block write: its figures strictly (Epo 2026-10-18).
	if err == nil {
		_, err = materialdoc.ParseWrite(content)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
		return "", nil, false
	}
	return content, converted.EmbeddedDrafts(ids), true
}

// internalGetAgentOperation is the reconciliation read for a lost response:
// the recorded receipt, only to the actor and workspace it belongs to, or with
// scope=account to the actor of the account conversation it was made in.
func (a *api) internalGetAgentOperation(w http.ResponseWriter, r *http.Request) {
	account, ok := a.internalScope(w, r, r.URL.Query().Get("scope"))
	if !ok {
		return
	}
	operationID := chi.URLParam(r, "operationId")
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if account && workspaceID != "" {
		refuseAccountWorkspace(w)
		return
	}
	if operationID == "" || (workspaceID == "" && !account) || userID == "" {
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
	if op.ActorUserID != userID || (!account && op.WorkspaceID != workspaceID) {
		a.fail(w, store.ErrNotFound)
		return
	}
	if account {
		conv, err := a.s.GetConversation(r.Context(), userID, op.ConversationID)
		if err != nil || conv.WorkspaceID != "" {
			a.fail(w, store.ErrNotFound)
			return
		}
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
	if errors.Is(err, materialdoc.ErrInvalid) {
		// A stored note a later rule refuses: a 4xx, so the ingest worker
		// ends the job instead of retrying it (it retries 5xx and 429).
		obs.ResponseError(w, err)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"code": "material_content_unreadable", "message": "material content could not be decoded",
		})
		return
	}
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
