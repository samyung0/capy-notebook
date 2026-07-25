package materialdoc

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// SuggestionDecision is the server-side projection applied to Plate suggestion
// metadata. A projection can target specific Plate IDs or every pending ID.
type SuggestionDecision string

const (
	AcceptSuggestions SuggestionDecision = "accept"
	RejectSuggestions SuggestionDecision = "reject"
)

// SuggestionChange identifies one active Plate suggestion in one stable
// top-level block. Operation and preview data remain authoritative in Plate
// JSON and are intentionally not projected into lifecycle rows.
type SuggestionChange struct {
	PlateSuggestionID string
	BlockID           string
}

type suggestionMetadata struct {
	ID            string
	Operation     string
	Text          string
	NewText       string
	Properties    map[string]any
	NewProperties map[string]any
}

// ScanSuggestions walks both block-level `suggestion` metadata and inline
// `suggestion_<id>` marks, collecting each Plate ID/top-level-block pair once.
// Active suggestions require a stable top-level block ID. It intentionally
// does not trust metadata user IDs; authorship is derived from the
// authenticated commit actor by the store.
func ScanSuggestions(raw string) ([]SuggestionChange, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	type key struct {
		blockID string
		id      string
	}
	changes := map[key]*SuggestionChange{}
	for blockIndex, block := range doc.Value {
		blockID, _ := block["id"].(string)
		blockID = strings.TrimSpace(blockID)
		hasSuggestion := false
		walkSuggestionNodes(block, func(_ map[string]any, metadata suggestionMetadata) {
			if metadata.ID == "" {
				return
			}
			hasSuggestion = true
			if blockID == "" {
				return
			}
			k := key{blockID: blockID, id: metadata.ID}
			if changes[k] != nil {
				return
			}
			changes[k] = &SuggestionChange{
				PlateSuggestionID: metadata.ID,
				BlockID:           blockID,
			}
		})
		if hasSuggestion && blockID == "" {
			return nil, fmt.Errorf(
				"%w: top-level block %d with suggestion metadata requires a stable id",
				ErrInvalid,
				blockIndex,
			)
		}
	}
	out := make([]SuggestionChange, 0, len(changes))
	for _, change := range changes {
		out = append(out, *change)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].BlockID == out[j].BlockID {
			return out[i].PlateSuggestionID < out[j].PlateSuggestionID
		}
		return out[i].BlockID < out[j].BlockID
	})
	return out, nil
}

func HasPendingSuggestions(raw string) (bool, error) {
	changes, err := ScanSuggestions(raw)
	return len(changes) > 0, err
}

// RejectProjection strips every suggestion while projecting the document back
// to the shared clean base.
//
// SOURCE: This is the collaboration trust boundary, not merely a preview
// helper. A commenter sends the entire marked Plate document, so the store
// compares this reject projection with the reject projection of the locked
// current head. Equal projections prove that every submitted difference is
// represented by reviewable Plate metadata; comparing against the raw current
// head would incorrectly reject edits made on top of existing pending marks.
func RejectProjection(raw string) (string, error) {
	projected, _, _, err := ResolveSuggestions(raw, nil, RejectSuggestions)
	return projected, err
}

// ResolveSuggestions accepts/rejects selected Plate IDs. A nil or empty ID list
// resolves every pending suggestion. It returns the canonical document, the
// IDs actually found, and whether unresolved suggestion metadata remains.
func ResolveSuggestions(
	raw string,
	ids []string,
	decision SuggestionDecision,
) (string, []string, bool, error) {
	if decision != AcceptSuggestions && decision != RejectSuggestions {
		return "", nil, false, fmt.Errorf("%w: invalid suggestion decision", ErrInvalid)
	}
	doc, err := Parse(raw)
	if err != nil {
		return "", nil, false, err
	}
	selected := map[string]bool{}
	for _, id := range ids {
		if strings.TrimSpace(id) != "" {
			selected[id] = true
		}
	}
	all := len(selected) == 0
	resolved := map[string]bool{}
	value := make([]map[string]any, 0, len(doc.Value))
	for _, node := range doc.Value {
		if projected := resolveSuggestionNode(node, selected, all, decision, resolved); projected != nil {
			value = append(value, projected)
		}
	}
	if len(value) == 0 {
		value = []map[string]any{{
			"type":     "p",
			"children": []any{textLeaf("")},
		}}
	}
	doc.Value = value
	result, err := Marshal(doc)
	if err != nil {
		return "", nil, false, err
	}
	pending, err := HasPendingSuggestions(result)
	if err != nil {
		return "", nil, false, err
	}
	resolvedIDs := make([]string, 0, len(resolved))
	for id := range resolved {
		resolvedIDs = append(resolvedIDs, id)
	}
	sort.Strings(resolvedIDs)
	return result, resolvedIDs, pending, nil
}

