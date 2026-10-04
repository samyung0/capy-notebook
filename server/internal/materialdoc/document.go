// Package materialdoc owns the persisted Plate document contract used by
// materials. Generic Plate nodes remain open-ended; custom study nodes match
// src/features/materials/document.ts exactly.
package materialdoc

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

const (
	SchemaVersion    = 1
	MaxDocumentBytes = 2 << 20
	MaxDepth         = 16
	MaxNodes         = 10000
	// depthCeiling bounds recursion while decoding untrusted JSON. It is not a
	// product limit: MaxDepth gates writes only, so a document seeded outside
	// the write paths or predating a limit change stays readable.
	depthCeiling = 1024
)

var (
	ErrInvalid = errors.New("invalid material document")
	// ErrLimitExceeded marks a structurally valid document that breaches a
	// product cap. It satisfies errors.Is(err, ErrInvalid) so the request
	// mappings that already answer 400 for rejected writes keep working.
	ErrLimitExceeded = fmt.Errorf("%w: exceeds a document limit", ErrInvalid)
)

var (
	youtubeVideoID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
)

// Envelope is the generic versioned JSON value persisted in materials.content.
type Envelope struct {
	SchemaVersion int              `json:"schemaVersion"`
	Value         []map[string]any `json:"value"`
}

type DocumentMetrics struct {
	SizeBytes int
	NodeCount int
	MaxDepth  int
}

// LimitError reports the first product cap the document breaches. Only write
// paths call it. Reads deliberately do not, because refusing to decode an
// already-persisted document would hide content the user cannot otherwise
// reach, including the deletions needed to bring it back under the cap.
func (m DocumentMetrics) LimitError() error {
	switch {
	case m.SizeBytes > MaxDocumentBytes:
		return fmt.Errorf("%w: %d bytes over %d", ErrLimitExceeded, m.SizeBytes, MaxDocumentBytes)
	case m.NodeCount > MaxNodes:
		return fmt.Errorf("%w: %d nodes over %d", ErrLimitExceeded, m.NodeCount, MaxNodes)
	case m.MaxDepth > MaxDepth:
		return fmt.Errorf("%w: nesting depth %d over %d", ErrLimitExceeded, m.MaxDepth, MaxDepth)
	}
	return nil
}

// Card is the plain-text API projection of one authored flashcard. Scheduling
// state remains relational and is intentionally not part of the document.
type Card struct {
	ID    string `json:"id"`
	Front string `json:"front"`
	Back  string `json:"back"`
}

func Empty() Envelope {
	return Envelope{
		SchemaVersion: SchemaVersion,
		Value: []map[string]any{{
			"type":     "p",
			"id":       newID("block"),
			"children": []any{textLeaf("")},
		}},
	}
}

func marshalCanonicalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	// Match JSON.stringify for the two JavaScript line-separator characters
	// that encoding/json escapes even when HTML escaping is disabled.
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2028`), []byte("\u2028"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2029`), []byte("\u2029"))
	return encoded, nil
}

func Marshal(doc Envelope) (string, error) {
	raw, metrics, err := marshalValidated(doc)
	if err != nil {
		return "", err
	}
	if err := metrics.LimitError(); err != nil {
		return "", err
	}
	return raw, nil
}

// MarshalProjection canonicalizes structurally valid collaboration content
// without applying product caps. The sidecar already enforces those caps and
// permits valid shrink-only recovery for documents that start over a limit.
func MarshalProjection(doc Envelope) (string, error) {
	raw, _, err := marshalValidated(doc)
	return raw, err
}

func marshalValidated(doc Envelope) (string, DocumentMetrics, error) {
	if err := Validate(doc); err != nil {
		return "", DocumentMetrics{}, err
	}
	doc.Value = stripRuntimeCommentMarks(doc.Value)
	b, err := marshalCanonicalJSON(doc)
	if err != nil {
		return "", DocumentMetrics{}, err
	}
	return string(b), measure(b, doc.Value), nil
}

// Metrics validates a canonical document and returns the serialized size and
// shape metrics used by storage accounting and the editor properties view. The
// caps are not applied here; write paths pair this with metrics.LimitError.
func Metrics(raw string) (DocumentMetrics, error) {
	doc, err := Parse(raw)
	if err != nil {
		return DocumentMetrics{}, err
	}
	normalized := stripRuntimeCommentMarks(doc.Value)
	encoded, err := marshalCanonicalJSON(Envelope{
		SchemaVersion: doc.SchemaVersion,
		Value:         normalized,
	})
	if err != nil {
		return DocumentMetrics{}, err
	}
	return measure(encoded, normalized), nil
}

func measure(encoded []byte, nodes []map[string]any) DocumentMetrics {
	metrics := DocumentMetrics{SizeBytes: len(encoded)}
	for _, node := range nodes {
		measureNode(node, 0, &metrics)
	}
	return metrics
}

