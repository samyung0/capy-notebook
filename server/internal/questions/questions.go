// Package questions validates the shared authored question and attempt contract.
package questions

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

type Policy struct {
	Bank          bool
	BankAssetsURL string
	Snapshot      bool
}

// QuizBankAssetsURL is the bank's public asset base, set once at startup. A
// question copied from the bank into a quiz keeps linking its figures there
// (immutable, content-hashed URLs) instead of copying them into the
// workspace. Empty refuses such links.
var QuizBankAssetsURL string

const MaxSVGBytes = fieldlimits.QuestionSVGBytes

var termTokens = regexp.MustCompile(`(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[A-Za-z]+|[+\-*/^(),]`)
var whitespace = regexp.MustCompile(`\s`)
var svgRoot = regexp.MustCompile(`^\s*<svg[\s>]`)
var svgEnd = regexp.MustCompile(`</svg>\s*$`)
var svgUnsafe = regexp.MustCompile(`(?i)<!|<\?|\bon\w+\s*=|javascript:|data:|<\s*/?\s*(?:script|foreignObject|style|image|use|a|animate\w*|set)\b`)
var svgReference = regexp.MustCompile(`(?i)(?:[a-z]+:)?(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
var svgLocalReference = regexp.MustCompile(`^["']#[A-Za-z0-9_-]+["']$`)
var svgURL = regexp.MustCompile(`(?i)url\s*\([^)]*\)`)
var svgLocalURL = regexp.MustCompile(`(?i)^url\s*\(\s*["']?#[A-Za-z0-9_-]+["']?\s*\)$`)
var svgEscapedStyle = regexp.MustCompile(`(?i)style\s*=\s*(?:"[^"<>]*\\|'[^'<>]*\\)`)
var svgTags = regexp.MustCompile(`<\/?([A-Za-z][\w:-]*)\b`)

func validTerm(term string) bool {
	tokens := termTokens.FindAllString(term, -1)
	if len(tokens) == 0 || strings.Join(tokens, "") != whitespace.ReplaceAllString(term, "") {
		return false
	}
	for _, token := range tokens {
		if token[0] >= 'A' && token[0] <= 'Z' || token[0] >= 'a' && token[0] <= 'z' {
			if !enum(token, "x pi e sin cos tan asin acos atan sqrt abs exp log ln floor ceil pow min max") {
				return false
			}
		}
	}
	return true
}

// ValidSVG permits the static subset rendered through an img, never active SVG.
func ValidSVG(svg string) bool {
	if len(svg) > MaxSVGBytes || !svgRoot.MatchString(svg) || !svgEnd.MatchString(svg) || svgUnsafe.MatchString(svg) || svgEscapedStyle.MatchString(svg) {
		return false
	}
	for _, ref := range svgReference.FindAllStringSubmatch(svg, -1) {
		if !svgLocalReference.MatchString(ref[1]) {
			return false
		}
	}
	for _, ref := range svgURL.FindAllString(svg, -1) {
		if !svgLocalURL.MatchString(ref) {
			return false
		}
	}
	for _, tag := range svgTags.FindAllStringSubmatch(svg, -1) {
		if !enum(tag[1], "svg g path rect circle ellipse line polyline polygon text tspan defs marker clipPath title desc") {
			return false
		}
	}
	return true
}
func tableCells(value any) bool {
	cells, ok := array(value, 1, fieldlimits.QuestionTableColumns)
	if !ok {
		return false
	}
	for _, cell := range cells {
		if !str(cell, fieldlimits.QuestionText, false) {
			return false
		}
	}
	return true
}

// gapMarker is a numbered blank in a gaps part's text: "(1) ______".
var gapMarker = regexp.MustCompile(`\((\d+)\) ?_{3,}`)

var quantityPattern = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?(?:\s*/\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)?$`)

func fail(message string) error { return fmt.Errorf("invalid question: %s", message) }
func obj(value any) (map[string]any, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return nil, fail("expected object")
	}
	return m, nil
}
func keys(m map[string]any, required string, optional string) error {
	allowed := map[string]bool{}
	for _, key := range strings.Fields(required) {
		allowed[key] = true
		if _, ok := m[key]; !ok {
			return fail("missing " + key)
		}
	}
	for _, key := range strings.Fields(optional) {
		allowed[key] = true
	}
	for key := range m {
		if !allowed[key] {
			return fail("unexpected field " + key)
		}
	}
	return nil
}
func str(v any, max int, nonempty bool) bool {
	s, ok := v.(string)
	return ok && utf8.RuneCountInString(s) <= max && (!nonempty || strings.TrimSpace(s) != "")
}
func num(v any) (float64, bool) {
	var n float64
	switch x := v.(type) {
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case json.Number:
		var err error
		n, err = x.Float64()
		if err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return n, !math.IsNaN(n) && !math.IsInf(n, 0)
}
func array(v any, min, max int) ([]any, bool) {
	a, ok := v.([]any)
	return a, ok && len(a) >= min && len(a) <= max
}
func stringsArray(v any, min, max, length int) bool {
	a, ok := array(v, min, max)
	if !ok {
		return false
	}
	for _, s := range a {
		if !str(s, length, true) {
			return false
		}
	}
	return true
}
func enum(v any, choices string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, choice := range strings.Fields(choices) {
		if s == choice {
			return true
		}
	}
	return false
}
func optionalString(m map[string]any, key string, max int) bool {
	v, ok := m[key]
	return !ok || str(v, max, false)
}
func optionalBool(m map[string]any, key string) bool {
	v, ok := m[key]
	if !ok {
		return true
	}
	_, ok = v.(bool)
	return ok
}
func tuple(v any, count int) ([]float64, bool) {
	a, ok := array(v, count, count)
	if !ok {
		return nil, false
	}
	r := make([]float64, count)
	for i, x := range a {
		n, ok := num(x)
		if !ok {
			return nil, false
		}
		r[i] = n
	}
	return r, true
}

// Validate accepts decoded JSON maps; it never repairs or fills authored fields.
func Validate(q map[string]any, policy Policy) error {
	if err := keys(q, "id stem parts layout labels", "level"); err != nil {
		return err
	}
	if !str(q["id"], fieldlimits.QuestionID, true) || !enum(q["layout"], "paper split") || !enum(q["labels"], "letters numbers") {
		return fail("invalid identity or layout")
	}
	if level, ok := q["level"]; ok && !enum(level, "recall application analysis") {
		return fail("invalid level")
	}
	if err := blocks(q["stem"], policy); err != nil {
		return err
	}
	maxParts, maxItems := fieldlimits.QuizQuestionParts, fieldlimits.QuizMarkscheme
	if policy.Bank {
		maxParts, maxItems = fieldlimits.QuestionParts, fieldlimits.QuestionMarkscheme
	}
	parts, ok := array(q["parts"], 1, maxParts)
	if !ok {
		return fail(fmt.Sprintf("parts must contain 1 to %d parts", maxParts))
	}
	ids := map[string]bool{}
	for _, raw := range parts {
		p, err := obj(raw)
		if err != nil {
			return err
		}
		// Only open parts carry a marking scheme: Jev grades against it. A
		// closed part's answer is its own key and its solution explains it.
		a, _ := p["answer"].(map[string]any)
		open := a["type"] == "open"
		required, optional := "id blocks answer marks solution", ""
		if open {
			required += " markscheme"
		}
		if policy.Snapshot {
			optional = "awarded"
			if open {
				optional += " itemAwards"
			}
		}
		if _, has := p["markscheme"]; has && !open {
			// Models attach one to every part; name the part and the rule so
			// one rewrite fixes them all.
			return fail(fmt.Sprintf("part %v: a %v answer has no markscheme; explain it in solution", p["id"], a["type"]))
		}
		if err := keys(p, required, optional); err != nil {
			return err
		}
		if !str(p["id"], fieldlimits.QuestionID, true) {
			return fail("invalid part id")
		}
		id := p["id"].(string)
		if ids[id] {
			return fail("duplicate part id")
		}
		ids[id] = true
		if err := blocks(p["blocks"], policy); err != nil {
			return err
		}
		if len(p["blocks"].([]any)) == 0 {
			return fail("part requires content")
		}
		if err := blocks(p["solution"], policy); err != nil {
			return err
		}
		if policy.Bank && len(p["solution"].([]any)) == 0 {
			return fail("bank part requires a solution")
		}
		marks, ok := num(p["marks"])
		if !ok || marks < 1 || marks > fieldlimits.QuestionMarks || marks != math.Trunc(marks) {
			return fail(fmt.Sprintf("a part has 1 to %d marks", fieldlimits.QuestionMarks))
		}
		if open {
			_, itemMarks, err := markscheme(p["markscheme"], maxItems)
			if err != nil {
				return err
			}
			if sum(itemMarks) != marks {
				return fail("marking items must add up to the part's marks")
			}
			if err := itemAwards(p, itemMarks); err != nil {
				return err
			}
		}
		if err := answer(p["answer"], policy); err != nil {
			return err
		}
		if a["type"] == "gaps" && !gapsNumbered(p) {
			return fail("write each gap in the text as (1) ______, (2) ______ and so on, one per accepted list")
		}
		if v, exists := p["awarded"]; exists {
			n, ok := num(v)
			if !ok || n < 0 || n > marks || n*2 != math.Trunc(n*2) {
				return fail("invalid awarded marks")
			}
		}
	}
	return nil
}

// ValidateAll also protects the flat part-id answer map across a whole quiz.
func ValidateAll(qs []map[string]any, policy Policy) error {
	if policy.Bank && len(qs) > fieldlimits.QuestionCount {
		return fail("too many questions")
	}
	if !policy.Bank {
		if err := QuizBounds(qs); err != nil {
			return err
		}
	}
	ids, parts := map[string]bool{}, map[string]bool{}
	for _, q := range qs {
		if err := Validate(q, policy); err != nil {
			return err
		}
		id := q["id"].(string)
		if ids[id] {
			return fail("duplicate question id")
		}
		ids[id] = true
		for _, raw := range q["parts"].([]any) {
			id := raw.(map[string]any)["id"].(string)
			if parts[id] {
				return fail("duplicate part id")
			}
			parts[id] = true
		}
	}
	return nil
}

func blocks(value any, policy Policy) error {
	a, ok := array(value, 0, fieldlimits.QuestionBlocks)
	if !ok {
		return fail(fmt.Sprintf("blocks must contain at most %d blocks", fieldlimits.QuestionBlocks))
	}
	for _, raw := range a {
		b, err := obj(raw)
		if err != nil {
			return err
		}
		if err := ValidateBlock(b, policy); err != nil {
			return err
		}
	}
	return nil
}

// ValidateBlock is shared by questions and standalone note chart/graph embeds.
func ValidateBlock(b map[string]any, policy Policy) error {
	switch b["type"] {
	case "text":
		if err := keys(b, "type text", "label"); err != nil {
			return err
		}
		if !str(b["text"], fieldlimits.QuestionText, true) || !optionalString(b, "label", fieldlimits.QuestionMetadata) {
			return fail("invalid text block")
		}
	case "table":
		if err := keys(b, "type header rows", ""); err != nil {
			return err
		}
		if _, ok := b["header"].(bool); !ok {
			return fail("invalid table header")
		}
		rows, ok := array(b["rows"], 1, fieldlimits.QuestionTableRows)
		if !ok {
			return fail("invalid table rows")
		}
		width := -1
		for _, row := range rows {
			cells, ok := array(row, 1, fieldlimits.QuestionTableColumns)
			if !ok || !tableCells(row) {
				return fail("invalid table cells")
			}
			if width != -1 && len(cells) != width {
				return fail("ragged table")
			}
			width = len(cells)
		}
	case "chart":
		if err := keys(b, "type kind title labels series", "unit xTitle yTitle gridlines"); err != nil {
			return err
		}
		if !enum(b["kind"], "bar hbar line area pie stacked") || !str(b["title"], fieldlimits.QuestionMetadata, false) || !stringsArray(b["labels"], 1, fieldlimits.QuestionChartLabels, fieldlimits.QuestionText) {
			return fail("invalid chart")
		}
		for _, key := range []string{"unit", "xTitle", "yTitle"} {
			if !optionalString(b, key, fieldlimits.QuestionMetadata) {
				return fail("invalid chart label")
			}
		}
		if g, ok := b["gridlines"]; ok && !enum(g, "normal fine") {
			return fail("invalid gridlines")
		}
		series, ok := array(b["series"], 1, fieldlimits.QuestionChartSeries)
		if !ok {
			return fail("invalid chart series")
		}
		if (b["kind"] == "pie" || b["kind"] == "stacked") && len(series) != 1 {
			return fail("pie and stacked require one series")
		}
		for _, raw := range series {
			s, err := obj(raw)
			if err != nil {
				return err
			}
			if err := keys(s, "name values", ""); err != nil {
				return err
			}
			if !str(s["name"], fieldlimits.QuestionMetadata, false) {
				return fail("invalid series name")
			}
			values, ok := array(s["values"], len(b["labels"].([]any)), len(b["labels"].([]any)))
			if !ok {
				return fail("chart values must align with labels")
			}
			for _, v := range values {
				n, ok := num(v)
				if !ok || ((b["kind"] == "pie" || b["kind"] == "stacked") && n < 0) {
					return fail("invalid chart value")
				}
			}
		}
		if b["kind"] == "pie" || b["kind"] == "stacked" {
			positive := false
			for _, raw := range series[0].(map[string]any)["values"].([]any) {
				n, _ := num(raw)
				positive = positive || n > 0
			}
			if !positive {
				return fail("chart requires a positive total")
			}
		}
	case "image":
		if err := keys(b, "type image width height description", "attribution"); err != nil {
			return err
		}
		if err := imageFields(b); err != nil {
			return err
		}
		im, err := obj(b["image"])
		if err != nil {
			return err
		}
		// Bank figures are public URLs; quiz figures are private workspace editor
		// assets, or a copied bank question's public URL.
		if policy.Bank || im["url"] != nil {
			if err := keys(im, "url", ""); err != nil {
				return err
			}
			if !assetURL(im["url"], bankBase(policy)) {
				return fail("invalid bank asset URL")
			}
		} else {
			if err := keys(im, "assetId", ""); err != nil {
				return err
			}
			if !str(im["assetId"], fieldlimits.QuestionID, true) {
				return fail("invalid image asset")
			}
		}
	case "graph":
		if err := keys(b, "type board elements image width height description", "attribution"); err != nil {
			return err
		}
		if err := imageFields(b); err != nil {
			return err
		}
		if err := graph(b); err != nil {
			return err
		}
		im, err := obj(b["image"])
		if err != nil {
			return err
		}
		if policy.Bank || im["url"] != nil {
			if err := keys(im, "url", ""); err != nil {
				return err
			}
			if !assetURL(im["url"], bankBase(policy)) {
				return fail("invalid bank graph URL")
			}
		} else {
			if err := keys(im, "svg", ""); err != nil {
				return err
			}
			svg, ok := im["svg"].(string)
			if !ok || len(svg) > MaxSVGBytes || !ValidSVG(svg) {
				return fail("invalid graph SVG")
			}
		}
	default:
		return fail("unsupported block type")
	}
	return nil
}

// bankBase is where a figure URL may point: the bank's own base for a bank
// question, QuizBankAssetsURL for one copied into a quiz.
func bankBase(policy Policy) string {
	if policy.Bank {
		return policy.BankAssetsURL
	}
	return QuizBankAssetsURL
}

func imageFields(b map[string]any) error {
	for _, key := range []string{"width", "height"} {
		n, ok := num(b[key])
		if !ok || n <= 0 || n > fieldlimits.QuestionImageDimension || n != math.Trunc(n) {
			return fail("invalid image dimensions")
		}
	}
	if !str(b["description"], fieldlimits.QuestionText, true) || !optionalString(b, "attribution", fieldlimits.QuestionMetadata) {
		return fail("invalid image description")
	}
	return nil
}
func assetURL(value any, base string) bool {
	s, ok := value.(string)
	if !ok || len(s) > fieldlimits.QuestionAssetURL {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	root, err := url.Parse(base)
	if err != nil || root.Scheme != "https" || root.Host == "" {
		return false
	}
	return u.Scheme == root.Scheme && u.Host == root.Host && !strings.Contains(u.Path, "\\") && strings.HasPrefix(path.Clean(u.Path), strings.TrimRight(path.Clean("/"+root.Path), "/")+"/")
}

func graph(b map[string]any) error {
	board, err := obj(b["board"])
	if err != nil {
		return err
	}
	if err := keys(board, "bbox axis grid", ""); err != nil {
		return err
	}
	bbox, ok := tuple(board["bbox"], 4)
	if !ok || bbox[0] >= bbox[2] || bbox[1] <= bbox[3] {
		return fail("invalid graph bounding box")
	}
	for _, key := range []string{"axis", "grid"} {
		if _, ok := board[key].(bool); !ok {
			return fail("invalid board flag")
		}
	}
	elems, ok := array(b["elements"], 0, fieldlimits.QuestionGraphElements)
	if !ok {
		return fail("invalid graph elements")
	}
	points, ids := map[string]bool{}, map[string]bool{}
	for _, raw := range elems {
		e, err := obj(raw)
		if err != nil {
			return err
		}
		if !str(e["id"], fieldlimits.QuestionID, true) {
			return fail("invalid graph element id")
		}
		id := e["id"].(string)
		if ids[id] {
			return fail("duplicate graph element id")
		}
		ids[id] = true
		if e["type"] == "point" {
			points[id] = true
		}
	}
	for _, raw := range elems {
		e := raw.(map[string]any)
		required, optional := "type id", "hidden"
		switch e["type"] {
		case "functiongraph":
			required += " term"
			optional += " domain dash"
		case "point":
			required += " coords"
			optional += " name"
		case "line":
			required += " points"
			optional += " dash"
		case "segment":
			// ticks: 1 to 3 hatch marks showing equal lengths.
			required += " points"
			optional += " dash ticks"
		case "circle":
			required += " center radius"
			optional += " dash"
		case "text":
			required += " coords text"
		case "angle":
			required += " points"
			optional += " label"
		case "arc":
			required += " center points"
			optional += " dash"
		case "sector":
			required += " center points"
			optional += " dash shade"
		case "polygon":
			required += " points"
			optional += " dash shade"
		default:
			return fail("unsupported graph element")
		}
		if err := keys(e, required, optional); err != nil {
			return err
		}
		if !optionalBool(e, "hidden") || !optionalBool(e, "dash") || !optionalBool(e, "shade") {
			return fail("invalid graph flag")
		}
		if t, exists := e["ticks"]; exists {
			if n, ok := num(t); !ok || n < 1 || n > 3 || n != math.Trunc(n) {
				return fail("invalid equal-length ticks")
			}
		}
		switch e["type"] {
		case "functiongraph":
			term, ok := e["term"].(string)
			if !ok || len(term) > fieldlimits.QuestionGraphTerm || !validTerm(term) {
				return fail("invalid function term")
			}
			if d, exists := e["domain"]; exists {
				v, ok := tuple(d, 2)
				if !ok || v[0] >= v[1] {
					return fail("invalid function domain")
				}
			}
		case "point", "text":
			if _, ok := tuple(e["coords"], 2); !ok {
				return fail("invalid coordinates")
			}
			if !optionalString(e, "name", fieldlimits.QuestionMetadata) {
				return fail("invalid point name")
			}
			if e["type"] == "text" && !str(e["text"], fieldlimits.QuestionText, true) {
				return fail("invalid graph text")
			}
		case "line", "segment", "angle", "arc", "sector", "polygon":
			// Angles take three points with the vertex in the middle; arcs and
			// sectors run counterclockwise between two points around a center.
			count, most := 2, 2
			switch e["type"] {
			case "angle":
				count, most = 3, 3
			case "polygon":
				count, most = 3, fieldlimits.QuestionGraphPolygon
			}
			refs, ok := array(e["points"], count, most)
			if !ok {
				return fail("invalid point references")
			}
			seen := map[string]bool{}
			for _, ref := range refs {
				id, ok := ref.(string)
				if !ok || !points[id] {
					return fail("unknown graph point")
				}
				if seen[id] {
					return fail("repeated graph point")
				}
				seen[id] = true
			}
			if center, exists := e["center"]; exists {
				id, ok := center.(string)
				if !ok || !points[id] || seen[id] {
					return fail("invalid arc center")
				}
			}
			if !optionalString(e, "label", fieldlimits.QuestionMetadata) {
				return fail("invalid angle label")
			}
		case "circle":
			center, ok := e["center"].(string)
			radius, valid := num(e["radius"])
			if !ok || !points[center] || !valid || radius <= 0 {
				return fail("invalid circle")
			}
		}
	}
	return nil
}

// markscheme checks an open part's marking items and returns their texts and
// marks. Each item carries whole marks, so a harder step can be worth more.
func markscheme(v any, maxItems int) ([]string, []float64, error) {
	items, ok := array(v, 1, maxItems)
	if !ok {
		return nil, nil, fail(fmt.Sprintf("a marking scheme has 1 to %d items", maxItems))
	}
	texts, marks := make([]string, len(items)), make([]float64, len(items))
	for i, raw := range items {
		item, err := obj(raw)
		if err != nil {
			return nil, nil, err
		}
		if err := keys(item, "text marks", ""); err != nil {
			return nil, nil, err
		}
		n, ok := num(item["marks"])
		if !str(item["text"], fieldlimits.QuestionMarkItem, true) || !ok || n < 1 || n != math.Trunc(n) {
			return nil, nil, fail("a marking item has text and whole marks")
		}
		texts[i], marks[i] = item["text"].(string), n
	}
	return texts, marks, nil
}

// gapsNumbered checks that a gaps part's text numbers its blanks 1 to n in
// order, one per accepted list.
func gapsNumbered(p map[string]any) bool {
	blocks, _ := p["blocks"].([]any)
	next := 1
	for _, raw := range blocks {
		b, _ := raw.(map[string]any)
		text, _ := b["text"].(string)
		if b["type"] != "text" {
			continue
		}
		for _, match := range gapMarker.FindAllStringSubmatch(text, -1) {
			if match[1] != strconv.Itoa(next) {
				return false
			}
			next++
		}
	}
	accepted, _ := p["answer"].(map[string]any)["accepted"].([]any)
	return next-1 == len(accepted)
}

func sum(values []float64) float64 {
	total := 0.0
	for _, v := range values {
		total += v
	}
	return total
}

// MarkItems returns a validated open part's marking item texts and marks.
func MarkItems(p map[string]any) ([]string, []float64) {
	texts, marks, _ := markscheme(p["markscheme"], math.MaxInt)
	return texts, marks
}

// itemAwards are an open part's Jev marks: none, half or all of each marking
// item's marks, summing to the part's awarded marks.
func itemAwards(p map[string]any, itemMarks []float64) error {
	raw, exists := p["itemAwards"]
	if !exists {
		return nil
	}
	list, ok := array(raw, len(itemMarks), len(itemMarks))
	awarded, hasAwarded := num(p["awarded"])
	if !ok || !hasAwarded {
		return fail("item awards need one mark per marking item and an awarded total")
	}
	total := 0.0
	for i, v := range list {
		n, ok := num(v)
		if !ok || (n != 0 && n != itemMarks[i]/2 && n != itemMarks[i]) {
			return fail("item awards are none, half or all of an item's marks")
		}
		total += n
	}
	if total != awarded {
		return fail("item awards must sum to the awarded marks")
	}
	return nil
}

// QuizBounds caps a user quiz's total and open parts; the per-question checks
// in Validate bound parts per question and marking items per part.
func QuizBounds(qs []map[string]any) error {
	parts, open := 0, 0
	for _, q := range qs {
		list, _ := q["parts"].([]any)
		parts += len(list)
		for _, raw := range list {
			p, _ := raw.(map[string]any)
			if a, _ := p["answer"].(map[string]any); a["type"] == "open" {
				open++
			}
		}
	}
	if parts > fieldlimits.QuizParts {
		return fail(fmt.Sprintf("a quiz has at most %d parts", fieldlimits.QuizParts))
	}
	if open > fieldlimits.QuizOpenParts {
		return fail(fmt.Sprintf("a quiz has at most %d open parts", fieldlimits.QuizOpenParts))
	}
	return nil
}

func answer(value any, policy Policy) error {
	a, err := obj(value)
	if err != nil {
		return err
	}
	required, optional := "type", ""
	switch a["type"] {
	case "mcq", "multi":
		required += " options correct"
	case "boolean":
		required += " correct"
	case "short":
		required += " accepted"
		optional = "unit"
	case "matching":
		required += " options pairs"
	case "ordering":
		required += " items"
	case "open":
		required += " accepted hints"
	case "gaps":
		// One accepted list per numbered gap in the part's text.
		required += " accepted"
	default:
		return fail("invalid answer type")
	}
	if err := keys(a, required, optional); err != nil {
		return err
	}
	switch a["type"] {
	case "mcq", "multi", "matching":
		if !stringsArray(a["options"], 1, fieldlimits.QuestionAnswers, fieldlimits.QuestionText) {
			return fail("invalid options")
		}
		count := len(a["options"].([]any))
		if a["type"] != "matching" && count < 2 {
			return fail("choice answers require two options")
		}
		if a["type"] == "matching" {
			pairs, ok := array(a["pairs"], 1, fieldlimits.QuestionAnswers)
			if !ok {
				return fail("invalid pairs")
			}
			seen := map[string]bool{}
			for _, raw := range pairs {
				p, err := obj(raw)
				if err != nil {
					return err
				}
				if err := keys(p, "left right", ""); err != nil {
					return err
				}
				if !str(p["left"], fieldlimits.QuestionText, true) {
					return fail("invalid matching left item")
				}
				left := p["left"].(string)
				seen[left] = true
				if !index(p["right"], count) {
					return fail("invalid matching index")
				}
			}
		} else {
			max := count
			if a["type"] == "mcq" {
				max = 1
			}
			correct, ok := array(a["correct"], 1, max)
			if !ok {
				return fail("invalid correct indices")
			}
			seen := map[float64]bool{}
			for _, raw := range correct {
				n, _ := num(raw)
				if !index(raw, count) || seen[n] {
					return fail("invalid correct index")
				}
				seen[n] = true
			}
		}
	case "boolean":
		if _, ok := a["correct"].(bool); !ok {
			return fail("invalid boolean answer")
		}
	case "gaps":
		gaps, ok := array(a["accepted"], 1, fieldlimits.QuestionAnswers)
		if !ok {
			return fail("invalid gaps")
		}
		for _, accepted := range gaps {
			if !stringsArray(accepted, 1, fieldlimits.QuestionAnswers, fieldlimits.QuestionText) {
				return fail("invalid accepted answers for a gap")
			}
		}
	case "short", "open":
		length := fieldlimits.QuestionText
		if a["type"] == "open" && !policy.Bank {
			length = fieldlimits.QuizOpenAnswer
		}
		if !stringsArray(a["accepted"], 1, fieldlimits.QuestionAnswers, length) {
			return fail("invalid accepted answers")
		}
		if a["type"] == "open" && !stringsArray(a["hints"], 0, fieldlimits.QuestionAnswers, fieldlimits.QuestionText) {
			return fail("invalid hints")
		}
		if unit, exists := a["unit"]; exists {
			if !str(unit, fieldlimits.QuestionUnit, true) {
				return fail("invalid unit")
			}
			for _, v := range a["accepted"].([]any) {
				value := strings.TrimSpace(v.(string))
				valid := quantityPattern.MatchString(value)
				if _, denominator, fraction := strings.Cut(value, "/"); fraction {
					mantissa := strings.FieldsFunc(strings.TrimSpace(denominator), func(r rune) bool { return r == 'e' || r == 'E' })
					valid = valid && len(mantissa) > 0 && strings.Trim(mantissa[0], "+-.0") != ""
				}
				if !valid {
					return fail("quantity answers must contain values only")
				}
			}
		}
	case "ordering":
		if !stringsArray(a["items"], 2, fieldlimits.QuestionAnswers, fieldlimits.QuestionText) {
			return fail("invalid ordering items")
		}
	}
	return nil
}
func index(v any, size int) bool {
	n, ok := num(v)
	return ok && n >= 0 && n < float64(size) && n == math.Trunc(n)
}

func Marks(q map[string]any) int {
	total := 0
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		total += partMarks(p)
	}
	return total
}

func partMarks(p map[string]any) int {
	marks, _ := num(p["marks"])
	return int(marks)
}

// Authored removes attempt-only scores without mutating the submitted snapshot.
// Other nested content is shared; callers must treat both values as immutable.
func Authored(q map[string]any) map[string]any {
	out := make(map[string]any, len(q))
	for key, value := range q {
		out[key] = value
	}
	parts, _ := q["parts"].([]any)
	clean := make([]any, 0, len(parts))
	for _, raw := range parts {
		part, _ := raw.(map[string]any)
		copy := make(map[string]any, len(part))
		for key, value := range part {
			if key != "awarded" && key != "itemAwards" {
				copy[key] = value
			}
		}
		clean = append(clean, copy)
	}
	out["parts"] = clean
	return out
}

// LearnerView is a question as readers who are not editing see it: no answer
// keys, accepted answers, marking schemes or worked solutions, with matching
// options and ordering items shuffled. An allowlist keeps new author-only
// fields out. Stored content is read with checked assertions, so a malformed
// question loses fields instead of panicking.
func LearnerView(q map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"id", "stem", "layout", "labels", "level"} {
		if v, ok := q[key]; ok {
			out[key] = v
		}
	}
	parts := []any{}
	list, _ := q["parts"].([]any)
	for _, raw := range list {
		p, _ := raw.(map[string]any)
		a, _ := p["answer"].(map[string]any)
		learner := map[string]any{"type": a["type"]}
		switch a["type"] {
		case "mcq", "multi":
			learner["options"] = a["options"]
		case "short":
			if unit, ok := a["unit"]; ok {
				learner["unit"] = unit
			}
		case "matching":
			options, _ := a["options"].([]any)
			learner["options"] = shuffled(options)
			left := []any{}
			pairs, _ := a["pairs"].([]any)
			for _, raw := range pairs {
				pair, _ := raw.(map[string]any)
				left = append(left, pair["left"])
			}
			learner["left"] = left
		case "gaps":
			accepted, _ := a["accepted"].([]any)
			learner["gaps"] = len(accepted)
		case "ordering":
			items, _ := a["items"].([]any)
			learner["items"] = shuffled(items)
		}
		parts = append(parts, map[string]any{"id": p["id"], "blocks": p["blocks"], "answer": learner, "marks": partMarks(p)})
	}
	out["parts"] = parts
	return out
}

// LearnerViews applies LearnerView to a list.
func LearnerViews(qs []map[string]any) []map[string]any {
	out := make([]map[string]any, len(qs))
	for i, q := range qs {
		out[i] = LearnerView(q)
	}
	return out
}

func shuffled(values []any) []any {
	out := append([]any{}, values...)
	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// AssetIDs returns the editor assets referenced by a quiz question's images.
func AssetIDs(q map[string]any) []string {
	var ids []string
	for _, blocks := range blockLists(q) {
		for _, raw := range blocks {
			if id, ok := imageAssetID(raw); ok {
				ids = append(ids, id)
			}
		}
	}
	return ids
}

// RewriteAssetIDs maps image assets through idMap and removes images whose
// asset has no replacement. It returns false when a part is left without
// content, because that question can no longer be stored.
func RewriteAssetIDs(q map[string]any, idMap map[string]string) bool {
	rewrite := func(raw any) []any {
		blocks, _ := raw.([]any)
		kept := []any{}
		for _, block := range blocks {
			if id, ok := imageAssetID(block); ok {
				if idMap[id] == "" {
					continue
				}
				block.(map[string]any)["image"].(map[string]any)["assetId"] = idMap[id]
			}
			kept = append(kept, block)
		}
		return kept
	}
	q["stem"] = rewrite(q["stem"])
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		p["blocks"] = rewrite(p["blocks"])
		p["solution"] = rewrite(p["solution"])
		if len(p["blocks"].([]any)) == 0 {
			return false
		}
	}
	return true
}

func blockLists(q map[string]any) [][]any {
	stem, _ := q["stem"].([]any)
	lists := [][]any{stem}
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		if p, ok := raw.(map[string]any); ok {
			blocks, _ := p["blocks"].([]any)
			solution, _ := p["solution"].([]any)
			lists = append(lists, blocks, solution)
		}
	}
	return lists
}

func imageAssetID(raw any) (string, bool) {
	b, ok := raw.(map[string]any)
	if !ok || b["type"] != "image" {
		return "", false
	}
	im, _ := b["image"].(map[string]any)
	id, ok := im["assetId"].(string)
	return id, ok && id != ""
}

// GradingText is the question text a grader sees for one part: the stem, the
// earlier parts and the part itself, with figures as their descriptions.
func GradingText(q map[string]any, partIndex int) string {
	stem, _ := q["stem"].([]any)
	sections := []string{blocksText(stem)}
	parts, _ := q["parts"].([]any)
	for i, raw := range parts[:partIndex] {
		p, _ := raw.(map[string]any)
		blocks, _ := p["blocks"].([]any)
		sections = append(sections, fmt.Sprintf("Earlier part %d: %s", i+1, blocksText(blocks)))
	}
	p, _ := parts[partIndex].(map[string]any)
	blocks, _ := p["blocks"].([]any)
	sections = append(sections, "Part to grade: "+blocksText(blocks))
	nonEmpty := sections[:0]
	for _, section := range sections {
		if section != "" {
			nonEmpty = append(nonEmpty, section)
		}
	}
	return strings.Join(nonEmpty, "\n\n")
}

func blocksText(blocks []any) string {
	out := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		b, _ := raw.(map[string]any)
		str := func(key string) string { s, _ := b[key].(string); return s }
		switch b["type"] {
		case "text":
			lines := []string{}
			for _, s := range []string{str("label"), str("text")} {
				if s != "" {
					lines = append(lines, s)
				}
			}
			out = append(out, strings.Join(lines, "\n"))
		case "image", "graph":
			out = append(out, "[Figure: "+str("description")+"]")
		case "table":
			rows, _ := b["rows"].([]any)
			lines := make([]string, 0, len(rows))
			for _, row := range rows {
				cells := []string{}
				for _, cell := range row.([]any) {
					s, _ := cell.(string)
					cells = append(cells, s)
				}
				lines = append(lines, strings.Join(cells, " | "))
			}
			out = append(out, strings.Join(lines, "\n"))
		case "chart":
			title := str("title")
			if unit := str("unit"); unit != "" {
				title += " (" + unit + ")"
			}
			labels, _ := b["labels"].([]any)
			series, _ := b["series"].([]any)
			lines := []string{title}
			for _, raw := range series {
				s, _ := raw.(map[string]any)
				values, _ := s["values"].([]any)
				pairs := make([]string, len(values))
				for i, v := range values {
					label, _ := labels[i].(string)
					n, _ := num(v)
					pairs[i] = label + "=" + strconv.FormatFloat(n, 'f', -1, 64)
				}
				name, _ := s["name"].(string)
				lines = append(lines, name+": "+strings.Join(pairs, ", "))
			}
			out = append(out, strings.Join(lines, "\n"))
		}
	}
	return strings.Join(out, "\n\n")
}
