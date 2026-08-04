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
)

const (
	SchemaVersion    = 1
	MaxDocumentBytes = 2 << 20
	MaxDepth         = 16
	MaxNodes         = 10000
	maxDocument      = MaxDocumentBytes
	maxDepth         = MaxDepth
	maxNodes         = MaxNodes
)

var ErrInvalid = errors.New("invalid material document")

var (
	questionTypes   = set("mcq", "multi", "boolean", "fill", "short", "matching", "ordering")
	cognitiveLevels = set("recall", "application", "analysis")
	youtubeVideoID  = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
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
	if err := Validate(doc); err != nil {
		return "", err
	}
	doc.Value = stripRuntimeCommentMarks(doc.Value)
	b, err := marshalCanonicalJSON(doc)
	if err == nil && len(b) > maxDocument {
		return "", fmt.Errorf("%w: document size", ErrInvalid)
	}
	return string(b), err
}

// Metrics validates a canonical document and returns the serialized size and
// shape metrics used by storage accounting and the editor properties view.
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
	metrics := DocumentMetrics{SizeBytes: len(encoded)}
	for _, node := range normalized {
		measureNode(node, 0, &metrics)
	}
	return metrics, nil
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

func Parse(raw string) (Envelope, error) {
	if len(raw) == 0 || len(raw) > maxDocument {
		return Envelope{}, fmt.Errorf("%w: document size", ErrInvalid)
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
	count := 0
	for i, node := range doc.Value {
		if err := validateNode(node, 0, &count); err != nil {
			return fmt.Errorf("%w: value[%d]: %v", ErrInvalid, i, err)
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
	default:
		return nil
	}
	if !valid {
		return fmt.Errorf("%w: %s element is required", ErrInvalid, kind)
	}
	return nil
}

func validateNode(node map[string]any, depth int, count *int) error {
	*count++
	if depth > maxDepth || *count > maxNodes {
		return errors.New("document complexity limit exceeded")
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
		if err := validateNode(m, depth+1, count); err != nil {
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
	case "quiz_prompt", "quiz_explanation", "flashcard_front", "flashcard_back", "mermaid_caption":
		return validateTextElement(node)
	case "quiz_option":
		if err := requireID(node); err != nil {
			return err
		}
		return validateTextElement(node)
	case "flashcards":
		return validateFlashcards(node)
	case "flashcard":
		return validateFlashcard(node)
	case "mermaid", "diagram", "mindmap":
		return validateDiagram(node)
	case "video":
		return validateYouTube(node)
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
	if value, ok := node["timeLimitMin"]; ok {
		v, ok := integer(value)
		if !ok || v <= 0 {
			return errors.New("timeLimitMin must be a positive integer")
		}
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
	questionType, ok := node["questionType"].(string)
	if !ok || !questionTypes[questionType] {
		return errors.New("questionType is invalid")
	}
	level, ok := node["level"].(string)
	if !ok || !cognitiveLevels[level] {
		return errors.New("level is invalid")
	}
	prompts := 0
	optionIDs := map[string]bool{}
	for i, value := range node["children"].([]any) {
		child := value.(map[string]any)
		switch child["type"] {
		case "quiz_prompt":
			prompts++
		case "quiz_option":
			id := child["id"].(string)
			if optionIDs[id] {
				return fmt.Errorf("duplicate option id %q", id)
			}
			optionIDs[id] = true
		case "quiz_explanation":
		default:
			return fmt.Errorf("children[%d] has invalid quiz child type", i)
		}
	}
	if prompts == 0 {
		return errors.New("quiz_question requires a quiz_prompt")
	}
	if value, ok := node["correctOptionIds"]; ok {
		ids, ok := stringArray(value)
		if !ok {
			return errors.New("correctOptionIds must be a string array")
		}
		for _, id := range ids {
			if !optionIDs[id] {
				return fmt.Errorf("correctOptionIds references unknown option %q", id)
			}
		}
	}
	if value, ok := node["correctBoolean"]; ok {
		if _, ok := value.(bool); !ok {
			return errors.New("correctBoolean must be a boolean")
		}
	}
	if value, ok := node["acceptedAnswers"]; ok {
		if _, ok := stringArray(value); !ok {
			return errors.New("acceptedAnswers must be a string array")
		}
	}
	if value, ok := node["pairs"]; ok {
		pairs, ok := value.([]any)
		if !ok {
			return errors.New("pairs must be an array")
		}
		for i, raw := range pairs {
			pair, ok := raw.(map[string]any)
			if !ok {
				return fmt.Errorf("pairs[%d] must be an object", i)
			}
			if _, ok := pair["left"].(string); !ok {
				return fmt.Errorf("pairs[%d].left must be a string", i)
			}
			if _, ok := pair["right"].(string); !ok {
				return fmt.Errorf("pairs[%d].right must be a string", i)
			}
		}
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

func QuizDocument(title string, questions json.RawMessage, timeLimit *int) (string, error) {
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
		return "", fmt.Errorf("%w: quiz requires at least one question", ErrInvalid)
	}
	node := map[string]any{
		"type":     "quiz",
		"id":       newID("quiz"),
		"children": children,
	}
	if timeLimit != nil {
		node["timeLimitMin"] = *timeLimit
	}
	return Marshal(artifactDocument(title, node))
}

func quizQuestionNode(question map[string]any) (map[string]any, error) {
	id, ok := question["id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		return nil, errors.New("id is required")
	}
	questionType, ok := question["type"].(string)
	if !ok || !questionTypes[questionType] {
		return nil, errors.New("type is invalid")
	}
	level, ok := question["level"].(string)
	if !ok || !cognitiveLevels[level] {
		return nil, errors.New("level is invalid")
	}
	prompt, ok := question["prompt"].(string)
	if !ok {
		return nil, errors.New("prompt must be a string")
	}
	children := []any{textElement("quiz_prompt", prompt)}
	node := map[string]any{
		"type":         "quiz_question",
		"id":           id,
		"questionType": questionType,
		"level":        level,
	}
	switch questionType {
	case "mcq", "multi":
		options, err := objectArray(question["options"], "options")
		if err != nil {
			return nil, err
		}
		optionIDs := make([]string, len(options))
		for i, option := range options {
			value, ok := option["value"].(string)
			if !ok {
				return nil, fmt.Errorf("options[%d].value must be a string", i)
			}
			optionID := fmt.Sprintf("%s:option:%d", id, i+1)
			optionIDs[i] = optionID
			child := textElement("quiz_option", value)
			child["id"] = optionID
			if explanation, ok := option["explanation"].(string); ok {
				child["explanation"] = explanation
			}
			children = append(children, child)
		}
		correct, err := indexArray(question["correct"])
		if err != nil {
			return nil, err
		}
		correctIDs := make([]any, 0, len(correct))
		for _, index := range correct {
			if index < 0 || index >= len(optionIDs) {
				return nil, errors.New("correct index is out of range")
			}
			correctIDs = append(correctIDs, optionIDs[index])
		}
		if len(correctIDs) > 0 {
			node["correctOptionIds"] = correctIDs
		}
	case "boolean":
		correct, ok := question["correct"].(bool)
		if !ok {
			return nil, errors.New("correct must be a boolean")
		}
		for i, value := range []string{"True", "False"} {
			child := textElement("quiz_option", value)
			child["id"] = fmt.Sprintf("%s:option:%d", id, i+1)
			children = append(children, child)
		}
		node["correctBoolean"] = correct
		if correct {
			node["correctOptionIds"] = []any{fmt.Sprintf("%s:option:1", id)}
		} else {
			node["correctOptionIds"] = []any{fmt.Sprintf("%s:option:2", id)}
		}
	case "fill", "short":
		accepted, err := objectArray(question["accepted"], "accepted")
		if err != nil {
			return nil, err
		}
		answers := make([]any, len(accepted))
		for i, answer := range accepted {
			value, ok := answer["value"].(string)
			if !ok {
				return nil, fmt.Errorf("accepted[%d].value must be a string", i)
			}
			answers[i] = value
			child := textElement("quiz_option", value)
			child["id"] = fmt.Sprintf("%s:option:%d", id, i+1)
			child["role"] = "accepted-answer"
			children = append(children, child)
		}
		node["acceptedAnswers"] = answers
	case "matching":
		pairs, err := objectArray(question["pairs"], "pairs")
		if err != nil {
			return nil, err
		}
		values := make([]any, len(pairs))
		for i, pair := range pairs {
			left, leftOK := pair["left"].(string)
			right, rightOK := pair["right"].(string)
			if !leftOK || !rightOK {
				return nil, fmt.Errorf("pairs[%d] requires string left and right", i)
			}
			values[i] = map[string]any{"left": left, "right": right}
			child := textElement("quiz_option", left+" → "+right)
			child["id"] = fmt.Sprintf("%s:option:%d", id, i+1)
			child["role"] = "matching-pair"
			children = append(children, child)
		}
		node["pairs"] = values
	case "ordering":
		items, err := objectArray(question["items"], "items")
		if err != nil {
			return nil, err
		}
		for i, item := range items {
			value, ok := item["value"].(string)
			if !ok {
				return nil, fmt.Errorf("items[%d].value must be a string", i)
			}
			child := textElement("quiz_option", value)
			child["id"] = fmt.Sprintf("%s:option:%d", id, i+1)
			child["role"] = "ordering-item"
			children = append(children, child)
		}
	}
	if explanation, ok := question["explanation"].(string); ok && explanation != "" {
		children = append(children, textElement("quiz_explanation", explanation))
	}
	node["children"] = children
	return node, nil
}

func FlashcardsDocument(title string, cards []Card) (string, error) {
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
	return Marshal(artifactDocument(title, map[string]any{
		"type":     "flashcards",
		"id":       newID("flashcards"),
		"children": children,
	}))
}

func MermaidDocument(title, source, caption string) (string, error) {
	return Marshal(artifactDocument(title, map[string]any{
		"type":   "mermaid",
		"id":     newID("mermaid"),
		"source": source,
		"children": []any{
			textElement("mermaid_caption", caption),
		},
	}))
}

func artifactDocument(title string, node map[string]any) Envelope {
	if title == "" {
		title = "Untitled"
	}
	return Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{
		{"type": "h1", "id": newID("block"), "children": []any{textLeaf(title)}},
		node,
	}}
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
		question := value.(map[string]any)
		item := map[string]any{
			"id":     question["id"],
			"type":   question["questionType"],
			"level":  question["level"],
			"prompt": nodeText(firstChild(question, "quiz_prompt")),
		}
		if explanation := firstChild(question, "quiz_explanation"); explanation != nil {
			if text := nodeText(explanation); text != "" {
				item["explanation"] = text
			}
		}
		options := childrenOfType(question, "quiz_option")
		switch question["questionType"] {
		case "mcq", "multi":
			values := make([]any, len(options))
			indices := map[string]int{}
			for i, option := range options {
				entry := map[string]any{"value": nodeText(option)}
				if explanation, ok := option["explanation"].(string); ok {
					entry["explanation"] = explanation
				}
				values[i] = entry
				indices[option["id"].(string)] = i
			}
			correct := []any{}
			if ids, ok := stringArray(question["correctOptionIds"]); ok {
				for _, id := range ids {
					if index, found := indices[id]; found {
						correct = append(correct, index)
					}
				}
			}
			item["options"] = values
			item["correct"] = correct
		case "boolean":
			correct, _ := question["correctBoolean"].(bool)
			item["correct"] = correct
		case "fill", "short":
			answers, ok := stringArray(question["acceptedAnswers"])
			if !ok {
				answers = make([]string, len(options))
				for i, option := range options {
					answers[i] = nodeText(option)
				}
			}
			accepted := make([]any, len(answers))
			for i, answer := range answers {
				accepted[i] = map[string]any{"value": answer}
			}
			item["accepted"] = accepted
		case "matching":
			pairs, _ := question["pairs"].([]any)
			if pairs == nil {
				pairs = []any{}
			}
			item["pairs"] = pairs
		case "ordering":
			items := make([]any, len(options))
			for i, option := range options {
				items[i] = map[string]any{"value": nodeText(option)}
			}
			item["items"] = items
		}
		values = append(values, item)
	}
	b, err := json.Marshal(values)
	if err != nil {
		return nil, nil, err
	}
	var limit *int
	if n, ok := integer(node["timeLimitMin"]); ok {
		value := int(n)
		limit = &value
	}
	return b, limit, nil
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

func ReplaceQuiz(raw string, questions json.RawMessage, timeLimit *int) (string, error) {
	replacement, err := QuizDocument("", questions, timeLimit)
	if err != nil {
		return "", err
	}
	return replaceCustom(raw, replacement, "quiz", preserveQuizText)
}

func ReplaceFlashcards(raw string, cards []Card) (string, error) {
	replacement, err := FlashcardsDocument("", cards)
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

// RewriteEditorAssetIDs updates embedded media references when a workspace is
// cloned. Asset rows are copied with new logical IDs while their physical blob
// paths may remain shared.
func RewriteEditorAssetIDs(raw string, idMap map[string]string) (string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	var rewrite func(map[string]any)
	rewrite = func(node map[string]any) {
		if assetID, ok := node["assetId"].(string); ok {
			if replacement := idMap[assetID]; replacement != "" {
				node["assetId"] = replacement
			}
		}
		for _, child := range children(node) {
			rewrite(child)
		}
	}
	for _, node := range doc.Value {
		rewrite(node)
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

func preserveQuizText(current, replacement map[string]any) {
	oldQuestions := byID(current["children"].([]any))
	for _, raw := range replacement["children"].([]any) {
		question := raw.(map[string]any)
		old := oldQuestions[question["id"].(string)]
		if old == nil {
			continue
		}
		preserveMatchingText(old, question, "quiz_prompt")
		preserveMatchingText(old, question, "quiz_explanation")
		oldOptions := byID(childrenAnyOfType(old, "quiz_option"))
		for _, option := range childrenOfType(question, "quiz_option") {
			if previous := oldOptions[option["id"].(string)]; previous != nil && nodeText(previous) == nodeText(option) {
				option["children"] = previous["children"]
			}
		}
	}
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
func FromLegacyMarkdown(kind, title, markdown string) (string, error) {
	if parsed, err := Parse(markdown); err == nil {
		return Marshal(parsed)
	}
	if kind == "mindmap" || kind == "diagram" {
		return MermaidDocument(title, fenced(markdown, "mermaid"), "")
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

func objectArray(value any, name string) ([]map[string]any, error) {
	raw, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", name)
	}
	values := make([]map[string]any, len(raw))
	for i, item := range raw {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s[%d] must be an object", name, i)
		}
		values[i] = object
	}
	return values, nil
}

func indexArray(value any) ([]int, error) {
	raw, ok := value.([]any)
	if !ok {
		return nil, errors.New("correct must be an array")
	}
	values := make([]int, len(raw))
	for i, item := range raw {
		number, ok := integer(item)
		if !ok {
			return nil, fmt.Errorf("correct[%d] must be an integer", i)
		}
		values[i] = int(number)
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
