package materialdoc

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

// A note's table view (Epo 2026-11-12): its block holds columns, rows and
// views, which a room merges entry by entry. Writers keep only the structural
// rules (src/features/notes/tableView/model.ts isTableViewBlock), so what a
// merge leaves (a cell of a deleted column, a value that no longer fits its
// column, a sort naming a gone column) passes and readers draw it as empty.
// The collaboration server's store and room admission keep the same rules,
// with these messages.

// TableViewType is the table view element: void and top-level, notes only.
const TableViewType = "table_view"

var (
	tableViewColumnKinds = []string{"title", "text", "number", "select", "date", "checkbox"}
	tableViewViewKinds   = []string{"table", "kanban"}
	tableViewColors      = []string{"gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"}
	tableViewID          = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	tableViewDate        = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	tableViewDecimal     = regexp.MustCompile(`^-?[0-9]+(\.[0-9]+)?$`)
)

// utf16Len counts UTF-16 units, as the browser measures a string.
func utf16Len(s string) int {
	units := 0
	for _, r := range s {
		units += utf16.RuneLen(r)
	}
	return units
}

func tableViewIDOK(value any) bool {
	id, ok := value.(string)
	return ok && len(id) <= embeds.TableViewIDMax && tableViewID.MatchString(id)
}

func tableViewNameOK(value any) bool {
	name, ok := value.(string)
	return ok && utf16Len(name) <= embeds.TableViewNameMax
}

// tableViewKeys refuses a key outside the closed set of what it names.
func tableViewKeys(what string, value map[string]any, keys ...string) error {
	for key := range value {
		if !slices.Contains(keys, key) {
			return fmt.Errorf("unexpected table view %s field %s", what, key)
		}
	}
	return nil
}

// tableViewList is a list of objects with unique ids, of min to max entries.
func tableViewList(what string, value any, least, most int) ([]map[string]any, error) {
	raw, ok := value.([]any)
	if !ok || len(raw) < least || len(raw) > most {
		return nil, fmt.Errorf("table view %ss must be a list of %d to %d", what, least, most)
	}
	out := make([]map[string]any, len(raw))
	ids := map[string]bool{}
	for i, entry := range raw {
		item, ok := entry.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("table view %s must be an object", what)
		}
		if !tableViewIDOK(item["id"]) {
			return nil, fmt.Errorf("table view %s id must be 1 to %d letters, digits, _ or -", what, embeds.TableViewIDMax)
		}
		id := item["id"].(string)
		if ids[id] {
			return nil, fmt.Errorf("duplicate table view %s id %s", what, id)
		}
		ids[id] = true
		out[i] = item
	}
	return out, nil
}

func validateTableView(node map[string]any) error {
	if err := requireID(node); err != nil {
		return err
	}
	block, ok := node["block"].(map[string]any)
	if !ok {
		return errors.New("table view block must be an object")
	}
	if err := tableViewKeys("block", block, "title", "columns", "rows", "views"); err != nil {
		return err
	}
	if !tableViewNameOK(block["title"]) {
		return fmt.Errorf("table view title must be a string of at most %d characters", embeds.TableViewNameMax)
	}
	columns, err := tableViewList("column", block["columns"], 1, embeds.TableViewColumnsMax)
	if err != nil {
		return err
	}
	titles := 0
	for _, column := range columns {
		if err := validateTableViewColumn(column); err != nil {
			return err
		}
		if column["kind"] == "title" {
			titles++
		}
	}
	if titles != 1 {
		return errors.New("table view needs exactly one title column")
	}
	rows, err := tableViewList("row", block["rows"], 0, embeds.TableViewRowsMax)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := validateTableViewRow(row); err != nil {
			return err
		}
	}
	views, err := tableViewList("view", block["views"], 1, embeds.TableViewViewsMax)
	if err != nil {
		return err
	}
	for _, view := range views {
		if err := validateTableViewView(view); err != nil {
			return err
		}
	}
	return nil
}

func validateTableViewColumn(column map[string]any) error {
	if err := tableViewKeys("column", column, "id", "name", "kind", "options"); err != nil {
		return err
	}
	if !tableViewNameOK(column["name"]) {
		return fmt.Errorf("table view column name must be a string of at most %d characters", embeds.TableViewNameMax)
	}
	kind, _ := column["kind"].(string)
	if !slices.Contains(tableViewColumnKinds, kind) {
		return errors.New("unknown table view column kind")
	}
	options, held := column["options"]
	if kind != "select" {
		if held {
			return errors.New("table view options are on select columns only")
		}
		return nil
	}
	list, err := tableViewList("option", options, 0, embeds.TableViewOptionsMax)
	if err != nil {
		return err
	}
	for _, option := range list {
		if err := tableViewKeys("option", option, "id", "name", "color"); err != nil {
			return err
		}
		if !tableViewNameOK(option["name"]) {
			return fmt.Errorf("table view option name must be a string of at most %d characters", embeds.TableViewNameMax)
		}
		if color, _ := option["color"].(string); !slices.Contains(tableViewColors, color) {
			return errors.New("unknown table view option color")
		}
	}
	return nil
}

