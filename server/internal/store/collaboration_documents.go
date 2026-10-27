package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"io"
	"net/http"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// EditRefusal is a typed refusal from the document authority (collaboration
// service): the edit or Undo did not apply and nothing durable changed.
type EditRefusal struct {
	Code    agenttools.ErrorCode
	Message string
	// Details describe a missed target as it is now (the block's current
	// text, or the material's blocks); the gateway passes them to the agent
	// unchanged and keeps them out of the stored message.
	Details json.RawMessage
}

func (e *EditRefusal) Error() string { return string(e.Code) + ": " + e.Message }

// DocumentTarget names one editable resource for the authority.
type DocumentTarget struct {
	Kind agenttools.ResourceKind `json:"kind"`
	ID   string                  `json:"id"`
}

// DocumentOperation is the trusted operation identity forwarded to the
// authority, which records it with the state change.
type DocumentOperation struct {
	ID             string `json:"id"`
	RequestHash    string `json:"requestHash"`
	ToolVersion    int    `json:"toolVersion"`
	ConversationID string `json:"conversationId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	CallID         string `json:"callId,omitempty"`
}

type documentRequest struct {
	Target      DocumentTarget     `json:"target"`
	Room        string             `json:"room,omitempty"`
	ActorUserID string             `json:"actorUserId"`
	Commands    []json.RawMessage  `json:"commands,omitempty"`
	Operation   *DocumentOperation `json:"operation,omitempty"`
	// Provenance is the merged attribution record the authority writes onto the
	// material in the edit's own transaction.
	Provenance *Provenance `json:"provenance,omitempty"`
	// Office is an inspect_office_document read's query; the engine answers
	// it in the inspection's Scoped.
	Office *OfficeQuery `json:"office,omitempty"`
	// Undo is the payload an Undo (or Redo) sends back; UndoOf the step it
	// reverses, which its receipt names (r1 M2).
	Undo   *UndoPayload `json:"undo,omitempty"`
	UndoOf string       `json:"undoOf,omitempty"`
}

// OfficeQuery scopes an Office read: for XLSX no range lists the sheets, a
// sheet and a range read those cells; for DOCX a page of count paragraphs
// from start; for PPTX no slide is a page of count slides from start, a
// slide (its number) that slide's shapes and a page of its paragraphs. IDs
// (any format) reads those pictures and charts instead.
type OfficeQuery struct {
	Sheet string   `json:"sheet,omitempty"`
	Range string   `json:"range,omitempty"`
	Start int      `json:"start,omitempty"`
	Count int      `json:"count,omitempty"`
	Slide int      `json:"slide,omitempty"`
	IDs   []string `json:"ids,omitempty"`
}

// MaterialInspection is the authority's editable view of a material.
type MaterialInspection struct {
	Blocks []struct {
		ID         string            `json:"id"`
		Type       string            `json:"type"`
		Text       string            `json:"text"`
		Children   []json.RawMessage `json:"children,omitempty"`
		Properties map[string]string `json:"properties,omitempty"`
	} `json:"blocks"`
	RoomSchema int64 `json:"roomSchema"`
}

// SourceInspection is the authority's editable view of a source.
type SourceInspection struct {
	Access     string  `json:"access"`
	Checkpoint int64   `json:"checkpoint"`
	Epoch      int64   `json:"epoch"`
	Format     string  `json:"format"`
	Text       *string `json:"text,omitempty"`
	// Scoped is the engine's answer to an Office query, passed on unchanged.
	Scoped json.RawMessage `json:"scoped,omitempty"`
}

func (s *Store) postDocumentAuthority(ctx context.Context, path string, body any, out any) error {
	return s.postCollaboration(ctx, s.collaborationURL, s.collaborationSecret, path, body, out)
}

// limitMessages words the authority's bare limit codes for the model, which
// otherwise reads only the code.
var limitMessages = map[string]string{
	"document_size_exceeded":  "the material would be over its size limit; put the rest in a new material",
	"document_nodes_exceeded": "the material would hold too many blocks; put the rest in a new material",
	"document_depth_exceeded": "the material would nest lists or quotes too deeply; flatten them",
	// Over the collaboration server's 8 MiB update cap (Epo 2026-10-18).
	"update_size_exceeded": "this edit is too large to apply at once; make it as several smaller edits",
}

// collaborationAnswerLimit bounds what the collaboration service answers: a
// receipt with an Undo payload of up to 8 MiB of updates in base64.
const collaborationAnswerLimit = 12 << 20

func (s *Store) postCollaboration(ctx context.Context, baseURL, secret, path string, body any, out any) error {
	if baseURL == "" || secret == "" {
		return ErrAuthorityUnavailable
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	obs.Inject(ctx, req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Collaboration-Secret", secret)
	response, err := s.collaborationHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAuthorityUnavailable, err)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, collaborationAnswerLimit))
	if response.StatusCode == http.StatusOK {
		if out == nil {
			return nil
		}
		return json.Unmarshal(payload, out)
	}
	var refusal struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details"`
	}
	_ = json.Unmarshal(payload, &refusal)
	if readable, ok := limitMessages[refusal.Message]; ok {
		refusal.Message = readable
	}
	switch response.StatusCode {
	case http.StatusRequestEntityTooLarge:
		// A source checkpoint over its byte limit is the edit's result being
		// too large, not an unknown outcome.
		return &EditRefusal{Code: agenttools.ErrQuotaRejected, Message: "the edited file would be over its size limit; make a smaller edit", Details: refusal.Details}
	case http.StatusConflict, http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusBadRequest, http.StatusNotFound, http.StatusLocked:
		code := agenttools.ErrorCode(refusal.Code)
		if code == "" {
			code = agenttools.ErrUnavailableTarget
		}
		if refusal.Message == "" {
			refusal.Message = response.Status
		}
		return &EditRefusal{Code: code, Message: refusal.Message, Details: refusal.Details}
	}
	return authorityFailure(response, refusal.Code, response.Status)
}

