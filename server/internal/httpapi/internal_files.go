package httpapi

import (
	"bytes"
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
	if a.blob == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "blob store not configured"})
		return
	}
	ceiling, err := a.s.MaxSourceFileBytes()
	if err != nil {
		a.fail(w, err)
		return
	}
	// Base64 grows the bytes by a third.
	r.Body = http.MaxBytesReader(w, r.Body, ceiling/3*4+multipartHeadroom)
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
	if !strings.EqualFold(sourceupload.Extension(name), ".pptx") || len(req.Content) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "an agent file is a non-empty .pptx",
		})
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
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, true) {
		return
	}
	ctx := r.Context()
	convUser, convWS, convID, err := a.s.AssistantMessageContext(ctx, req.AssistantMessageID)
	if err != nil || convUser != req.UserID || convWS != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}

	opID := store.ChatOperationID(req.AssistantMessageID, req.ToolCallID)
	sum := sha256.Sum256(req.Content)
	hash, err := store.RequestHash(map[string]any{
		"name": name, "chapterId": req.ChapterID, "provenance": req.Provenance,
		"contentSha256": hex.EncodeToString(sum[:]),
	})
	if err != nil {
		a.fail(w, err)
		return
	}
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
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
				"code": "invalid_input", "message": "chapterId is not a chapter of this workspace",
			})
			return
		}
		chapterID = &req.ChapterID
	}
	kind := kindFromName(name)
	parseMode := sourceupload.DefaultParseMode(name, kind)
	maxBytes, err := a.sourceMaxBytes(ctx, req.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := sourceupload.Validate(name, kind, parseMode, int64(len(req.Content)), maxBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
		return
	}

	blobPath, size, err := a.blob.Put(sourceObjectKey(randID("blob")), bytes.NewReader(req.Content))
	if err != nil {
		a.fail(w, err)
		return
	}
	op, created, err := a.s.CreateAgentFileOperation(ctx, store.AgentFileDraft{
		WorkspaceID: req.WorkspaceID, ActorUserID: req.UserID, Name: name, Kind: kind,
		ChapterID: chapterID, SizeBytes: size, BlobPath: blobPath, Parser: a.parser,
		ParseMode: parseMode, Provenance: req.Provenance,
	}, store.AgentOperation{
		ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, ConversationID: convID,
		MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	})
	if err != nil || !created {
		_ = a.blob.Delete(ctx, blobPath)
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}
