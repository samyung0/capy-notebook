package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"

	"github.com/evonotes/server/internal/materialdoc"
)

type replaceBlockCommand struct {
	Type             string         `json:"type"`
	MaterialID       string         `json:"materialId"`
	Room             string         `json:"room"`
	ExpectedBlock    map[string]any `json:"expectedBlock"`
	ReplacementBlock map[string]any `json:"replacementBlock"`
}

func (s *Store) materialYjsInitialized(ctx context.Context, materialID string) (bool, error) {
	var initialized bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM material_yjs_documents WHERE material_id=$1
	)`, materialID).Scan(&initialized)
	return initialized, err
}

func changedStableBlock(current, desired materialdoc.Envelope) (map[string]any, map[string]any, error) {
	currentByID := make(map[string]map[string]any, len(current.Value))
	for _, block := range current.Value {
		id, _ := block["id"].(string)
		if id == "" {
			return nil, nil, fmt.Errorf("%w: current block requires a stable id", materialdoc.ErrInvalid)
		}
		currentByID[id] = block
	}
	var before, after map[string]any
	for _, block := range desired.Value {
		id, _ := block["id"].(string)
		existing := currentByID[id]
		if existing == nil {
			return nil, nil, fmt.Errorf("%w: content commands cannot insert top-level blocks", materialdoc.ErrInvalid)
		}
		delete(currentByID, id)
		if reflect.DeepEqual(existing, block) {
			continue
		}
		if before != nil {
			return nil, nil, fmt.Errorf("%w: content command must target one stable block", materialdoc.ErrInvalid)
		}
		if existing["type"] != block["type"] {
			return nil, nil, fmt.Errorf("%w: content command cannot change block type", materialdoc.ErrInvalid)
		}
		before, after = existing, block
	}
	if len(currentByID) != 0 {
		return nil, nil, fmt.Errorf("%w: content commands cannot delete top-level blocks", materialdoc.ErrInvalid)
	}
	return before, after, nil
}

// applyAuthoritativeContentCommand replaces one stable top-level custom block
// in an initialized Y.Doc. It returns false when the room has not been
// initialized yet, allowing creation/bootstrap paths to keep using SQL.
func (s *Store) applyAuthoritativeContentCommand(
	ctx context.Context,
	materialID, currentRaw, desiredRaw string,
) (bool, error) {
	initialized, err := s.materialYjsInitialized(ctx, materialID)
	if err != nil || !initialized {
		return initialized, err
	}
	if s.collaborationURL == "" || s.collaborationSecret == "" {
		return true, ErrAuthorityUnavailable
	}
	current, err := materialdoc.Parse(currentRaw)
	if err != nil {
		return true, err
	}
	desired, err := materialdoc.Parse(desiredRaw)
	if err != nil {
		return true, err
	}
	expectedBlock, replacementBlock, err := changedStableBlock(current, desired)
	if err != nil {
		return true, err
	}
	if expectedBlock == nil {
		return true, nil
	}
	roomForCommand, err := s.MaterialRoom(ctx, materialID)
	if err != nil {
		return true, err
	}
	body, err := json.Marshal(replaceBlockCommand{
		Type: "replace-block", MaterialID: materialID,
		Room:          roomForCommand,
		ExpectedBlock: expectedBlock, ReplacementBlock: replacementBlock,
	})
	if err != nil {
		return true, err
	}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, s.collaborationURL+"/internal/commands", bytes.NewReader(body),
	)
	if err != nil {
		return true, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Collaboration-Secret", s.collaborationSecret)
	response, err := s.collaborationHTTP.Do(req)
	if err != nil {
		return true, fmt.Errorf("%w: %v", ErrAuthorityUnavailable, err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	switch response.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusConflict:
		return true, ErrConflict
	default:
		message := string(responseBody)
		if message == "" {
			message = response.Status
		}
		return true, fmt.Errorf("%w: %s", ErrAuthorityUnavailable, message)
	}
}

func isAuthorityUnavailable(err error) bool {
	return errors.Is(err, ErrAuthorityUnavailable)
}