// authorityFailure is an authority answer that is neither a success nor a
// refusal the agent acts on. A room being reset (503 unavailable_target)
// refused the edit before anything applied, so it is an expected outcome:
// the authority logs it and the gateway does not report it.
func authorityFailure(response *http.Response, code, message string) error {
	err := obs.WithEventID(fmt.Errorf("%w: %s", ErrAuthorityUnavailable, message), response.Header.Get(obs.ErrorEventHeader))
	if response.StatusCode == http.StatusServiceUnavailable && code == string(agenttools.ErrUnavailableTarget) {
		return obs.ExpectedError(err)
	}
	return err
}

func (s *Store) InspectMaterialDocument(ctx context.Context, actorID, materialID string) (MaterialInspection, error) {
	room, err := s.MaterialRoom(ctx, materialID)
	if err != nil {
		return MaterialInspection{}, err
	}
	var out MaterialInspection
	err = s.postDocumentAuthority(ctx, "/internal/documents/inspect", documentRequest{
		Target: DocumentTarget{Kind: agenttools.KindMaterial, ID: materialID}, Room: room, ActorUserID: actorID,
	}, &out)
	return out, err
}

// InspectSourceDocument reads a source's editable view; an Office query (nil
// for a whole read) asks the engine for one scoped part of it.
func (s *Store) InspectSourceDocument(ctx context.Context, actorID, fileID string, office *OfficeQuery) (SourceInspection, error) {
	var out SourceInspection
	err := s.postDocumentAuthority(ctx, "/internal/documents/inspect", documentRequest{
		Target: DocumentTarget{Kind: agenttools.KindSourceFile, ID: fileID}, ActorUserID: actorID, Office: office,
	}, &out)
	return out, err
}