func measureNode(node map[string]any, depth int, metrics *DocumentMetrics) {
	metrics.NodeCount++
	if depth > metrics.MaxDepth {
		metrics.MaxDepth = depth
	}
	for _, child := range children(node) {
		measureNode(child, depth+1, metrics)
	}
}

func stripRuntimeCommentMarks(nodes []map[string]any) []map[string]any {
	result := make([]map[string]any, len(nodes))
	for index, node := range nodes {
		copyNode := make(map[string]any, len(node))
		isTextLeaf := node["text"] != nil
		for key, value := range node {
			if isTextLeaf && (key == "comment" || strings.HasPrefix(key, "comment_")) {
				continue
			}
			if key == "children" {
				if rawChildren, ok := value.([]any); ok {
					children := make([]map[string]any, 0, len(rawChildren))
					for _, rawChild := range rawChildren {
						if child, ok := rawChild.(map[string]any); ok {
							children = append(children, child)
						}
					}
					stripped := stripRuntimeCommentMarks(children)
					copiedChildren := make([]any, len(stripped))
					for childIndex, child := range stripped {
						copiedChildren[childIndex] = child
					}
					copyNode[key] = copiedChildren
					continue
				}
			}
			copyNode[key] = value
		}
		result[index] = copyNode
	}
	return result
}