func validateTableViewRow(row map[string]any) error {
	if err := tableViewKeys("row", row, "id", "cells"); err != nil {
		return err
	}
	cells, ok := row["cells"].(map[string]any)
	if !ok || len(cells) > embeds.TableViewColumnsMax {
		return fmt.Errorf("table view cells must be an object of at most %d", embeds.TableViewColumnsMax)
	}
	for key, value := range cells {
		if !tableViewIDOK(key) {
			return fmt.Errorf("table view cell key must be 1 to %d letters, digits, _ or -", embeds.TableViewIDMax)
		}
		if !tableViewCellOK(value) {
			return fmt.Errorf("table view cell must be a string of at most %d characters, a number of at most %d or a boolean",
				embeds.TableViewCellMax, embeds.TableViewNumberMax)
		}
	}
	return nil
}

func tableViewCellOK(value any) bool {
	switch v := value.(type) {
	case bool:
		return true
	case string:
		return utf16Len(v) <= embeds.TableViewCellMax
	}
	n, ok := number(value)
	return ok && !math.IsInf(n, 0) && !math.IsNaN(n) && math.Abs(n) <= embeds.TableViewNumberMax
}

func validateTableViewView(view map[string]any) error {
	if err := tableViewKeys("view", view, "id", "name", "kind", "sort", "groupBy"); err != nil {
		return err
	}
	if !tableViewNameOK(view["name"]) {
		return fmt.Errorf("table view view name must be a string of at most %d characters", embeds.TableViewNameMax)
	}
	kind, _ := view["kind"].(string)
	if !slices.Contains(tableViewViewKinds, kind) {
		return errors.New("unknown table view view kind")
	}
	if groupBy, held := view["groupBy"]; held && (kind != "kanban" || !tableViewIDOK(groupBy)) {
		return errors.New("table view groupBy must be a column id on a kanban view")
	}
	sort, held := view["sort"]
	if !held {
		return nil
	}
	fields, ok := sort.(map[string]any)
	if !ok {
		return errors.New("table view sort must be an object")
	}
	if err := tableViewKeys("sort", fields, "columnId", "dir"); err != nil {
		return err
	}
	if !tableViewIDOK(fields["columnId"]) || (fields["dir"] != "asc" && fields["dir"] != "desc") {
		return errors.New("table view sort needs a column id and asc or desc")
	}
	return nil
}

// tableViewIndexText is a table view's title as a line, then its first
// view's rows as a Markdown table (model.ts tableViewText): the title column
// first, each cell as drawn, `|` escaped and line breaks as spaces. A stored
// block passed the writers' check; anything else reads as what it holds.
func tableViewIndexText(block map[string]any) string {
	var lines []string
	if title, _ := block["title"].(string); strings.TrimSpace(title) != "" {
		lines = append(lines, strings.TrimSpace(title), "")
	}
	all := maps(block["columns"])
	if len(all) == 0 {
		return strings.Join(lines, "\n")
	}
	var columns []map[string]any
	for _, title := range []bool{true, false} {
		for _, column := range all {
			if (column["kind"] == "title") == title {
				columns = append(columns, column)
			}
		}
	}
	line := func(cell func(column map[string]any) string) string {
		cells := make([]string, len(columns))
		for i, column := range columns {
			cells[i] = tableViewEscape.Replace(cell(column))
		}
		return tableRow(cells)
	}
	lines = append(lines,
		line(func(column map[string]any) string { name, _ := column["name"].(string); return name }),
		line(func(map[string]any) string { return "---" }))
	var view map[string]any
	if views := maps(block["views"]); len(views) > 0 {
		view = views[0]
	}
	for _, row := range tableViewRows(all, maps(block["rows"]), view) {
		lines = append(lines, line(func(column map[string]any) string { return tableViewCellText(column, row) }))
	}
	return strings.Join(lines, "\n")
}

var tableViewEscape = strings.NewReplacer("\r\n", " ", "\n", " ", "|", `\|`)