// OfficeCreation is a new Office file the engine built from its starter with
// the agent's commands applied, and its note on characters the text lost.
type OfficeCreation struct {
	Content []byte `json:"content"`
	Notice  string `json:"notice,omitempty"`
}

// CreateOfficeDocument asks the authority's engine for a new file's bytes;
// nothing is stored there. Its refusals are the edit refusals.
func (s *Store) CreateOfficeDocument(ctx context.Context, actorID, format string, commands []json.RawMessage) (OfficeCreation, error) {
	var out OfficeCreation
	err := s.postDocumentAuthority(ctx, "/internal/documents/create", map[string]any{
		"format": format, "commands": commands, "actorUserId": actorID,
	}, &out)
	if err == nil && len(out.Content) == 0 {
		err = fmt.Errorf("%w: the engine created an empty file", ErrAuthorityUnavailable)
	}
	return out, err
}

// DocumentEdit is the authority's answer to an edit: its receipt and, for an
// Office source, the engine's note on the characters an Office file cannot
// store that the agent's text lost (Epo 2026-10-15), passed on to the tool
// result. A replayed receipt has no note.
type DocumentEdit struct {
	AgentOperation
	Notice string `json:"notice,omitempty"`
}

// EditDocument applies normalized commands through the authority, which
// commits state, receipt and the merged provenance together and returns the
// receipt; one whose Undo fits carries its Undo ref and its Undo payload,
// signed here for the chat (Epo 2026-10-21, 2026-10-22).
func (s *Store) EditDocument(ctx context.Context, actorID string, target DocumentTarget, commands []json.RawMessage, provenance *Provenance, op DocumentOperation) (DocumentEdit, error) {
	req := documentRequest{
		Target: target, ActorUserID: actorID, Commands: commands,
		Provenance: provenance, Operation: &op,
	}
	if target.Kind == agenttools.KindMaterial {
		room, err := s.MaterialRoom(ctx, target.ID)
		if err != nil {
			return DocumentEdit{}, err
		}
		req.Room = room
	} else if err := s.officeEditRefusal(ctx, target.ID); err != nil {
		return DocumentEdit{}, err
	}
	var out DocumentEdit
	err := s.postDocumentAuthority(ctx, "/internal/documents/edit", req, &out)
	out.UndoPayload = s.signUndoPayload(out.ID, target, actorID, out.UndoPayload)
	return out, err
}

// ConvertedMarkdown is agent markdown as the editor's own import reads it: the
// document, and the quiz or flashcard sets its fences describe, in order.
type ConvertedMarkdown struct {
	Document json.RawMessage `json:"document"`
	Embedded []struct {
		Kind      MaterialKind    `json:"kind"`
		Questions json.RawMessage `json:"questions"`
		Cards     []struct {
			Front string `json:"front"`
			Back  string `json:"back"`
		} `json:"cards"`
	} `json:"embedded"`
}

// ConvertAgentMarkdown converts through the collaboration service, which runs
// the editor's markdown import. A fence that does not parse comes back as an
// EditRefusal naming it.
func (s *Store) ConvertAgentMarkdown(ctx context.Context, markdown string) (ConvertedMarkdown, error) {
	var out ConvertedMarkdown
	err := s.postCollaboration(ctx, s.markdownURL, s.markdownSecret, "/internal/markdown/convert", map[string]string{"markdown": markdown}, &out)
	return out, err
}

// EmbeddedDrafts are the converted fences as drafts with the given row ids.
func (c ConvertedMarkdown) EmbeddedDrafts(ids []string) []EmbeddedDraft {
	drafts := make([]EmbeddedDraft, len(c.Embedded))
	for i, e := range c.Embedded {
		drafts[i] = EmbeddedDraft{ID: ids[i], Kind: e.Kind, Questions: e.Questions}
		for _, card := range e.Cards {
			drafts[i].Cards = append(drafts[i].Cards, [2]string{card.Front, card.Back})
		}
	}
	return drafts
}
