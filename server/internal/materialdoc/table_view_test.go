package materialdoc

import (
	"fmt"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

// fullTableView is a table view block at every limit: the most columns,
// rows, views and options, ids and names at their longest (a name ending in
// a surrogate pair, counted as two UTF-16 units), the longest cell and the
// largest numbers.
func fullTableView() map[string]any {
	id := func(prefix string, i int) string {
		s := fmt.Sprintf("%s%d", prefix, i)
		return s + strings.Repeat("_", embeds.TableViewIDMax-len(s))
	}
	name := strings.Repeat("n", embeds.TableViewNameMax-2) + "😀"
	options := []any{}
	for i := range embeds.TableViewOptionsMax {
		options = append(options, map[string]any{"id": id("o", i), "name": name, "color": "red"})
	}
	columns := []any{
		map[string]any{"id": id("c", 0), "name": name, "kind": "title"},
		map[string]any{"id": id("c", 1), "name": name, "kind": "select", "options": options},
	}
	for i := 2; i < embeds.TableViewColumnsMax; i++ {
		kinds := []string{"text", "number", "date", "checkbox"}
		columns = append(columns, map[string]any{"id": id("c", i), "name": name, "kind": kinds[i%4]})
	}
	rows := []any{}
	for i := range embeds.TableViewRowsMax {
		row := map[string]any{"id": id("r", i)}
		for c := range embeds.TableViewColumnsMax {
			row[id("c", c)] = []any{strings.Repeat("x", embeds.TableViewCellMax), float64(embeds.TableViewNumberMax), -float64(embeds.TableViewNumberMax), true}[c%4]
		}
		rows = append(rows, row)
	}
	views := []any{}
	for i := range embeds.TableViewViewsMax {
		view := map[string]any{"id": id("v", i), "name": name, "kind": "table", "sort": map[string]any{"columnId": id("c", 0), "dir": "desc"}}
		if i%2 == 1 {
			view["kind"], view["groupBy"] = "kanban", id("c", 1)
		}
		views = append(views, view)
	}
	return map[string]any{"title": name, "columns": columns, "rows": rows, "views": views}
}

func tableViewNode(id string, block map[string]any) map[string]any {
	return map[string]any{"type": TableViewType, "id": id, "block": block, "children": []any{textLeaf("")}}
}

func smallTableView() map[string]any {
	return map[string]any{
		"title": "Tracker",
		"columns": []any{
			map[string]any{"id": "c_title", "name": "Topic", "kind": "title"},
			map[string]any{"id": "c_status", "name": "Status", "kind": "select", "options": []any{
				map[string]any{"id": "o_1", "name": "Done", "color": "green"},
			}},
		},
		"rows":  []any{map[string]any{"id": "r_1", "c_title": "Krebs"}},
		"views": []any{map[string]any{"id": "v_1", "name": "Table", "kind": "table"}},
	}
}

// A block at every limit passes, and so do twice TableViewMaxCount of them in
// a note, as two people inserting at once may pass the count (Epo
// 2026-11-22); one more is refused.
func TestTableViewAtItsLimitsPasses(t *testing.T) {
	if err := validateAs(embeds.Note, reparse(t, []map[string]any{tableViewNode("tv", fullTableView())})); err != nil {
		t.Fatalf("a table view at its limits is refused: %v", err)
	}
	var nodes []map[string]any
	for i := range 2 * embeds.TableViewMaxCount {
		nodes = append(nodes, tableViewNode(fmt.Sprintf("tv%d", i), smallTableView()))
	}
	if err := validateAs(embeds.Note, reparse(t, nodes)); err != nil {
		t.Fatalf("%d table views are refused: %v", 2*embeds.TableViewMaxCount, err)
	}
	nodes = append(nodes, tableViewNode("tv_over", smallTableView()))
	if err := validateAs(embeds.Note, reparse(t, nodes)); err == nil || !strings.Contains(err.Error(), "table views over") {
		t.Fatalf("table view %d: %v", 2*embeds.TableViewMaxCount+1, err)
	}
}

// Two people's adds at once may take a list past its cap: columns, rows,
// views and options pass up to twice theirs (Epo 2026-11-22).
func TestTableViewListsMergedPastTheirCapsPass(t *testing.T) {
	block := smallTableView()
	columns := block["columns"].([]any)
	options := []any{}
	for i := range 2 * embeds.TableViewOptionsMax {
		options = append(options, map[string]any{"id": fmt.Sprintf("o_%d", i), "name": "", "color": "red"})
	}
	columns[1].(map[string]any)["options"] = options
	for i := len(columns); i < 2*embeds.TableViewColumnsMax; i++ {
		columns = append(columns, map[string]any{"id": fmt.Sprintf("c_%d", i), "name": "", "kind": "text"})
	}
	block["columns"] = columns
	rows := []any{}
	for i := range 2 * embeds.TableViewRowsMax {
		rows = append(rows, map[string]any{"id": fmt.Sprintf("r_%d", i)})
	}
	block["rows"] = rows
	views := []any{}
	for i := range 2 * embeds.TableViewViewsMax {
		views = append(views, map[string]any{"id": fmt.Sprintf("v_%d", i), "name": "", "kind": "table"})
	}
	block["views"] = views
	if err := validateAs(embeds.Note, reparse(t, []map[string]any{tableViewNode("tv", block)})); err != nil {
		t.Fatalf("lists at twice their caps are refused: %v", err)
	}
}

// What a merge leaves passes: a cell of a deleted column, a value that does
// not fit its column, a sort or group naming a gone or wrong column, and no
// view at all (two writers deleting the last two, Revision 2).
func TestTableViewKeepsWhatMergesLeave(t *testing.T) {
	block := smallTableView()
	block["rows"] = []any{map[string]any{"id": "r_1", "c_gone": "x", "c_status": 4.5, "c_title": true}}
	block["views"] = []any{map[string]any{"id": "v_1", "name": "Board", "kind": "kanban", "groupBy": "c_title", "sort": map[string]any{"columnId": "c_gone", "dir": "asc"}}}
	if err := validateAs(embeds.Note, reparse(t, []map[string]any{tableViewNode("tv", block)})); err != nil {
		t.Fatal(err)
	}
	block["views"] = []any{}
	if err := validateAs(embeds.Note, reparse(t, []map[string]any{tableViewNode("tv", block)})); err != nil {
		t.Fatalf("a block without views is refused: %v", err)
	}
}

func TestTableViewRefusesBrokenStructure(t *testing.T) {
	column := func(block map[string]any, i int) map[string]any { return block["columns"].([]any)[i].(map[string]any) }
	// A list one past twice its cap (two people's adds at once reach twice it,
	// Epo 2026-11-22), after the entries `keep` of the full block.
	pastTwice := func(key string, keep, limit int, entry func(i int) map[string]any) func(map[string]any) {
		return func(b map[string]any) {
			list := append([]any{}, b[key].([]any)[:keep]...)
			for i := len(list); i <= 2*limit; i++ {
				list = append(list, entry(i))
			}
			b[key] = list
		}
	}
	for name, mutate := range map[string]func(map[string]any){
		"two title columns": func(b map[string]any) { column(b, 1)["kind"] = "title"; delete(column(b, 1), "options") },
		"no title column":   func(b map[string]any) { column(b, 0)["kind"] = "text" },
		"a column past twice the cap": pastTwice("columns", 1, embeds.TableViewColumnsMax, func(i int) map[string]any {
			return map[string]any{"id": fmt.Sprintf("c_more%d", i), "name": "More", "kind": "text"}
		}),
		"a view past twice the cap": pastTwice("views", 0, embeds.TableViewViewsMax, func(i int) map[string]any {
			return map[string]any{"id": fmt.Sprintf("v_more%d", i), "name": "More", "kind": "table"}
		}),
		"an option past twice the cap": func(b map[string]any) {
			options := []any{}
			for i := range 2*embeds.TableViewOptionsMax + 1 {
				options = append(options, map[string]any{"id": fmt.Sprintf("o_more%d", i), "name": "More", "color": "red"})
			}
			column(b, 1)["options"] = options
		},
		"a bad column kind": func(b map[string]any) { column(b, 0)["kind"] = "formula" },
		"a bad view kind":   func(b map[string]any) { b["views"].([]any)[0].(map[string]any)["kind"] = "calendar" },
		"a bad colour":      func(b map[string]any) { column(b, 1)["options"].([]any)[0].(map[string]any)["color"] = "teal" },
		"a bad sort dir": func(b map[string]any) {
			b["views"].([]any)[0].(map[string]any)["sort"] = map[string]any{"columnId": "c_title", "dir": "up"}
		},
		"a bad id":    func(b map[string]any) { column(b, 0)["id"] = "c title" },
		"an empty id": func(b map[string]any) { b["rows"].([]any)[0].(map[string]any)["id"] = "" },
		"a long id":   func(b map[string]any) { column(b, 0)["id"] = strings.Repeat("c", embeds.TableViewIDMax+1) },
		"a bad cell key": func(b map[string]any) {
			b["rows"].([]any)[0].(map[string]any)["c.title"] = "x"
		},
		"a duplicate column id":        func(b map[string]any) { column(b, 1)["id"] = "c_title" },
		"an unknown block key":         func(b map[string]any) { b["filter"] = "x" },
		"an unknown column key":        func(b map[string]any) { column(b, 0)["width"] = 120 },
		"options on a text column":     func(b map[string]any) { column(b, 0)["options"] = []any{} },
		"a select column without them": func(b map[string]any) { delete(column(b, 1), "options") },
		"groupBy on a table view":      func(b map[string]any) { b["views"].([]any)[0].(map[string]any)["groupBy"] = "c_status" },
		"a long name":                  func(b map[string]any) { b["title"] = strings.Repeat("n", embeds.TableViewNameMax-1) + "😀" },
		"a long cell": func(b map[string]any) {
			b["rows"].([]any)[0].(map[string]any)["c_title"] = strings.Repeat("x", embeds.TableViewCellMax+1)
		},
		"a large number": func(b map[string]any) {
			b["rows"].([]any)[0].(map[string]any)["c_title"] = 1e15 + 1
		},
		"a null cell": func(b map[string]any) {
			b["rows"].([]any)[0].(map[string]any)["c_title"] = nil
		},
		"a list cell": func(b map[string]any) {
			b["rows"].([]any)[0].(map[string]any)["c_title"] = []any{}
		},
		"a null title":   func(b map[string]any) { b["title"] = nil },
		"missing views":  func(b map[string]any) { delete(b, "views") },
		"an id led by _": func(b map[string]any) { column(b, 0)["id"] = "__proto__" },
		"a column id id": func(b map[string]any) { column(b, 0)["id"] = "id" },
		"a cells key":    func(b map[string]any) { b["rows"].([]any)[0].(map[string]any)["cells"] = map[string]any{} },
		"a cell too many": func(b map[string]any) {
			row := b["rows"].([]any)[0].(map[string]any)
			for i := range 2 * embeds.TableViewColumnsMax {
				row[fmt.Sprintf("c%d", i)] = "x"
			}
		},
		"a row past twice the cap": func(b map[string]any) {
			for i := range 2 * embeds.TableViewRowsMax {
				b["rows"] = append(b["rows"].([]any), map[string]any{"id": fmt.Sprintf("r_more%d", i)})
			}
		},
	} {
		block := smallTableView()
		mutate(block)
		if err := validateAs(embeds.Note, reparse(t, []map[string]any{tableViewNode("tv", block)})); err == nil {
			t.Errorf("%s is accepted", name)
		}
	}
}