// tableViewCell is a cell as its column reads it (model.ts cellValue): a
// string, a float64 or a bool, or nil when it is empty or doesn't fit. A
// number shows in a text column, and a decimal number written as text in a
// number column.
func tableViewCell(column, row map[string]any) any {
	cells, _ := row["cells"].(map[string]any)
	id, _ := column["id"].(string)
	value := cells[id]
	switch column["kind"] {
	case "title", "text":
		if s, ok := value.(string); ok {
			return s
		}
		if n, ok := number(value); ok {
			return jsNumber(n)
		}
	case "number":
		if n, ok := number(value); ok {
			return n
		}
		if s, ok := value.(string); ok && tableViewDecimal.MatchString(strings.TrimSpace(s)) {
			n, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
			return n
		}
	case "select":
		if tableViewOption(column, value) != nil {
			return value
		}
	case "date":
		if s, ok := value.(string); ok && tableViewDate.MatchString(s) {
			return s
		}
	case "checkbox":
		if b, ok := value.(bool); ok {
			return b
		}
	}
	return nil
}

// tableViewOption is the select option a cell names, if it still exists.
func tableViewOption(column map[string]any, value any) map[string]any {
	id, ok := value.(string)
	if !ok {
		return nil
	}
	for _, option := range maps(column["options"]) {
		if option["id"] == id {
			return option
		}
	}
	return nil
}

// tableViewCellText is a cell as plain text (model.ts cellText): option
// names, ISO dates, ☑/☐ for checkboxes, "" when empty.
func tableViewCellText(column, row map[string]any) string {
	switch value := tableViewCell(column, row).(type) {
	case nil:
		if column["kind"] == "checkbox" {
			return "☐"
		}
		return ""
	case bool:
		if value {
			return "☑"
		}
		return "☐"
	case float64:
		return jsNumber(value)
	case string:
		if column["kind"] == "select" {
			name, _ := tableViewOption(column, value)["name"].(string)
			return name
		}
		return value
	}
	return ""
}

// tableViewRows are the rows in the view's order (model.ts sortedRows): its
// sort when it names a column, empty cells last whatever the direction and
// ties in list order; else list order. Text compares by code point, where
// the browser's localeCompare follows the reader's locale.
func tableViewRows(columns, rows []map[string]any, view map[string]any) []map[string]any {
	sort, _ := view["sort"].(map[string]any)
	var column map[string]any
	for _, c := range columns {
		if sort != nil && c["id"] == sort["columnId"] {
			column = c
			break
		}
	}
	if column == nil {
		return rows
	}
	dir := -1
	if sort["dir"] == "asc" {
		dir = 1
	}
	// rank is a row's sort key: a number (an option's place for a select
	// column, 0 or 1 for a checkbox), a string, or nil for an empty cell.
	rank := func(row map[string]any) any {
		value := tableViewCell(column, row)
		if column["kind"] == "select" {
			for i, option := range maps(column["options"]) {
				if value != nil && option["id"] == value {
					return float64(i)
				}
			}
			return nil
		}
		switch v := value.(type) {
		case string:
			if v == "" {
				return nil
			}
		case bool:
			if v {
				return 1.0
			}
			return 0.0
		}
		return value
	}
	ranks := make([]any, len(rows))
	for i, row := range rows {
		ranks[i] = rank(row)
	}
	order := make([]int, len(rows))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int {
		ra, rb := ranks[a], ranks[b]
		switch {
		case ra == nil && rb == nil:
			return 0
		case ra == nil:
			return 1
		case rb == nil:
			return -1
		}
		// A column's ranks are all numbers or all strings.
		if na, ok := ra.(float64); ok {
			return dir * cmpFloat(na, rb.(float64))
		}
		return dir * strings.Compare(ra.(string), rb.(string))
	})
	out := make([]map[string]any, len(rows))
	for i, at := range order {
		out[i] = rows[at]
	}
	return out
}

func cmpFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// jsNumber writes a number as JavaScript's String(n) does, as the browser
// draws a table view's cell: plain decimal, an exponent below 1e-6 and from
// 1e21, -0 as 0.
func jsNumber(n float64) string {
	switch {
	case n == 0:
		return "0"
	case math.IsInf(n, 1):
		return "Infinity"
	case math.IsInf(n, -1):
		return "-Infinity"
	case math.Abs(n) >= 1e-6 && math.Abs(n) < 1e21:
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	mantissa, exp, _ := strings.Cut(strconv.FormatFloat(n, 'e', -1, 64), "e")
	e, _ := strconv.Atoi(exp)
	if e < 0 {
		return mantissa + "e-" + strconv.Itoa(-e)
	}
	return mantissa + "e+" + strconv.Itoa(e)
}
