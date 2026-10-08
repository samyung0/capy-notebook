package bank

import (
	"encoding/base64"
	"slices"
	"strconv"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// ListFilter narrows and pages a topic's rows. Empty filters keep every row.
// The topic is filtered in memory: rows come from one List query, and the
// paged API lets stored columns replace this later without a contract change.
type ListFilter struct {
	Types []string
	// Statuses are bankStatus values matched against Marks: correct, wrong,
	// partial, notDone.
	Statuses   []string
	Marks      map[string]float64
	Search     string
	Unreviewed bool
	Limit      int
	// Cursor is a TopicPage's NextCursor or PrevCursor; Around, a question id,
	// picks the page holding it and applies only without a cursor.
	Cursor string
	Around string
}

// TopicPage is one page of a topic's filtered rows in position order. Cursors
// carry a position, not an offset, so rows that stop matching between
// requests (a question answered while the Status filter is on) shift nothing.
type TopicPage struct {
	Items       []Row    `json:"items" nullable:"false"`
	NextCursor  string   `json:"nextCursor,omitempty"`
	PrevCursor  string   `json:"prevCursor,omitempty"`
	AnswerTypes []string `json:"answerTypes" nullable:"false" doc:"The answer types present in the topic, for the Question type filter"`
}

// Statuses are the Status filter's values.
var Statuses = []string{"correct", "wrong", "partial", "notDone"}

// status mirrors the page's bankStatus: full marks correct, none wrong,
// anything between partial, no current result not done.
func status(score float64, answered bool) string {
	switch {
	case !answered:
		return "notDone"
	case score >= 1:
		return "correct"
	case score <= 0:
		return "wrong"
	}
	return "partial"
}

func (f ListFilter) keeps(row Row) bool {
	if len(f.Types) > 0 && !slices.ContainsFunc(row.AnswerTypes, func(t string) bool { return slices.Contains(f.Types, t) }) {
		return false
	}
	if len(f.Statuses) > 0 {
		score, answered := f.Marks[row.ID]
		if !slices.Contains(f.Statuses, status(score, answered)) {
			return false
		}
	}
	if f.Unreviewed && row.ReviewedAt != nil {
		return false
	}
	return f.Search == "" || strings.Contains(strings.ToLower(row.Preview), strings.ToLower(f.Search))
}

// PageRows filters rows (in position order, as List returns them) and cuts
// one page. A malformed cursor is store.ErrInvalidCursor; an Around id that
// is not among the filtered rows starts at the top.
func PageRows(rows []Row, f ListFilter) (TopicPage, error) {
	page := TopicPage{Items: []Row{}, AnswerTypes: []string{}}
	kept := []Row{}
	for _, row := range rows {
		for _, t := range row.AnswerTypes {
			if !slices.Contains(page.AnswerTypes, t) {
				page.AnswerTypes = append(page.AnswerTypes, t)
			}
		}
		if f.keeps(row) {
			kept = append(kept, row)
		}
	}
	start, end := 0, 0
	switch {
	case f.Cursor != "":
		next, position, err := decodeCursor(f.Cursor)
		if err != nil {
			return page, err
		}
		if next {
			for start < len(kept) && kept[start].Position <= position {
				start++
			}
			end = min(start+f.Limit, len(kept))
		} else {
			for end < len(kept) && kept[end].Position < position {
				end++
			}
			start = max(0, end-f.Limit)
		}
	default:
		if i := slices.IndexFunc(kept, func(row Row) bool { return row.ID == f.Around }); i > 0 {
			start = i - i%f.Limit
		}
		end = min(start+f.Limit, len(kept))
	}
	page.Items = append(page.Items, kept[start:end]...)
	if len(page.Items) == 0 {
		return page, nil
	}
	if end < len(kept) {
		page.NextCursor = encodeCursor(true, kept[end-1].Position)
	}
	if start > 0 {
		page.PrevCursor = encodeCursor(false, kept[start].Position)
	}
	return page, nil
}

// A cursor is "n|position" (rows after it) or "p|position" (rows before it).
func encodeCursor(next bool, position int) string {
	dir := "p"
	if next {
		dir = "n"
	}
	return base64.RawURLEncoding.EncodeToString([]byte(dir + "|" + strconv.Itoa(position)))
}

func decodeCursor(cursor string) (next bool, position int, err error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return false, 0, store.ErrInvalidCursor
	}
	dir, value, _ := strings.Cut(string(raw), "|")
	position, err = strconv.Atoi(value)
	if err != nil || (dir != "n" && dir != "p") {
		return false, 0, store.ErrInvalidCursor
	}
	return dir == "n", position, nil
}