// Parse decodes and structurally validates a stored document. It intentionally
// applies no size or shape cap: those gate writes, and a read that refuses to
// decode would turn an over-limit material into a blank page. Inbound request
// bodies are bounded by the HTTP layer, not here.
func Parse(raw string) (Envelope, error) {
	if len(raw) == 0 {
		return Envelope{}, fmt.Errorf("%w: document is empty", ErrInvalid)
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	var doc Envelope
	if err := dec.Decode(&doc); err != nil {
		return Envelope{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Envelope{}, fmt.Errorf("%w: trailing JSON", ErrInvalid)
	}
	if err := Validate(doc); err != nil {
		return Envelope{}, err
	}
	return doc, nil
}

func Validate(doc Envelope) error {
	if doc.SchemaVersion != SchemaVersion {
		return fmt.Errorf("%w: unsupported schemaVersion %d", ErrInvalid, doc.SchemaVersion)
	}
	if len(doc.Value) == 0 {
		return fmt.Errorf("%w: value must be a non-empty array", ErrInvalid)
	}
	for i, node := range doc.Value {
		if err := validateNode(node, 0); err != nil {
			return fmt.Errorf("%w: value[%d]: %v", ErrInvalid, i, err)
		}
	}
	var all []map[string]any
	var collect func(map[string]any)
	collect = func(node map[string]any) {
		if node["type"] == "quiz_question" {
			all = append(all, node["question"].(map[string]any))
		}
		for _, child := range children(node) {
			collect(child)
		}
	}
	for _, node := range doc.Value {
		collect(node)
	}
	if len(all) > fieldlimits.QuestionCount {
		return fmt.Errorf("%w: too many questions", ErrInvalid)
	}
	questionIDs, partIDs := map[string]bool{}, map[string]bool{}
	for _, q := range all {
		id := q["id"].(string)
		if questionIDs[id] {
			return fmt.Errorf("%w: duplicate question id", ErrInvalid)
		}
		questionIDs[id] = true
		for _, raw := range q["parts"].([]any) {
			id := raw.(map[string]any)["id"].(string)
			if partIDs[id] {
				return fmt.Errorf("%w: duplicate part id", ErrInvalid)
			}
			partIDs[id] = true
		}
	}

	return nil
}

// ValidateKind ensures artifact rows contain their canonical custom element.
func ValidateKind(raw, kind string) error {
	doc, err := Parse(raw)
	if err != nil {
		return err
	}
	if err := validateTopLevelBlockIDs(doc.Value); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	var valid bool
	switch kind {
	case "quiz":
		valid = find(doc.Value, "quiz") != nil
	case "flashcards":
		valid = find(doc.Value, "flashcards") != nil
	case "mindmap", "diagram":
		valid = find(doc.Value, "mermaid") != nil ||
			find(doc.Value, "diagram") != nil ||
			find(doc.Value, "mindmap") != nil
	case "note":
		return validateNoteReferences(doc.Value)
	default:
		return nil
	}
	if !valid {
		return fmt.Errorf("%w: %s element is required", ErrInvalid, kind)
	}
	if find(doc.Value, RefType) != nil {
		return fmt.Errorf("%w: %s cannot contain a material reference", ErrInvalid, kind)
	}
	return nil
}

// RefType is the void node a note stores for an embedded quiz or flashcard
// set. The referenced material row holds the content.
const RefType = "material_ref"

var refKinds = set("quiz", "flashcards")

// MaterialRef is one top-level reference node of a note.
type MaterialRef struct {
	ID         string
	MaterialID string
	Kind       string
}

// validateNoteReferences enforces the note contract: study blocks live in
// their own material rows, so inline quiz/flashcards nodes are rejected and a
// reference is only valid as a top-level block.
func validateNoteReferences(nodes []map[string]any) error {
	for _, inline := range []string{"quiz", "flashcards"} {
		if find(nodes, inline) != nil {
			return fmt.Errorf("%w: note cannot contain an inline %s block", ErrInvalid, inline)
		}
	}
	for index, node := range nodes {
		for _, child := range children(node) {
			if find([]map[string]any{child}, RefType) != nil {
				return fmt.Errorf("%w: value[%d]: material reference must be a top-level block", ErrInvalid, index)
			}
		}
	}
	return nil
}

func validateMaterialRef(node map[string]any) error {
	if err := requireID(node); err != nil {
		return err
	}
	// A fence imported as markdown is a pending reference until the editor
	// creates its row: no material id yet, the fence body in "pending".
	materialID, ok := node["materialId"].(string)
	if !ok {
		return errors.New("materialId is required")
	}
	if strings.TrimSpace(materialID) == "" {
		if pending, _ := node["pending"].(string); pending == "" {
			return errors.New("materialId is required")
		}
	}
	kind, ok := node["refKind"].(string)
	if !ok || !refKinds[kind] {
		return errors.New("refKind must be quiz or flashcards")
	}
	values := node["children"].([]any)
	if len(values) != 1 {
		return errors.New("material reference carries one empty text leaf")
	}
	leaf, _ := values[0].(map[string]any)
	if text, _ := leaf["text"].(string); text != "" {
		return errors.New("material reference carries one empty text leaf")
	}
	return nil
}

// MaterialRefNode builds the reference block a note stores for an embedded
// material.
func MaterialRefNode(materialID, kind string) map[string]any {
	return map[string]any{
		"type":       RefType,
		"id":         newID("block"),
		"materialId": materialID,
		"refKind":    kind,
		"children":   []any{textLeaf("")},
	}
}

// ExtractMaterialRefs lists the note's embedded material references in
// document order.
func ExtractMaterialRefs(raw string) ([]MaterialRef, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	refs := []MaterialRef{}
	for _, node := range doc.Value {
		if node["type"] != RefType {
			continue
		}
		materialID, _ := node["materialId"].(string)
		if materialID == "" {
			continue // pending, no row yet
		}
		id, _ := node["id"].(string)
		kind, _ := node["refKind"].(string)
		refs = append(refs, MaterialRef{ID: id, MaterialID: materialID, Kind: kind})
	}
	return refs, nil
}

// RewriteMaterialRefIDs points every reference whose material id is in ids at
// the mapped id, for clones. Unmapped references are left as they are.
func RewriteMaterialRefIDs(raw string, ids map[string]string) (string, error) {
	if len(ids) == 0 {
		return raw, nil
	}
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	for _, node := range doc.Value {
		if node["type"] != RefType {
			continue
		}
		if materialID, _ := node["materialId"].(string); ids[materialID] != "" {
			node["materialId"] = ids[materialID]
		}
	}
	return Marshal(doc)
}

func validateNode(node map[string]any, depth int) error {
	if depth > depthCeiling {
		return errors.New("document nesting is too deep to decode")
	}
	for key := range node {
		if key == "suggestion" || strings.HasPrefix(key, "suggestion_") {
			return fmt.Errorf("obsolete suggestion property %q is not allowed", key)
		}
	}
	if text, ok := node["text"]; ok {
		if _, ok := text.(string); !ok {
			return errors.New("text leaf must contain a string")
		}
		if _, hasChildren := node["children"]; hasChildren {
			return errors.New("text leaf cannot contain children")
		}
		return nil
	}
	typ, ok := node["type"].(string)
	if !ok || strings.TrimSpace(typ) == "" {
		return errors.New("element type is required")
	}
	children, ok := node["children"].([]any)
	if !ok || len(children) == 0 {
		return errors.New("element children must be a non-empty array")
	}
	for i, child := range children {
		m, ok := child.(map[string]any)
		if !ok {
			return fmt.Errorf("children[%d] must be an object", i)
		}
		if err := validateNode(m, depth+1); err != nil {
			return fmt.Errorf("children[%d]: %w", i, err)
		}
	}
	if !hasTextDescendant(node) {
		return errors.New("element must contain a text descendant")
	}
	switch typ {
	case "quiz":
		return validateQuiz(node)
	case "quiz_question":
		return validateQuizQuestion(node)
	case "chart", "graph":
		if depth != 0 {
			return errors.New("chart and graph embeds must be top-level blocks")
		}
		if err := requireID(node); err != nil {
			return err
		}
		leaf := children[0].(map[string]any)
		if len(children) != 1 || len(leaf) != 1 || leaf["text"] != "" {
			return errors.New("chart and graph embeds require one empty text leaf")
		}
		block, ok := node["block"].(map[string]any)
		if !ok || block["type"] != typ {
			return errors.New("embed block type must match node type")
		}
		for key := range node {
			if key != "type" && key != "id" && key != "block" && key != "children" {
				return fmt.Errorf("unexpected embed field %s", key)
			}
		}
		return questions.ValidateBlock(block, questions.Policy{})

	case "flashcard_front", "flashcard_back", "mermaid_caption":
		return validateTextElement(node)
	case "quiz_prompt", "quiz_option", "quiz_explanation":
		return errors.New("obsolete quiz child node")
	case "flashcards":
		return validateFlashcards(node)
	case "flashcard":
		return validateFlashcard(node)
	case "mermaid", "diagram", "mindmap":
		return validateDiagram(node)
	case "video":
		return validateYouTube(node)
	case RefType:
		return validateMaterialRef(node)
	}
	return nil
}

func validateYouTube(node map[string]any) error {
	if node["provider"] != "youtube" {
		return errors.New("video provider must be youtube")
	}
	videoID, ok := node["videoId"].(string)
	if !ok || !youtubeVideoID.MatchString(videoID) {
		return errors.New("videoId must be a valid YouTube video ID")
	}
	for _, key := range []string{"assetId", "url", "src"} {
		if _, exists := node[key]; exists {
			return fmt.Errorf("YouTube video cannot contain %s", key)
		}
	}
	return nil
}

func validateQuiz(node map[string]any) error {
	if err := rejectOpaque(node); err != nil {
		return err
	}
	if err := requireID(node); err != nil {
		return err
	}
	children := node["children"].([]any)
	if _, ok := node["timeLimitMin"]; ok {
		return errors.New("quiz time limits are no longer supported")
	}
	if len(children) == 1 {
		child := children[0].(map[string]any)
		if len(child) == 1 && child["text"] == "" {
			return nil
		}
	}
	ids := map[string]bool{}
	for i, value := range children {
		q := value.(map[string]any)
		if q["type"] != "quiz_question" {
			return fmt.Errorf("children[%d] must be a quiz_question", i)
		}
		id := q["id"].(string)
		if ids[id] {
			return fmt.Errorf("duplicate question id %q", id)
		}
		ids[id] = true
	}

	return nil
}

func validateQuizQuestion(node map[string]any) error {
	if err := rejectOpaque(node); err != nil {
		return err
	}
	if err := requireID(node); err != nil {
		return err
	}
	q, ok := node["question"].(map[string]any)
	if !ok {
		return errors.New("quiz_question requires question")
	}
	if err := questions.Validate(q, questions.Policy{}); err != nil {
		return err
	}
	if node["id"] != q["id"] {
		return errors.New("question id must match wrapper id")
	}
	for _, key := range []string{"questionType", "level", "points", "rubrics", "pairs", "acceptedAnswers", "hints", "correctOptionIds", "correctBoolean"} {
		if _, exists := node[key]; exists {
			return fmt.Errorf("obsolete quiz property %s", key)
		}
	}
	children := node["children"].([]any)
	if len(children) != 1 {
		return errors.New("quiz_question requires one void text child")
	}
	child := children[0].(map[string]any)
	if len(child) != 1 || child["text"] != "" {
		return errors.New("quiz_question requires one void text child")
	}
	return nil
}

func validateFlashcards(node map[string]any) error {
	if err := rejectOpaque(node); err != nil {
		return err
	}
	if err := requireID(node); err != nil {
		return err
	}
	ids := map[string]bool{}
	for i, value := range node["children"].([]any) {
		card := value.(map[string]any)
		if card["type"] != "flashcard" {
			return fmt.Errorf("children[%d] must be a flashcard", i)
		}
		id := card["id"].(string)
		if ids[id] {
			return fmt.Errorf("duplicate card id %q", id)
		}
		ids[id] = true
	}
	return nil
}

func validateFlashcard(node map[string]any) error {
	if err := rejectOpaque(node); err != nil {
		return err
	}
	if err := requireID(node); err != nil {
		return err
	}
	children := node["children"].([]any)
	if len(children) != 2 {
		return errors.New("flashcard requires front and back children")
	}
	if children[0].(map[string]any)["type"] != "flashcard_front" ||
		children[1].(map[string]any)["type"] != "flashcard_back" {
		return errors.New("flashcard children must be front then back")
	}
	return nil
}

func validateDiagram(node map[string]any) error {
	if err := rejectOpaque(node); err != nil {
		return err
	}
	if err := requireID(node); err != nil {
		return err
	}
	if _, ok := node["source"].(string); !ok {
		return errors.New("source must be a string")
	}
	children := node["children"].([]any)
	if len(children) != 1 || children[0].(map[string]any)["type"] != "mermaid_caption" {
		return errors.New("diagram requires one mermaid_caption child")
	}
	return nil
}

func validateTextElement(node map[string]any) error {
	for i, value := range node["children"].([]any) {
		if _, ok := value.(map[string]any)["text"].(string); !ok {
			return fmt.Errorf("children[%d] must be a text leaf", i)
		}
	}
	return nil
}

func rejectOpaque(node map[string]any) error {
	for _, key := range []string{"questions", "cards", "code"} {
		if _, ok := node[key]; ok {
			return fmt.Errorf("opaque %s property is not canonical", key)
		}
	}
	return nil
}

func requireID(node map[string]any) error {
	id, ok := node["id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		return errors.New("id is required")
	}
	return nil
}

func number(value any) (float64, bool) {
	switch v := value.(type) {
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	default:
		return 0, false
	}
}

func integer(value any) (int64, bool) {
	switch value := value.(type) {
	case json.Number:
		n, err := value.Int64()
		return n, err == nil
	case float64:
		n := int64(value)
		return n, float64(n) == value
	case int:
		return int64(value), true
	case int64:
		return value, true
	default:
		return 0, false
	}
}

func QuizDocument(questions json.RawMessage, timeLimit *int) (string, error) {
	values, err := decodeArray(questions)
	if err != nil {
		return "", err
	}
	children := make([]any, len(values))
	for i, value := range values {
		question, ok := value.(map[string]any)
		if !ok {
			return "", fmt.Errorf("%w: questions[%d] must be an object", ErrInvalid, i)
		}
		children[i], err = quizQuestionNode(question)
		if err != nil {
			return "", fmt.Errorf("%w: questions[%d]: %v", ErrInvalid, i, err)
		}
	}
	if len(children) == 0 {
		children = []any{textLeaf("")}
	}
	node := map[string]any{
		"type":     "quiz",
		"id":       newID("quiz"),
		"children": children,
	}

	return Marshal(artifactDocument(node))
}

func quizQuestionNode(question map[string]any) (map[string]any, error) {
	if err := questions.Validate(question, questions.Policy{}); err != nil {
		return nil, err
	}
	return map[string]any{"type": "quiz_question", "id": question["id"], "question": question, "children": []any{textLeaf("")}}, nil
}

func FlashcardsDocument(cards []Card) (string, error) {
	if len(cards) == 0 {
		cards = []Card{{ID: newID("card")}}
	}
	children := make([]any, len(cards))
	for i, card := range cards {
		if strings.TrimSpace(card.ID) == "" {
			return "", fmt.Errorf("%w: cards[%d].id is required", ErrInvalid, i)
		}
		children[i] = cardNode(card)
	}
	return Marshal(artifactDocument(map[string]any{
		"type":     "flashcards",
		"id":       newID("flashcards"),
		"children": children,
	}))
}

func MermaidDocument(source, caption string) (string, error) {
	return Marshal(artifactDocument(map[string]any{
		"type":   "mermaid",
		"id":     newID("mermaid"),
		"source": source,
		"children": []any{
			textElement("mermaid_caption", caption),
		},
	}))
}

func artifactDocument(node map[string]any) Envelope {
	return Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{node}}
}

func validateTopLevelBlockIDs(nodes []map[string]any) error {
	seen := make(map[string]bool, len(nodes))
	for index, node := range nodes {
		id, ok := node["id"].(string)
		id = strings.TrimSpace(id)
		if !ok || id == "" {
			return fmt.Errorf("value[%d].id is required", index)
		}
		if seen[id] {
			return fmt.Errorf("value[%d].id %q is duplicated", index, id)
		}
		seen[id] = true
	}
	return nil
}

func ExtractQuiz(raw string) (json.RawMessage, *int, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, nil, err
	}
	node := find(doc.Value, "quiz")
	if node == nil {
		return json.RawMessage("[]"), nil, nil
	}
	values := make([]any, 0, len(node["children"].([]any)))
	for _, value := range node["children"].([]any) {
		if q, ok := value.(map[string]any)["question"]; ok {
			values = append(values, q)
		}
	}
	b, err := json.Marshal(values)
	if err != nil {
		return nil, nil, err
	}
	return b, nil, nil
}

