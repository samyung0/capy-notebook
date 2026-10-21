package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// internalFileReq is a file the chat agent made: the PPTX of a finished deck
// (pipeline/pipeline/retrieval/deck.py). Content is base64 in JSON.
type internalFileReq struct {
	WorkspaceID        string            `json:"workspaceId"`
	UserID             string            `json:"userId"`
	AssistantMessageID string            `json:"assistantMessageId"`
	ToolCallID         string            `json:"toolCallId"`
	Name               string            `json:"name"`
	ChapterID          string            `json:"chapterId"`
	Content            []byte            `json:"content"`
	Provenance         *store.Provenance `json:"provenance"`
	// Sources is the deck's made-from line, as for a material.
	Sources []string `json:"sources"`
}

// internalCreateFile stores an agent's file the way an upload lands: the
// editor check an upload makes, the workspace owner's quota on the bytes, the
// blob, the files row with its library provenance, and the ingest job that
// parses and indexes it. Like create_material it is bound to the assistant
// message's actor and workspace and keeps a receipt, so a replay returns the
// same file.
func (a *api) internalCreateFile(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	ceiling, err := a.s.MaxSourceFileBytes()
	if err != nil {
		a.fail(w, err)
		return
	}
	// Base64 grows the bytes by a third; 4 MiB covers the JSON fields.
	r.Body = http.MaxBytesReader(w, r.Body, ceiling/3*4+4<<20)
	var req internalFileReq
	if err := decode(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
		return
	}
	if req.AssistantMessageID == "" || req.ToolCallID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "assistantMessageId and toolCallId are required",
		})
		return
	}
	name := strings.TrimSpace(req.Name)
	// Decks only: edit_office_document's create stores the engine's bytes
	// itself through storeAgentFile (Epo 2026-10-20, review finding 9).
	if !strings.EqualFold(sourceupload.Extension(name), ".pptx") || len(req.Content) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "an agent file is a non-empty .pptx",
		})
		return
	}
	if !validSources(req.Sources) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": sourcesBounds})
		return
	}
	if req.Provenance != nil {
		// The pipeline merged this record over many calls, so the stored
		// bounds apply, not one call's.
		if len(req.Provenance.Web) > 0 || len(req.Provenance.Questions) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "provenance may name library books only"})
			return
		}
		if code, err := validateStoredProvenance(req.Provenance); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": code, "message": err.Error()})
			return
		}
	}
	sum := sha256.Sum256(req.Content)
	op, ok := a.agentFileOperation(w, r, req.UserID, req.WorkspaceID, req.AssistantMessageID, req.ToolCallID, map[string]any{
		"name": name, "chapterId": req.ChapterID, "provenance": req.Provenance,
		"contentSha256": hex.EncodeToString(sum[:]), "sources": req.Sources,
	})
	if !ok {
		return
	}
	chapterID, ok := a.agentChapter(w, r.Context(), req.ChapterID, req.WorkspaceID)
	if !ok {
		return
	}
	sourceNames, err := a.resolveSources(r.Context(), req.WorkspaceID, req.Sources)
	if err != nil {
		a.fail(w, err)
		return
	}
	receipt, ok := a.storeAgentFile(w, r.Context(), agentFile{
		name: name, chapterID: chapterID, content: req.Content, provenance: req.Provenance,
		sourceNames: sourceNames, op: op,
	})
	if ok {
		writeJSON(w, http.StatusOK, receipt)
	}
}

// agentFileOperation checks a chat file write's actor (an editor, on the
// assistant message's own workspace) and returns the operation its receipt is
// stored under. A replayed receipt or a refusal is written to w and ok is
// false.
func (a *api) agentFileOperation(w http.ResponseWriter, r *http.Request, userID, workspaceID, messageID, callID string, request map[string]any) (store.AgentOperation, bool) {
	if !a.internalDocumentsActor(w, r, userID, workspaceID, true) {
		return store.AgentOperation{}, false
	}
	ctx := r.Context()
	convUser, convWS, convID, err := a.s.AssistantMessageContext(ctx, messageID)
	if err != nil || convUser != userID || convWS != workspaceID {
		a.fail(w, store.ErrNotFound)
		return store.AgentOperation{}, false
	}
	opID := store.ChatOperationID(messageID, callID)
	hash, err := store.RequestHash(request)
	if err != nil {
		a.fail(w, err)
		return store.AgentOperation{}, false
	}
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return store.AgentOperation{}, false
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, err)
		return store.AgentOperation{}, false
	}
	return store.AgentOperation{
		ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: userID,
		WorkspaceID: workspaceID, ConversationID: convID, MessageID: messageID, CallID: callID,
	}, true
}

// agentChapter checks a chat file's chapter before anything is built or
// stored; "" files it in none (nil). A refusal is written to w and ok is
// false.
func (a *api) agentChapter(w http.ResponseWriter, ctx context.Context, chapterID, workspaceID string) (*string, bool) {
	if chapterID == "" {
		return nil, true
	}
	ok, err := a.s.ChapterInWorkspace(ctx, chapterID, workspaceID)
	if err != nil {
		a.fail(w, err)
		return nil, false
	}
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "chapterId is not a chapter of this workspace",
		})
		return nil, false
	}
	return &chapterID, true
}

// agentFile is a file the chat agent made, ready to store under op in the
// chapter agentChapter checked.
type agentFile struct {
	name       string
	chapterID  *string
	content    []byte
	provenance *store.Provenance
	// sourceNames is its made-from line (resolveSources); nil stores none.
	sourceNames []string
	op          store.AgentOperation
}

// storeAgentFile lands an agent's file like an upload (the upload's size
// check, the blob, the files row, the parse job) with its receipt, whose Undo
// trashes it. A refusal is written to w and ok is false.
func (a *api) storeAgentFile(w http.ResponseWriter, ctx context.Context, f agentFile) (store.AgentOperation, bool) {
	if a.blob == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "blob store not configured"})
		return store.AgentOperation{}, false
	}
	kind := kindFromName(f.name)
	parseMode := sourceupload.DefaultParseMode(f.name, kind)
	maxBytes, err := a.sourceMaxBytes(ctx, f.op.ActorUserID)
	if err != nil {
		a.fail(w, err)
		return store.AgentOperation{}, false
	}
	if err := sourceupload.Validate(f.name, kind, parseMode, int64(len(f.content)), maxBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
		return store.AgentOperation{}, false
	}

	blobPath, size, err := a.blob.Put(sourceObjectKey(store.ObjectKeyID("blob")), bytes.NewReader(f.content))
	if err != nil {
		a.fail(w, err)
		return store.AgentOperation{}, false
	}
	op, created, err := a.s.CreateAgentFileOperation(ctx, store.AgentFileDraft{
		WorkspaceID: f.op.WorkspaceID, ActorUserID: f.op.ActorUserID, Name: f.name, Kind: kind,
		ChapterID: f.chapterID, SizeBytes: size, BlobPath: blobPath, Parser: a.parser,
		ParseMode: parseMode, Provenance: f.provenance, ScopeFileNames: f.sourceNames,
	}, f.op)
	// Uncancelled: a pipeline timeout or disconnect that failed the insert
	// must not also cancel the delete, or the object stays with no row.
	if err != nil || !created {
		_ = a.blob.Delete(context.WithoutCancel(ctx), blobPath)
	}
	if err != nil {
		a.fail(w, err)
		return store.AgentOperation{}, false
	}
	return op, true
}
