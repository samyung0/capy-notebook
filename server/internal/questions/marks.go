package questions

import (
	"strings"
	"unicode"
)

// StripMarks drops a question text's bold, italic and underline markers
// (`**bold**`, `*italic*`, `__underline__`), keeping the words and formulas as
// written, for search and plain one-line listings. It reads markers as
// src/features/questions/parseMarkedText.ts does: only tight pairs of one to
// three `*` or exactly two `_` outside `$…$` math, CommonMark's rule of three
// included, `__` marking inside a word as `**` does, `\*` and `\_` escaping a marker
// character and `\\` before one a backslash.
func StripMarks(text string) string {
	if !strings.ContainsAny(text, "*_") {
		return text
	}
	type atom struct {
		ch      rune
		escaped bool
		math    string // a whole formula as written, one character of content
	}
	var atoms []atom
	for _, token := range mathTokens([]rune(text)) {
		if token.kind != 't' {
			delim := "$"
			if token.kind == 'd' {
				delim = "$$"
			}
			atoms = append(atoms, atom{math: delim + token.value + delim})
			continue
		}
		// Backslashes right before a marker character pair up: `\\` is a
		// backslash and an odd one escapes the character.
		value := []rune(token.value)
		for i := 0; i < len(value); i++ {
			if value[i] != '\\' {
				atoms = append(atoms, atom{ch: value[i]})
				continue
			}
			end := i
			for end < len(value) && value[end] == '\\' {
				end++
			}
			marker := end < len(value) && (value[end] == '*' || value[end] == '_')
			literal := end - i
			if marker {
				literal /= 2
			}
			for range literal {
				atoms = append(atoms, atom{ch: '\\'})
			}
			if marker && (end-i)%2 == 1 {
				atoms = append(atoms, atom{ch: value[end], escaped: true})
				end++
			}
			i = end - 1
		}
	}
	marker := func(i int) rune {
		if a := atoms[i]; a.math == "" && !a.escaped && (a.ch == '*' || a.ch == '_') {
			return a.ch
		}
		return 0
	}
	space := func(i int) bool {
		if i < 0 || i >= len(atoms) {
			return true
		}
		a := atoms[i]
		return a.math == "" && !a.escaped && unicode.IsSpace(a.ch)
	}
	type run struct {
		at, length, left  int
		ch                rune
		canOpen, canClose bool
	}
	var runs []*run
	for i := 0; i < len(atoms); {
		ch := marker(i)
		if ch == 0 {
			i++
			continue
		}
		end := i + 1
		for end < len(atoms) && marker(end) == ch {
			end++
		}
		length := end - i
		canOpen, canClose := !space(end), !space(i-1)
		if (ch == '*' && length <= 3) || (ch == '_' && length == 2) {
			runs = append(runs, &run{at: i, length: length, left: length, ch: ch, canOpen: canOpen, canClose: canClose})
		}
		i = end
	}
	var openers []*run
	for _, r := range runs {
		for r.canClose && r.left > 0 {
			j := len(openers) - 1
			for ; j >= 0; j-- {
				o := openers[j]
				if o.ch != r.ch {
					continue
				}
				both := (o.canOpen && o.canClose) || (r.canOpen && r.canClose)
				sum := o.length + r.length
				if !both || sum%3 != 0 || (o.length%3 == 0 && r.length%3 == 0) {
					break
				}
			}
			if j < 0 {
				break
			}
			o := openers[j]
			n := 1
			if r.ch == '_' || (o.left >= 2 && r.left >= 2) {
				n = 2
			}
			o.left -= n
			r.left -= n
			if o.left > 0 {
				openers = openers[:j+1]
			} else {
				openers = openers[:j]
			}
		}
		if r.canOpen && r.left > 0 {
			openers = append(openers, r)
		}
	}
	var out strings.Builder
	next := 0
	for i := 0; i < len(atoms); {
		if next < len(runs) && runs[next].at == i {
			r := runs[next]
			out.WriteString(strings.Repeat(string(r.ch), r.left))
			i += r.length
			next++
			continue
		}
		if a := atoms[i]; a.math != "" {
			out.WriteString(a.math)
		} else {
			out.WriteRune(a.ch)
		}
		i++
	}
	return out.String()
}

type mathToken struct {
	kind  byte // 't' text, 'i' inline formula, 'd' display formula
	value string
}

// mathTokens splits text and formulas as src/features/questions/parseMathText.ts
// does: only paired, unescaped `$` or `$$` delimiters make a formula.
func mathTokens(s []rune) []mathToken {
	var tokens []mathToken
	var text []rune
	at := func(i int) rune {
		if i < 0 || i >= len(s) {
			return 0
		}
		return s[i]
	}
	for i := 0; i < len(s); {
		// Backslashes right before a `$` pair up: `\\` is a backslash and an
		// odd one escapes the dollar; an even run leaves it a delimiter.
		if s[i] == '\\' {
			end := i
			for end < len(s) && s[end] == '\\' {
				end++
			}
			if at(end) != '$' {
				text = append(text, s[i:end]...)
				i = end
				continue
			}
			for range (end - i) / 2 {
				text = append(text, '\\')
			}
			if (end-i)%2 == 1 {
				text = append(text, '$')
				end++
			}
			i = end
			continue
		}
		if s[i] != '$' {
			text = append(text, s[i])
			i++
			continue
		}
		width := 1
		if at(i+1) == '$' {
			width = 2
		}
		end := i + width
		for end < len(s) {
			if s[end] == '\\' {
				end += 2
				continue
			}
			if s[end] == '$' && (width == 1 && at(end+1) != '$' && at(end-1) != '$' || width == 2 && at(end+1) == '$') {
				break
			}
			end++
		}
		if end >= len(s) || end == i+width {
			text = append(text, s[i:i+width]...)
			i += width
			continue
		}
		if len(text) > 0 {
			tokens = append(tokens, mathToken{'t', string(text)})
			text = nil
		}
		kind := byte('i')
		if width == 2 {
			kind = 'd'
		}
		tokens = append(tokens, mathToken{kind, string(s[i+width : end])})
		i = end + width
	}
	if len(text) > 0 {
		tokens = append(tokens, mathToken{'t', string(text)})
	}
	return tokens
}