func ExtractFlashcards(raw string) ([]Card, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	node := find(doc.Value, "flashcards")
	if node == nil {
		return []Card{}, nil
	}
	values := node["children"].([]any)
	cards := make([]Card, len(values))
	for i, value := range values {
		card := value.(map[string]any)
		cards[i] = Card{
			ID:    card["id"].(string),
			Front: nodeText(firstChild(card, "flashcard_front")),
			Back:  nodeText(firstChild(card, "flashcard_back")),
		}
	}
	return cards, nil
}

func ExtractNoteText(raw string) (string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	var text strings.Builder
	for _, node := range doc.Value {
		text.WriteString(nodeText(node))
	}
	return text.String(), nil
}

// ExtractIndexText renders a note as markdown-like plain text for retrieval
// chunking: headings keep their level, list items their bullets, table rows
// their cells and code its fence. References, diagrams and media carry no
// text and are skipped.
func ExtractIndexText(raw string) (string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	var blocks []string
	for _, node := range doc.Value {
		writeIndexBlock(node, &blocks)
	}
	return strings.Join(blocks, "\n\n"), nil
}

var (
	indexContainers = set("callout", "column_group", "column", "toggle", "details")
	indexSkipped    = set("hr", "toc", "equation", "inline_equation", "img", "image", "audio", "file",
		"video", "mermaid", "diagram", "mindmap", RefType, "quiz", "flashcards")
)

