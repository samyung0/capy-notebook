package questions

import (
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

// Learner answers are keyed by part id. Each answer type takes one shape, the
// same for a learner view and a full question:
//
//	mcq, multi  option indices (numbers) in stored order, which LearnerView keeps
//	boolean     true or false
//	short, open the typed text
//	ordering    the item texts in the learner's order
//	matching    an object from each left item's index ("0", "1", ...) to the
//	            chosen option's text
//	gaps        one typed string per gap, in gap order
//
// LearnerView shuffles matching options and ordering items, so those two
// answer by text. A missing or wrongly shaped answer scores as wrong.
//
// ScorePart is a port of scorePart in src/features/quizzes/grade.ts; the
// fixtures in testdata/scoring keep the two in step.

// ScorePart scores a closed part: its awarded marks and whether each scored
// item is right. Matching pairs and gaps score one by one, rounded down to a
// half mark; every other closed answer is one item, all or nothing. Open parts
// score 0 with no items: Jev grades them.
func ScorePart(p map[string]any, value any) (float64, []bool) {
	a, _ := p["answer"].(map[string]any)
	if a == nil || a["type"] == "open" {
		return 0, nil
	}
	items := itemResults(a, value)
	marks, _ := num(p["marks"])
	if len(items) == 0 {
		return 0, items
	}
	right := 0
	for _, ok := range items {
		if ok {
			right++
		}
	}
	return math.Floor(marks*float64(right)/float64(len(items))*2) / 2, items
}

func itemResults(a map[string]any, value any) []bool {
	switch a["type"] {
	case "matching":
		options, _ := a["options"].([]any)
		pairs, _ := a["pairs"].([]any)
		chosen, isObject := value.(map[string]any)
		out := make([]bool, len(pairs))
		for i, raw := range pairs {
			pair, _ := raw.(map[string]any)
			right, ok := num(pair["right"])
			typed, isText := chosen[strconv.Itoa(i)].(string)
			if !isObject || !isText || !ok || right < 0 || int(right) >= len(options) || right != math.Trunc(right) {
				continue
			}
			want, _ := options[int(right)].(string)
			out[i] = typed == want
		}
		return out
	case "gaps":
		accepted, _ := a["accepted"].([]any)
		typed, _ := value.([]any)
		out := make([]bool, len(accepted))
		for i, raw := range accepted {
			if i >= len(typed) {
				continue
			}
			text, ok := typed[i].(string)
			if !ok || normText(text) == "" {
				continue
			}
			list, _ := raw.([]any)
			for _, expected := range list {
				if s, ok := expected.(string); ok && normText(s) == normText(text) {
					out[i] = true
					break
				}
			}
		}
		return out
	}
	return []bool{closedCorrect(a, value)}
}

func closedCorrect(a map[string]any, value any) bool {
	if value == nil {
		return false
	}
	switch a["type"] {
	case "mcq", "multi":
		chosen, ok := value.([]any)
		correct, _ := a["correct"].([]any)
		if !ok || len(chosen) != len(correct) {
			return false
		}
		seen := map[float64]bool{}
		for _, v := range chosen {
			n, isNumber := num(v)
			if !isNumber || seen[n] || !containsNumber(correct, n) {
				return false
			}
			seen[n] = true
		}
		return true
	case "boolean":
		b, ok := value.(bool)
		correct, isBool := a["correct"].(bool)
		return ok && isBool && b == correct
	case "short":
		text, ok := value.(string)
		if !ok {
			return false
		}
		accepted, _ := a["accepted"].([]any)
		unit, _ := a["unit"].(string)
		return shortCorrect(accepted, text, unit)
	case "ordering":
		order, ok := value.([]any)
		items, _ := a["items"].([]any)
		if !ok || len(order) != len(items) {
			return false
		}
		for i, v := range order {
			text, isText := v.(string)
			want, _ := items[i].(string)
			if !isText || text != want {
				return false
			}
		}
		return true
	}
	return false
}

func containsNumber(list []any, n float64) bool {
	for _, v := range list {
		if x, ok := num(v); ok && x == n {
			return true
		}
	}
	return false
}

func shortCorrect(accepted []any, value, unit string) bool {
	if unit != "" {
		typed, ok := quantityValue(value)
		if !ok {
			return false
		}
		for _, raw := range accepted {
			s, _ := raw.(string)
			if want, ok := quantityValue(s); ok && sameQuantity(want, typed) {
				return true
			}
		}
		return false
	}
	for _, raw := range accepted {
		if s, ok := raw.(string); ok && fuzzyMatch(s, value) {
			return true
		}
	}
	return false
}

/* ------------------------------------------------- text, as JavaScript reads it */

// jsSpace is JavaScript's \s and String.prototype.trim set, which differs from
// unicode.IsSpace (U+FEFF in, U+0085 out).
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

const jsSpaceClass = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// normText is grade.ts's norm: trim, NFKC, lowercase, runs of space to one.
func normText(s string) string {
	s = jsLower(norm.NFKC.String(strings.TrimFunc(s, jsSpace)))
	var b strings.Builder
	space := false
	for _, r := range s {
		if jsSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// jsLower is toLowerCase: Go's simple mappings plus the two full ones
// JavaScript applies, capital dotted I and final sigma.
func jsLower(s string) string {
	runes := []rune(s)
	var b strings.Builder
	for i, r := range runes {
		switch {
		case r == 'İ':
			b.WriteString("i̇")
		case r == 'Σ' && finalSigma(runes, i):
			b.WriteRune('ς')
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// finalSigma is Unicode's Final_Sigma: a cased letter before, none after,
// skipping case-ignorable characters either way.
func finalSigma(runes []rune, at int) bool {
	cased := func(r rune) bool { return unicode.In(r, unicode.Lu, unicode.Ll, unicode.Lt) }
	ignorable := func(r rune) bool {
		return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk) || strings.ContainsRune("'.:·’", r)
	}
	i := at - 1
	for i >= 0 && ignorable(runes[i]) {
		i--
	}
	if i < 0 || !cased(runes[i]) {
		return false
	}
	for i = at + 1; i < len(runes) && ignorable(runes[i]); i++ {
	}
	return i == len(runes) || !cased(runes[i])
}

// Numeric and symbolic answers cannot lose signs, decimal points or operators.
var numericOrSymbolic = regexp.MustCompile(`[0-9+\-*/^=<>]`)

const fuzzyThreshold = 0.85

func fuzzyMatch(a, b string) bool {
	x, y := normText(a), normText(b)
	if x == "" || y == "" {
		return false
	}
	if x == y {
		return true
	}
	if numericOrSymbolic.MatchString(x + y) {
		return false
	}
	// Lengths and edits count UTF-16 units, as JavaScript strings do.
	ux, uy := utf16.Encode([]rune(x)), utf16.Encode([]rune(y))
	length := max(len(ux), len(uy))
	return length >= 4 && length <= 1000 && withinDistance(ux, uy, length)
}

// withinDistance is 1 - levenshtein/length >= threshold, stopping once a lower
// bound on the distance (the length gap, then a row's minimum) already fails.
func withinDistance(a, b []uint16, length int) bool {
	fails := func(distance int) bool { return 1-float64(distance)/float64(length) < fuzzyThreshold }
	if fails(max(len(a)-len(b), len(b)-len(a))) {
		return false
	}
	previous := make([]int, len(b)+1)
	current := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		current[0] = i
		lowest := i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			current[j] = min(current[j-1]+1, previous[j]+1, previous[j-1]+cost)
			lowest = min(lowest, current[j])
		}
		if fails(lowest) {
			return false
		}
		previous, current = current, previous
	}
	return !fails(previous[len(b)])
}

/* ---------------------------------------------------------------- quantities */

// A quantity is numerator/denominator × 10^exponent, exact: neither precision
// nor magnitude relies on floats.
type quantity struct{ numerator, denominator, exponent *big.Int }

var quantityValuePattern = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?(?:` + jsSpaceClass + `*/` + jsSpaceClass + `*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)?$`)

func decimal(value string) (coefficient, exponent *big.Int) {
	mantissa, power, _ := strings.Cut(strings.ToLower(strings.TrimFunc(value, jsSpace)), "e")
	if power == "" {
		power = "0"
	}
	coefficient, _ = new(big.Int).SetString(strings.Replace(mantissa, ".", "", 1), 10)
	exponent, _ = new(big.Int).SetString(power, 10)
	if dot := strings.Index(mantissa, "."); dot >= 0 {
		exponent.Sub(exponent, big.NewInt(int64(len(mantissa)-dot-1)))
	}
	return coefficient, exponent
}

func quantityValue(value string) (quantity, bool) {
	input := strings.TrimFunc(value, jsSpace)
	if !quantityValuePattern.MatchString(input) {
		return quantity{}, false
	}
	numerator, denominator, fraction := strings.Cut(input, "/")
	if !fraction {
		denominator = "1"
	}
	n, nExp := decimal(numerator)
	d, dExp := decimal(denominator)
	if n == nil || d == nil || d.Sign() == 0 {
		return quantity{}, false
	}
	return quantity{n, d, nExp.Sub(nExp, dExp)}, true
}

func sameQuantity(a, b quantity) bool {
	normalize := func(coefficient, exponent *big.Int) (*big.Int, *big.Int) {
		exponent = new(big.Int).Set(exponent)
		if coefficient.Sign() == 0 {
			return coefficient, big.NewInt(0)
		}
		ten, rest := big.NewInt(10), new(big.Int)
		for {
			quotient, remainder := new(big.Int).QuoRem(coefficient, ten, rest)
			if remainder.Sign() != 0 {
				return coefficient, exponent
			}
			coefficient = quotient
			exponent.Add(exponent, big.NewInt(1))
		}
	}
	leftC, leftE := normalize(new(big.Int).Mul(a.numerator, b.denominator), a.exponent)
	rightC, rightE := normalize(new(big.Int).Mul(b.numerator, a.denominator), b.exponent)
	return leftC.Cmp(rightC) == 0 && leftE.Cmp(rightE) == 0
}

// Graded returns a copy of q as a checked answer shows it: the whole question
// with its key, and each part's awarded marks. Closed parts are scored here;
// matching and gaps parts also carry itemResults, one per pair or gap. Open
// parts take Jev's per-item marks from open by part id, and a part missing
// from open (a blank answer) earns 0 on every item. It returns the awarded
// marks and the question's marks too. q itself is not modified.
func Graded(q map[string]any, answers map[string]any, open map[string][]float64) (map[string]any, float64, float64) {
	out := make(map[string]any, len(q))
	for key, value := range q {
		out[key] = value
	}
	list, _ := q["parts"].([]any)
	parts := make([]any, 0, len(list))
	var awarded, total float64
	for _, raw := range list {
		p, _ := raw.(map[string]any)
		part := make(map[string]any, len(p)+2)
		for key, value := range p {
			part[key] = value
		}
		id, _ := p["id"].(string)
		marks, _ := num(p["marks"])
		a, _ := p["answer"].(map[string]any)
		var score float64
		if a["type"] == "open" {
			_, itemMarks := MarkItems(p)
			items := open[id]
			if items == nil {
				items = make([]float64, len(itemMarks))
			}
			score = min(marks, max(0, sum(items)))
			part["itemAwards"] = items
		} else {
			var items []bool
			score, items = ScorePart(p, answers[id])
			if a["type"] == "matching" || a["type"] == "gaps" {
				part["itemResults"] = items
			}
		}
		part["awarded"] = score
		awarded, total = awarded+score, total+marks
		parts = append(parts, part)
	}
	out["parts"] = parts
	return out, awarded, total
}
