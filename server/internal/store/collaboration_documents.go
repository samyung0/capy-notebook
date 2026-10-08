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
	Epoch       *int64             `json:"epoch,omitempty"`
	Commands    []json.RawMessage  `json:"commands,omitempty"`
	Operation   *DocumentOperation `json:"operation,omitempty"`
	UndoOf      string             `json:"undoOf,omitempty"`
	Inverse     json.RawMessage    `json:"inverse,omitempty"`
	Guards      json.RawMessage    `json:"guards,omitempty"`
	// Provenance is the merged attribution record the authority writes onto the
	// material in the edit's own transaction.
	Provenance *Provenance `json:"provenance,omitempty"`
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
	Access     string            `json:"access"`
	Checkpoint int64             `json:"checkpoint"`
	Epoch      int64             `json:"epoch"`
	Format     string            `json:"format"`
	Text       *string           `json:"text,omitempty"`
	Entries    []json.RawMessage `json:"entries,omitempty"`
}

func (s *Store) postDocumentAuthority(ctx context.Context, path string, body any, out any) error {
	return s.postCollaboration(ctx, s.collaborationURL, s.collaborationSecret, path, body, out)
}

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
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 8<<20))
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
	switch response.StatusCode {
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
	return obs.WithEventID(fmt.Errorf("%w: %s", ErrAuthorityUnavailable, response.Status), response.Header.Get(obs.ErrorEventHeader))
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

func (s *Store) InspectSourceDocument(ctx context.Context, actorID, fileID string) (SourceInspection, error) {
	var out SourceInspection
	err := s.postDocumentAuthority(ctx, "/internal/documents/inspect", documentRequest{
		Target: DocumentTarget{Kind: agenttools.KindSourceFile, ID: fileID}, ActorUserID: actorID,
	}, &out)
	return out, err
}

// EditDocument applies normalized commands through the authority, which
// commits state, receipt, inverse and the merged provenance together and
// returns the receipt.
func (s *Store) EditDocument(ctx context.Context, actorID string, target DocumentTarget, commands []json.RawMessage, provenance *Provenance, op DocumentOperation) (AgentOperation, error) {
	req := documentRequest{
		Target: target, ActorUserID: actorID, Commands: commands,
		Provenance: provenance, Operation: &op,
	}
	if target.Kind == agenttools.KindMaterial {
		room, err := s.MaterialRoom(ctx, target.ID)
		if err != nil {
			return AgentOperation{}, err
		}
		req.Room = room
	} else if err := s.officeEditRefusal(ctx, target.ID); err != nil {
		return AgentOperation{}, err
	}
	var out AgentOperation
	err := s.postDocumentAuthority(ctx, "/internal/documents/edit", req, &out)
	return out, err
}

// UndoDocumentEdit reverses one committed edit through the authority using the
// stored inverse and guards; the authority validates the guards against the
// durable pre-state and consumes the Undo eligibility in the same transaction.
// It carries no provenance: an undo restores the text only, because provenance
// only grows — over-crediting a source is harmless and under-crediting one is
// the licence risk.
func (s *Store) UndoDocumentEdit(ctx context.Context, actorID string, inv EditInverse, op DocumentOperation) (AgentOperation, error) {
	var payload struct {
		Commands json.RawMessage `json:"commands"`
	}
	if err := json.Unmarshal(inv.Inverse, &payload); err != nil || len(payload.Commands) == 0 {
		return AgentOperation{}, ErrUndoUnavailable
	}
	req := documentRequest{
		Target: DocumentTarget{Kind: inv.ResourceKind, ID: inv.ResourceID}, ActorUserID: actorID,
		Operation: &op, UndoOf: inv.OperationID, Inverse: payload.Commands, Guards: inv.Guards,
	}
	if inv.ResourceKind == agenttools.KindMaterial {
		room, err := s.MaterialRoom(ctx, inv.ResourceID)
		if err != nil {
			return AgentOperation{}, err
		}
		req.Room = room
	} else {
		if err := s.officeEditRefusal(ctx, inv.ResourceID); err != nil {
			return AgentOperation{}, err
		}
		epoch := inv.Incarnation
		req.Epoch = &epoch
	}
	var out AgentOperation
	err := s.postDocumentAuthority(ctx, "/internal/documents/undo", req, &out)
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