func writeIndexBlock(node map[string]any, out *[]string) {
	typ, _ := node["type"].(string)
	switch {
	case typ == "chart" || typ == "graph":
		key := "title"
		if typ == "graph" {
			key = "description"
		}
		block, _ := node["block"].(map[string]any)
		if text, ok := block[key].(string); ok && strings.TrimSpace(text) != "" {
			*out = append(*out, text)
		}
		return
	case indexSkipped[typ]:
		return
	case indexContainers[typ]:
		for _, child := range children(node) {
			writeIndexBlock(child, out)
		}
		return
	case typ == "table":
		var rows []string
		for _, tr := range children(node) {
			var cells []string
			for _, td := range children(tr) {
				cells = append(cells, strings.TrimSpace(nodeText(td)))
			}
			if len(cells) > 0 {
				rows = append(rows, "| "+strings.Join(cells, " | ")+" |")
			}
		}
		if len(rows) > 0 {
			*out = append(*out, strings.Join(rows, "\n"))
		}
		return
	case typ == "code_block":
		var lines []string
		for _, line := range children(node) {
			lines = append(lines, nodeText(line))
		}
		lang, _ := node["lang"].(string)
		*out = append(*out, "```"+lang+"\n"+strings.Join(lines, "\n")+"\n```")
		return
	}
	text := strings.TrimSpace(nodeText(node))
	if text == "" {
		return
	}
	switch {
	case len(typ) == 2 && typ[0] == 'h' && typ[1] >= '1' && typ[1] <= '6':
		text = strings.Repeat("#", int(typ[1]-'0')) + " " + text
	case typ == "blockquote":
		text = "> " + text
	case typ == "p":
		if style, _ := node["listStyleType"].(string); style != "" {
			indent := 0
			if n, ok := number(node["indent"]); ok && n > 1 {
				indent = int(n) - 1
			}
			prefix := "- "
			switch style {
			case "decimal":
				prefix = "1. "
			case "todo":
				prefix = "- [ ] "
				if checked, _ := node["checked"].(bool); checked {
					prefix = "- [x] "
				}
			}
			text = strings.Repeat("  ", indent) + prefix + text
		}
	}
	*out = append(*out, text)
}