func resolveSuggestionNode(
	node map[string]any,
	selected map[string]bool,
	all bool,
	decision SuggestionDecision,
	resolved map[string]bool,
) map[string]any {
	metadata := suggestionMetadataForNode(node)
	drop := false
	for key, suggestion := range metadata {
		if !all && !selected[suggestion.ID] {
			continue
		}
		resolved[suggestion.ID] = true
		switch normalizeSuggestionOperation(suggestion.Operation) {
		case "insert":
			drop = decision == RejectSuggestions
		case "remove":
			drop = decision == AcceptSuggestions
		case "update", "replace":
			applySuggestionUpdate(node, suggestion, decision)
		}
		delete(node, key)
	}
	if drop {
		return nil
	}
	if _, blockMetadata := node["suggestion"].(map[string]any); !blockMetadata {
		hasInline := false
		for key := range node {
			if strings.HasPrefix(key, "suggestion_") {
				hasInline = true
				break
			}
		}
		if !hasInline {
			delete(node, "suggestion")
		}
	}
	if _, text := node["text"].(string); text {
		return node
	}
	rawChildren, ok := node["children"].([]any)
	if !ok {
		return node
	}
	children := make([]any, 0, len(rawChildren))
	for _, rawChild := range rawChildren {
		child, ok := rawChild.(map[string]any)
		if !ok {
			continue
		}
		if projected := resolveSuggestionNode(child, selected, all, decision, resolved); projected != nil {
			children = append(children, projected)
		}
	}
	if len(children) == 0 {
		children = []any{textLeaf("")}
	}
	node["children"] = mergeAdjacentSuggestionLeaves(children)
	return node
}

func mergeAdjacentSuggestionLeaves(children []any) []any {
	merged := make([]any, 0, len(children))
	for _, child := range children {
		current, currentText := child.(map[string]any)
		text, hasCurrentText := current["text"].(string)
		if !currentText || !hasCurrentText || len(merged) == 0 {
			merged = append(merged, child)
			continue
		}
		previous, previousMap := merged[len(merged)-1].(map[string]any)
		previousText, hasPreviousText := previous["text"].(string)
		if !previousMap || !hasPreviousText || !sameSuggestionLeafProperties(previous, current) {
			merged = append(merged, child)
			continue
		}
		previous["text"] = previousText + text
	}
	return merged
}

func sameSuggestionLeafProperties(left, right map[string]any) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if key == "text" {
			continue
		}
		if !reflect.DeepEqual(value, right[key]) {
			return false
		}
	}
	return true
}

func suggestionMetadataForNode(node map[string]any) map[string]suggestionMetadata {
	out := map[string]suggestionMetadata{}
	if value, ok := node["suggestion"].(map[string]any); ok {
		if metadata := decodeSuggestionMetadata(value, ""); metadata.ID != "" {
			out["suggestion"] = metadata
		}
	}
	for key, raw := range node {
		if !strings.HasPrefix(key, "suggestion_") {
			continue
		}
		value, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if metadata := decodeSuggestionMetadata(value, strings.TrimPrefix(key, "suggestion_")); metadata.ID != "" {
			out[key] = metadata
		}
	}
	return out
}

func walkSuggestionNodes(node map[string]any, visit func(map[string]any, suggestionMetadata)) {
	for _, metadata := range suggestionMetadataForNode(node) {
		visit(node, metadata)
	}
	for _, child := range children(node) {
		walkSuggestionNodes(child, visit)
	}
}

func decodeSuggestionMetadata(value map[string]any, fallbackID string) suggestionMetadata {
	id, _ := value["id"].(string)
	if id == "" {
		id = fallbackID
	}
	operation, _ := value["type"].(string)
	text, _ := value["text"].(string)
	newText, _ := value["newText"].(string)
	properties, _ := value["properties"].(map[string]any)
	newProperties, _ := value["newProperties"].(map[string]any)
	return suggestionMetadata{
		ID: id, Operation: operation, Text: text, NewText: newText,
		Properties: properties, NewProperties: newProperties,
	}
}

func normalizeSuggestionOperation(operation string) string {
	switch operation {
	case "insert", "remove", "update", "replace":
		return operation
	default:
		return "update"
	}
}

func applySuggestionUpdate(node map[string]any, metadata suggestionMetadata, decision SuggestionDecision) {
	properties := metadata.NewProperties
	text := metadata.NewText
	if decision == RejectSuggestions {
		properties = metadata.Properties
		text = metadata.Text
	}
	for key := range metadata.Properties {
		if key != "children" && key != "suggestion" && !strings.HasPrefix(key, "suggestion_") {
			delete(node, key)
		}
	}
	for key := range metadata.NewProperties {
		if key != "children" && key != "suggestion" && !strings.HasPrefix(key, "suggestion_") {
			delete(node, key)
		}
	}
	for key, value := range properties {
		if key == "children" || key == "suggestion" || strings.HasPrefix(key, "suggestion_") {
			continue
		}
		if value == nil {
			delete(node, key)
		} else {
			node[key] = value
		}
	}
	if _, isText := node["text"]; isText && (metadata.Text != "" || metadata.NewText != "") {
		node["text"] = text
	}
}
