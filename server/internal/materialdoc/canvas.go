package materialdoc

import (
	"encoding/json"
	"fmt"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

// CanvasBoardType is the one block a canvas material's document holds: where
// its saved board is (the material's own `board` editor asset), the save's
// version, and the images on the canvas, so the asset pruner keeps them all
// (Epo 2026-11-09, todo-workspace-canvas-storage.md).
const CanvasBoardType = "canvas_board"

// CanvasBoard is a canvas document's one block, read back.
type CanvasBoard struct {
	// BoardAssetID is empty until the first save.
	BoardAssetID string `json:"boardAssetId"`
	// Version counts the saves; the browser sends the one it read, and a
	// stale one is refused (ErrConflict through the material's revision).
	Version int64 `json:"version"`
	// ImageAssetIDs are the pictures on the canvas, as image editor assets.
	ImageAssetIDs []string `json:"imageAssetIds"`
}

// CanvasDocument is the stored document for a canvas board.
func CanvasDocument(board CanvasBoard) (string, error) {
	images := make([]any, 0, len(board.ImageAssetIDs))
	for _, id := range board.ImageAssetIDs {
		images = append(images, map[string]any{"assetId": id})
	}
	node := map[string]any{
		"type":         CanvasBoardType,
		"id":           newID("block"),
		"children":     []any{textLeaf("")},
		"boardAssetId": board.BoardAssetID,
		"version":      board.Version,
		"images":       images,
	}
	return Marshal(Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{node}})
}

// ReadCanvasBoard reads a canvas material's block.
func ReadCanvasBoard(raw string) (CanvasBoard, error) {
	doc, err := Parse(raw)
	if err != nil {
		return CanvasBoard{}, err
	}
	if len(doc.Value) != 1 || doc.Value[0]["type"] != CanvasBoardType {
		return CanvasBoard{}, fmt.Errorf("%w: a %s document holds one %s block", ErrInvalid, embeds.Canvas, CanvasBoardType)
	}
	node := doc.Value[0]
	out := CanvasBoard{ImageAssetIDs: []string{}}
	out.BoardAssetID, _ = node["boardAssetId"].(string)
	switch v := node["version"].(type) {
	case json.Number:
		out.Version, _ = v.Int64()
	case float64:
		out.Version = int64(v)
	case int64:
		out.Version = v
	case int:
		out.Version = int64(v)
	}
	if images, ok := node["images"].([]any); ok {
		for _, image := range images {
			if m, ok := image.(map[string]any); ok {
				if id, ok := m["assetId"].(string); ok && id != "" {
					out.ImageAssetIDs = append(out.ImageAssetIDs, id)
				}
			}
		}
	}
	return out, nil
}