func IncomingNoteText(content string) string {
	if text, err := ExtractNoteText(content); err == nil {
		return text
	}
	return content
}

func ExtractMermaidSource(raw string) (string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	node := find(doc.Value, "mermaid")
	if node == nil {
		return "", fmt.Errorf("%w: mermaid element is required", ErrInvalid)
	}
	source, _ := node["source"].(string)
	return source, nil
}

func IncomingMermaidSource(content string) string {
	if source, err := ExtractMermaidSource(content); err == nil {
		return source
	}
	return fenced(content, "mermaid")
}

func ReplaceQuiz(raw string, questions json.RawMessage, timeLimit *int) (string, error) {
	replacement, err := QuizDocument(questions, timeLimit)
	if err != nil {
		return "", err
	}
	return replaceCustom(raw, replacement, "quiz", func(map[string]any, map[string]any) {})
}

func ReplaceFlashcards(raw string, cards []Card) (string, error) {
	replacement, err := FlashcardsDocument(cards)
	if err != nil {
		return "", err
	}
	return replaceCustom(raw, replacement, "flashcards", preserveFlashcardText)
}

// RewriteFlashcardIDs re-keys cards in place, preserving all rich-text leaves
// and marks. idMap makes the mapping stable across cloned revision history.
func RewriteFlashcardIDs(raw string, idMap map[string]string, mint func() string) (string, []string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", nil, err
	}
	node := find(doc.Value, "flashcards")
	if node == nil {
		return "", nil, fmt.Errorf("%w: flashcards element is required", ErrInvalid)
	}
	if idMap == nil {
		idMap = map[string]string{}
	}
	ids := make([]string, 0, len(node["children"].([]any)))
	seen := map[string]bool{}
	for _, value := range node["children"].([]any) {
		card := value.(map[string]any)
		oldID := card["id"].(string)
		newID := idMap[oldID]
		if newID == "" {
			newID = mint()
			if strings.TrimSpace(newID) == "" {
				return "", nil, errors.New("mint returned an empty card id")
			}
			idMap[oldID] = newID
		}
		if seen[newID] {
			return "", nil, fmt.Errorf("duplicate rewritten card id %q", newID)
		}
		seen[newID] = true
		card["id"] = newID
		ids = append(ids, newID)
	}
	result, err := Marshal(doc)
	return result, ids, err
}

