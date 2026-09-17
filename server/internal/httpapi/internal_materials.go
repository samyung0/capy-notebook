package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
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
	Content      string `json:"content"`
	TimeLimitMin *int   `json:"timeLimitMin"`
	// Library attribution resolved by the retrieval service from the excerpt
	// ids the model named. Absent for a workspace material.
	Provenance *store.Provenance `json:"provenance"`
}

// hashPayload is the normalized request identity: everything the model chose.
func (r internalMaterialReq) hashPayload() map[string]any {
	return map[string]any{
		"kind": r.Kind, "title": strings.TrimSpace(r.Title), "questions": r.Questions,
		"cards": r.Cards, "content": r.Content, "timeLimitMin": r.TimeLimitMin,
		"fileIds": r.FileIDs, "chapterIds": r.ChapterIDs, "provenance": r.Provenance,
	}
}

const (
	maxProvenanceBooks   = 32
	maxProvenanceEntries = 32
	maxProvenanceTextLen = 300
	maxProvenanceAuthors = 32
)

// licenseVersionPattern reads the first number of a licence string, so
// `CC BY-SA 4.0` is version 4.0 and `GFDL` has none.
var licenseVersionPattern = regexp.MustCompile(`[0-9]+(\.[0-9]+)?`)

// normalizeLicense upper-cases the licence and collapses every run of space,
// `-` and `_` into one space, so `CC-BY-SA-4.0` and `CC BY-SA 4.0 ` are the
// same licence.
func normalizeLicense(license string) string {
	var out strings.Builder
	separated := false
	for _, r := range strings.ToUpper(license) {
		if r == ' ' || r == '\t' || r == '-' || r == '_' {
			separated = true
			continue
		}
		if separated && out.Len() > 0 {
			out.WriteRune(' ')
		}
		separated = false
		out.WriteRune(r)
	}
	return out.String()
}

// licenseFamily names the copyleft family of a normalized licence, or "" when
// the licence is not copyleft. A curated work inherits one family only.
// NonCommercial ShareAlike is matched first: it is a family of its own, and a
// work may not mix it with plain ShareAlike.
func licenseFamily(normalized string) string {
	switch {
	case strings.Contains(normalized, "BY NC SA"), strings.Contains(normalized, "NONCOMMERCIAL SHAREALIKE"):
		return "CC BY-NC-SA"
	case strings.Contains(normalized, "BY SA"), strings.Contains(normalized, "SHAREALIKE"):
		return "CC BY-SA"
	case strings.Contains(normalized, "GFDL"), strings.Contains(normalized, "GNU FREE DOCUMENTATION LICENSE"):
		return "GFDL"
	case strings.Contains(normalized, "ODBL"), strings.Contains(normalized, "OPEN DATABASE LICENSE"):
		return "ODbL"
	}
	return ""
}

func licenseVersion(normalized string) float64 {
	value, err := strconv.ParseFloat(licenseVersionPattern.FindString(normalized), 64)
	if err != nil {
		return 0
	}
	return value
}

// validateProvenance bounds one call's record: on top of the stored bounds,
// a single call may name at most 32 excerpt ids and 32 authors per book.
func validateProvenance(p *store.Provenance) (string, error) {
	if p == nil {
		return "", nil
	}
	for i := range p.Books {
		book := &p.Books[i]
		if len(book.ExcerptIDs) > maxProvenanceEntries || len(book.Authors) > maxProvenanceAuthors {
			return "invalid_input", errors.New("provenance book carries too many authors or excerpts")
		}
	}
	return validateStoredProvenance(p)
}

// validateStoredProvenance bounds the record a material keeps and computes the
// work's own licence: empty unless a source book is copyleft, in which case the
// work carries that family's newest version written exactly as its book wrote
// it (CC BY-SA 3.0 plus 4.0 is the 4.0 book's string). Sources from two
// different copyleft families have no single answer, so the work is refused.
// Excerpt ids accumulate over a material's edits and are deduplicated on merge,
// so only the book count and the field lengths are bounded here. The returned
// code is the tool error code the model sees.
func validateStoredProvenance(p *store.Provenance) (string, error) {
	if len(p.Books) == 0 || len(p.Books) > maxProvenanceBooks {
		return "invalid_input", errors.New("provenance must name one to 32 books")
	}
	var (
		family string
		newest float64
		chosen string
	)
	for i := range p.Books {
		book := &p.Books[i]
		if book.ID == "" || book.Title == "" || len(book.ExcerptIDs) == 0 {
			return "invalid_input", errors.New("each provenance book needs an id, a title and excerpt ids")
		}
		if book.Version < 1 {
			return "invalid_input", errors.New("each provenance book needs the book version it was read from")
		}
		for _, value := range append([]string{
			book.ID, book.Title, book.Edition, book.License, book.LicenseURL, book.SourceURL,
		}, append(book.Authors, book.ExcerptIDs...)...) {
			if len(value) > maxProvenanceTextLen {
				return "invalid_input", errors.New("provenance field is too long")
			}
		}
		if book.Authors == nil {
			book.Authors = []string{}
		}
		normalized := normalizeLicense(book.License)
		current := licenseFamily(normalized)
		switch {
		case current == "":
		case family == "":
			family, chosen, newest = current, book.License, licenseVersion(normalized)
		case current != family:
			return "lifecycle_rejected", fmt.Errorf(
				"sources carry two copyleft licence families (%s and %s); one material cannot be licensed under both",
				family, current)
		default:
			// Ties keep the first book's wording; only a newer version replaces it.
			if version := licenseVersion(normalized); version > newest {
				chosen, newest = book.License, version
			}
		}
	}
	// A model-supplied licence never survives; the server computes it.
	p.License = chosen
	return "", nil
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
		Questions: req.Questions, TimeLimitMin: req.TimeLimitMin, Cards: cards, Content: req.Content,
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

func (a *api) pipelineSecretOK(r *http.Request) bool {
	secret := a.cfg.PipelineSecret
	return secret != "" &&
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Pipeline-Secret")), []byte(secret)) == 1
}
