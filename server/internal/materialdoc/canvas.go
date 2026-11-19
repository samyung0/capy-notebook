package materialdoc

import (
	"encoding/json"
	"fmt"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

// CanvasBoardType is the one block a canvas material's document holds. The
// board itself lives in the canvas's collaboration room (Epo 2026-11-18); the
// room's projection sends this block with the stored version it projected and
// the images on the board, so the asset pruner keeps them.
const CanvasBoardType = "canvas_board"

// CanvasBoardID is the block's id, the same in every canvas: the room sends
// it too, so a projection replaces the block and never adds a second.
const CanvasBoardID = "board"

// CanvasBoard is a canvas document's one block, read back.
type CanvasBoard struct {
	// Version is the room's stored version at its last projection; 0 until
	// the first.
	Version int64 `json:"version"`
	// ImageAssetIDs are the pictures on the board, as image editor assets.
	ImageAssetIDs []string `json:"imageAssetIds"`
}

// CanvasDocument is the stored document for a canvas board.
func CanvasDocument(board CanvasBoard) (string, error) {
	images := make([]any, 0, len(board.ImageAssetIDs))
	for _, id := range board.ImageAssetIDs {
		images = append(images, map[string]any{"assetId": id})
	}
	node := map[string]any{
		"type":     CanvasBoardType,
		"id":       CanvasBoardID,
		"children": []any{textLeaf("")},
		"version":  board.Version,
		"images":   images,
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