// EditorAssetIDs returns the distinct editor assets referenced anywhere in a
// Plate document. Cloning uses this to copy only media that the retained
// current content or revision history can actually render.
func EditorAssetIDs(raw string) ([]string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	var collect func(map[string]any)
	collect = func(node map[string]any) {
		if assetID, ok := node["assetId"].(string); ok && assetID != "" {
			seen[assetID] = struct{}{}
		}
		if q, ok := node["question"].(map[string]any); ok && node["type"] == "quiz_question" {
			for _, assetID := range questions.AssetIDs(q) {
				seen[assetID] = struct{}{}
			}
		}
		for _, child := range children(node) {
			collect(child)
		}
	}
	for _, node := range doc.Value {
		collect(node)
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids, nil
}

// RewriteClonedEditorAssetIDs rewrites references to ready editor assets and
// removes media nodes and quiz images whose source asset was not copied (and a
// question whose part loses all content). A clone never carries pending or
// failed asset rows, so preserving those references would create a document
// that can never render successfully.
func RewriteClonedEditorAssetIDs(raw string, idMap map[string]string) (string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	var rewrite func(map[string]any) (map[string]any, bool)
	rewrite = func(node map[string]any) (map[string]any, bool) {
		if q, ok := node["question"].(map[string]any); ok && node["type"] == "quiz_question" && !questions.RewriteAssetIDs(q, idMap) {
			return nil, false
		}
		if assetID, ok := node["assetId"].(string); ok {
			replacement := idMap[assetID]
			if replacement == "" {
				return nil, false
			}
			node["assetId"] = replacement
		}
		rawChildren, ok := node["children"].([]any)
		if !ok {
			return node, true
		}
		kept := make([]any, 0, len(rawChildren))
		for _, rawChild := range rawChildren {
			child, ok := rawChild.(map[string]any)
			if !ok {
				continue
			}
			if rewritten, keep := rewrite(child); keep {
				kept = append(kept, rewritten)
			}
		}
		if len(kept) == 0 {
			kept = []any{textLeaf("")}
		}
		node["children"] = kept
		return node, true
	}
	kept := make([]map[string]any, 0, len(doc.Value))
	for _, node := range doc.Value {
		if rewritten, keep := rewrite(node); keep {
			kept = append(kept, rewritten)
		}
	}
	if len(kept) == 0 {
		doc.Value = Empty().Value
	} else {
		doc.Value = kept
	}
	return Marshal(doc)
}

func replaceCustom(raw, replacement, typ string, preserve func(map[string]any, map[string]any)) (string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	repl, err := Parse(replacement)
	if err != nil {
		return "", err
	}
	custom := find(repl.Value, typ)
	if current := find(doc.Value, typ); current != nil {
		custom["id"] = current["id"]
		preserve(current, custom)
	}
	if !replace(doc.Value, typ, custom) {
		doc.Value = append(doc.Value, custom)
	}
	return Marshal(doc)
}

func preserveFlashcardText(current, replacement map[string]any) {
	oldCards := byID(current["children"].([]any))
	for _, raw := range replacement["children"].([]any) {
		card := raw.(map[string]any)
		if old := oldCards[card["id"].(string)]; old != nil {
			preserveMatchingText(old, card, "flashcard_front")
			preserveMatchingText(old, card, "flashcard_back")
		}
	}
}

func preserveMatchingText(current, replacement map[string]any, typ string) {
	oldChild := firstChild(current, typ)
	newChild := firstChild(replacement, typ)
	if oldChild != nil && newChild != nil && nodeText(oldChild) == nodeText(newChild) {
		newChild["children"] = oldChild["children"]
	}
}

func find(nodes []map[string]any, typ string) map[string]any {
	for _, node := range nodes {
		if node["type"] == typ {
			return node
		}
		for _, child := range children(node) {
			if found := find([]map[string]any{child}, typ); found != nil {
				return found
			}
		}
	}
	return nil
}

func replace(nodes []map[string]any, typ string, replacement map[string]any) bool {
	for i, node := range nodes {
		if node["type"] == typ {
			nodes[i] = replacement
			return true
		}
		values, ok := node["children"].([]any)
		if !ok {
			continue
		}
		for j, raw := range values {
			child, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if child["type"] == typ {
				values[j] = replacement
				return true
			}
			if replaceInNode(child, typ, replacement) {
				return true
			}
		}
	}
	return false
}

func replaceInNode(node map[string]any, typ string, replacement map[string]any) bool {
	values, ok := node["children"].([]any)
	if !ok {
		return false
	}
	for i, raw := range values {
		child, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if child["type"] == typ {
			values[i] = replacement
			return true
		}
		if replaceInNode(child, typ, replacement) {
			return true
		}
	}
	return false
}

// FromLegacyMarkdown is only used at generator boundaries that still produce
// markdown. Persisted diagram-like artifacts always use canonical mermaid
// source and an annotatable caption child.
func FromLegacyMarkdown(kind, markdown string) (string, error) {
	if parsed, err := Parse(markdown); err == nil {
		return Marshal(parsed)
	}
	if kind == "mindmap" || kind == "diagram" {
		return MermaidDocument(fenced(markdown, "mermaid"), "")
	}
	doc := Empty()
	doc.Value[0]["children"] = []any{textLeaf(markdown)}
	return Marshal(doc)
}

func fenced(content, lang string) string {
	open := "```" + lang
	start := strings.Index(content, open)
	if start < 0 {
		return content
	}
	body := content[start+len(open):]
	body = strings.TrimPrefix(body, "\r\n")
	body = strings.TrimPrefix(body, "\n")
	if end := strings.Index(body, "```"); end >= 0 {
		body = body[:end]
	}
	return strings.TrimSpace(body)
}

func decodeArray(raw json.RawMessage) ([]any, error) {
	if len(raw) == 0 {
		return []any{}, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var values []any
	if err := dec.Decode(&values); err != nil {
		return nil, err
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON")
	}
	if values == nil {
		values = []any{}
	}
	return values, nil
}

func stringArray(value any) ([]string, bool) {
	raw, ok := value.([]any)
	if !ok {
		if typed, ok := value.([]string); ok {
			return typed, true
		}
		return nil, false
	}
	values := make([]string, len(raw))
	for i, item := range raw {
		values[i], ok = item.(string)
		if !ok {
			return nil, false
		}
	}
	return values, true
}

func textLeaf(text string) map[string]any {
	return map[string]any{"text": text}
}

func textElement(typ, text string) map[string]any {
	return map[string]any{"type": typ, "children": []any{textLeaf(text)}}
}

func cardNode(card Card) map[string]any {
	return map[string]any{
		"type": "flashcard",
		"id":   card.ID,
		"children": []any{
			textElement("flashcard_front", card.Front),
			textElement("flashcard_back", card.Back),
		},
	}
}

func nodeText(node map[string]any) string {
	if node == nil {
		return ""
	}
	if text, ok := node["text"].(string); ok {
		return text
	}
	var result strings.Builder
	for _, child := range children(node) {
		result.WriteString(nodeText(child))
	}
	return result.String()
}

func hasTextDescendant(node map[string]any) bool {
	if _, ok := node["text"].(string); ok {
		return true
	}
	for _, child := range children(node) {
		if hasTextDescendant(child) {
			return true
		}
	}
	return false
}

func children(node map[string]any) []map[string]any {
	raw, _ := node["children"].([]any)
	values := make([]map[string]any, 0, len(raw))
	for _, value := range raw {
		if child, ok := value.(map[string]any); ok {
			values = append(values, child)
		}
	}
	return values
}

func firstChild(node map[string]any, typ string) map[string]any {
	for _, child := range children(node) {
		if child["type"] == typ {
			return child
		}
	}
	return nil
}

func childrenOfType(node map[string]any, typ string) []map[string]any {
	values := []map[string]any{}
	for _, child := range children(node) {
		if child["type"] == typ {
			values = append(values, child)
		}
	}
	return values
}

func childrenAnyOfType(node map[string]any, typ string) []any {
	values := childrenOfType(node, typ)
	out := make([]any, len(values))
	for i := range values {
		out[i] = values[i]
	}
	return out
}

func byID(values []any) map[string]map[string]any {
	result := map[string]map[string]any{}
	for _, raw := range values {
		value, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if id, ok := value["id"].(string); ok {
			result[id] = value
		}
	}
	return result
}

func newID(prefix string) string {
	value := make([]byte, 5)
	_, _ = rand.Read(value)
	return prefix + "_" + hex.EncodeToString(value)
}

func set(values ...string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

// ParagraphNode builds one plain paragraph block with a fresh stable id, for
// direct edits that insert text blocks.
func ParagraphNode(text string) map[string]any {
	node := textElement("p", text)
	node["id"] = newID("p")
	return node
}

// CardNode builds the Plate node of one flashcard; an empty id mints one.
func CardNode(card Card) map[string]any {
	if strings.TrimSpace(card.ID) == "" {
		card.ID = newID("c")
	}
	return cardNode(card)
}

// QuizQuestionNode converts one API-shaped question into its Plate node; a
// missing id is minted so a direct edit can add questions.
func QuizQuestionNode(question map[string]any) (map[string]any, error) {
	if id, _ := question["id"].(string); strings.TrimSpace(id) == "" {
		question["id"] = newID("q")
	}
	return quizQuestionNode(question)
}
