package agenttools

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// Every input schema must be a closed object so unknown model arguments are
// rejected by the Python validator rather than silently ignored.
func TestDefinitionsAreClosedObjects(t *testing.T) {
	seen := map[string]bool{}
	for _, def := range Definitions() {
		if seen[def.Name] {
			t.Fatalf("duplicate tool %q", def.Name)
		}
		seen[def.Name] = true
		if def.Version < 1 || def.Description == "" || def.Concurrency == "" {
			t.Fatalf("%s: incomplete definition", def.Name)
		}
		if len(def.RequiredOperations) == 0 || len(def.AllowedSlots) == 0 {
			t.Fatalf("%s: missing operations or slots", def.Name)
		}
		if def.Mutates != (def.Concurrency == "mutate") {
			t.Fatalf("%s: mutate flag and concurrency class disagree", def.Name)
		}
		switch def.Retention {
		case RetainFull, RetainCitedPassages, RetainUsedExcerpts, RetainNone:
		default:
			t.Fatalf("%s: missing conversation-result retention", def.Name)
		}
		assertClosed(t, def.Name, def.InputSchema)
	}
	for _, name := range []string{
		"search_workspace", "create_material", "trash_file",
		"search_knowledge", "read_knowledge", "capture_knowledge_page",
	} {
		if !seen[name] {
			t.Fatalf("missing tool %s", name)
		}
	}
}

// A deck is stored as an upload is, so its tools need the role set uploads
// need (owner and editors), which is material.create's.
func TestDeckToolsNeedTheUploadRoles(t *testing.T) {
	for _, name := range []string{"create_deck", "write_slide"} {
		def := Lookup(name)
		if def == nil || !def.Mutates || len(def.RequiredOperations) != 1 || def.RequiredOperations[0] != OpMaterialCreate {
			t.Fatalf("%s = %+v", name, def)
		}
	}
}

func assertClosed(t *testing.T, name string, schema map[string]any) {
	t.Helper()
	if schema["type"] == "object" {
		// An explicit `true` marks a deliberately open payload Go validates.
		if _, explicit := schema["additionalProperties"].(bool); !explicit {
			t.Fatalf("%s: object schema without additionalProperties:false: %v", name, schema)
		}
		props, _ := schema["properties"].(map[string]any)
		for _, p := range props {
			if m, ok := p.(map[string]any); ok {
				assertClosed(t, name, m)
			}
		}
	}
	if items, ok := schema["items"].(map[string]any); ok {
		assertClosed(t, name, items)
	}
	if variants, ok := schema["oneOf"].([]any); ok {
		for _, v := range variants {
			if m, ok := v.(map[string]any); ok {
				assertClosed(t, name, m)
			}
		}
	}
}

func TestOperationsForRole(t *testing.T) {
	has := func(ops []Operation, op Operation) bool {
		for _, o := range ops {
			if o == op {
				return true
			}
		}
		return false
	}
	owner := OperationsForRole("owner")
	editor := OperationsForRole("editor")
	viewer := OperationsForRole("viewer")
	if !has(owner, OpTrashRestore) || has(editor, OpTrashRestore) || has(editor, OpTrashRead) {
		t.Fatalf("trash management must be owner-only: owner=%v editor=%v", owner, editor)
	}
	if !has(editor, OpResourceTrash) || !has(editor, OpDocumentEdit) || !has(editor, OpMaterialCreate) {
		t.Fatalf("editors must create, edit and trash: %v", editor)
	}
	if has(viewer, OpMaterialCreate) || !has(viewer, OpSourceRead) {
		t.Fatalf("viewers read only: %v", viewer)
	}
	if OperationsForRole("") != nil {
		t.Fatal("no role grants nothing")
	}
	// The library is not a workspace resource: the Library switch grants library.read
	// per turn, no role ever does.
	for _, ops := range [][]Operation{owner, editor, viewer} {
		if has(ops, OpLibraryRead) {
			t.Fatalf("library.read must not be role-derived: %v", ops)
		}
	}
}

// The committed Python asset must match the Go source of truth. Regenerate
// with `pnpm gen:openapi`.
func TestGeneratedContractIsCurrent(t *testing.T) {
	limits, err := os.ReadFile(filepath.Join("..", "..", "..", OfficeLimitsPath))
	if err != nil {
		t.Fatalf("read the engine's limits: %v (check out vendor/betteroffice)", err)
	}
	want, err := Marshal(limits)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("..", "..", "..", "pipeline", "pipeline", "generated", "agent_tools.json")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run pnpm gen:openapi)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is stale; run pnpm gen:openapi", path)
	}
}

func commandTypes(def *Definition) []string {
	commands := def.InputSchema["properties"].(map[string]any)["commands"].(map[string]any)
	var tags []string
	for _, v := range commands["items"].(map[string]any)["oneOf"].([]any) {
		tags = append(tags, v.(map[string]any)["properties"].(map[string]any)["type"].(map[string]any)["const"].(string))
	}
	return tags
}

// What each tool's result keeps between user messages (Epo 2026-10-21).
// Every edit_office_document command has a row in the engine's limit table
// for each format its description names (review r2 L4), so none escapes the
// per-call limits (Epo 2026-10-22).
func TestEveryOfficeCommandHasALimit(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", OfficeLimitsPath))
	if err != nil {
		t.Fatalf("read the engine's limits: %v (check out vendor/betteroffice)", err)
	}
	var table struct {
		Formats map[string][]struct {
			Commands []string `json:"commands"`
		} `json:"formats"`
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	for _, v := range officeCommandSchema()["oneOf"].([]any) {
		variant := v.(map[string]any)
		name := variant["properties"].(map[string]any)["type"].(map[string]any)["const"].(string)
		if name == "create" {
			continue
		}
		formats, _, _ := strings.Cut(variant["description"].(string), ":")
		for _, format := range strings.Split(formats, ", ") {
			if !slices.ContainsFunc(table.Formats[strings.ToLower(format)], func(row struct {
				Commands []string `json:"commands"`
			}) bool {
				return slices.Contains(row.Commands, name)
			}) {
				t.Errorf("%s has no %s limit in %s", name, format, OfficeLimitsPath)
			}
		}
	}
}

// Account chat's first version (Epo 2026-10-27) reads, searches, creates and
// edits, and resolves its reads' source changes (Epo 2026-10-28); trash,
// restore and study progress stay in workspace chat, and each scope searches
// with its own tools; both list with list_sources (Q523).
func TestToolScopes(t *testing.T) {
	want := map[string][]Scope{
		"search_workspace":     {ScopeWorkspace},
		"search_files_summary": {ScopeAccount}, "create_workspace": {ScopeAccount}, "list_workspaces": {ScopeAccount}, "search_files_content": {ScopeAccount},
		"read_study_progress": {ScopeWorkspace},
		"trash_file":          {ScopeWorkspace}, "list_trashed_files": {ScopeWorkspace}, "restore_file": {ScopeWorkspace},
	}
	for _, def := range Definitions() {
		scopes, ok := want[def.Name]
		if !ok {
			scopes = []Scope{ScopeWorkspace, ScopeAccount}
		}
		if !slices.Equal(def.Scopes, scopes) {
			t.Errorf("%s scopes = %v, want %v", def.Name, def.Scopes, scopes)
		}
	}
	for _, op := range AccountOperations() {
		if op == OpResourceTrash || op == OpTrashRead || op == OpTrashRestore {
			t.Fatalf("account chat was granted %s", op)
		}
	}
}

func TestRetentionBetweenMessages(t *testing.T) {
	want := map[ResultRetention][]string{
		RetainFull: {
			"list_sources", "create_material", "add_questions", "add_question_media", "create_deck",
			"write_slide", "edit_document", "trash_file", "restore_file", "edit_office_document", "search_files_summary", "create_workspace", "create_chapter", "search_knowledge", "list_workspaces",
		},
		RetainCitedPassages: {"search_workspace", "read_document", "search_web", "search_files_content"},
		RetainUsedExcerpts:  {"read_knowledge"},
		RetainNone: {
			"capture_page", "read_study_progress", "capture_knowledge_page", "read_skill",
			"resolve_source_change", "inspect_document", "list_trashed_files", "inspect_office_document",
		},
	}
	got := map[ResultRetention][]string{}
	for _, def := range Definitions() {
		got[def.Retention] = append(got[def.Retention], def.Name)
	}
	for retention, names := range want {
		slices.Sort(names)
		slices.Sort(got[retention])
		if !slices.Equal(got[retention], names) {
			t.Errorf("%s = %v, want %v", retention, got[retention], names)
		}
	}
}

// Office files have their own tools, last in the contract (the retrieval
// service appends them once office_building is read); edit_document keeps no
// Office command (Epo 2026-10-15, 2026-10-20, 2026-10-21).
func TestOfficeFilesHaveTheirOwnTools(t *testing.T) {
	defs := Definitions()
	names := []string{defs[len(defs)-2].Name, defs[len(defs)-1].Name}
	if !slices.Equal(names, []string{"inspect_office_document", "edit_office_document"}) {
		t.Fatalf("last tools = %v", names)
	}
	read, edit := Lookup("inspect_office_document"), Lookup("edit_office_document")
	if read.Mutates || !slices.Equal(read.RequiredOperations, []Operation{OpSourceRead}) || read.Retention != RetainNone {
		t.Fatalf("inspect_office_document = %+v", read)
	}
	if !edit.Mutates || !slices.Equal(edit.RequiredOperations, []Operation{OpDocumentEdit}) {
		t.Fatalf("edit_office_document = %+v", edit)
	}
	want := []string{
		"create", "set_range", "format_cells", "add_sheet", "rename_sheet", "insert_rows", "delete_rows",
		"insert_columns", "delete_columns", "delete_sheet", "replace_text", "insert_paragraph",
		"delete_paragraph", "set_list", "insert_table", "delete_table", "format_text", "set_alignment",
		"set_shape_text", "add_slide", "delete_slide", "move_slide", "add_text_box",
	}
	if got := commandTypes(edit); !slices.Equal(got, want) {
		t.Fatalf("office commands = %v", got)
	}
	if slices.Contains(commandTypes(Lookup("edit_document")), "set_cell") {
		t.Fatal("edit_document still offers set_cell")
	}
}

// The agent writes questions only through the question tools: create_material
// makes no quiz, edit_document neither adds nor replaces a question, and the
// question format is not in the contract.
func TestQuestionsAreWrittenThroughTheQuestionTools(t *testing.T) {
	props := Lookup("create_material").InputSchema["properties"].(map[string]any)
	if _, ok := props["questions"]; ok || slices.Contains(props["kind"].(map[string]any)["enum"].([]string), "quiz") {
		t.Fatalf("create_material still writes quizzes: %v", props)
	}
	commands := Lookup("edit_document").InputSchema["properties"].(map[string]any)["commands"].(map[string]any)
	for _, v := range commands["items"].(map[string]any)["oneOf"].([]any) {
		tag := v.(map[string]any)["properties"].(map[string]any)["type"].(map[string]any)["const"]
		if tag == "add_question" || tag == "replace_question" {
			t.Fatalf("edit_document still offers %s", tag)
		}
	}
	for _, name := range []string{"add_questions", "add_question_media"} {
		if def := Lookup(name); def == nil || !def.Mutates || def.Retention != RetainFull {
			t.Fatalf("%s = %+v", name, def)
		}
	}
	if formats := Export().Formats; len(formats) != 1 || formats["note"] == "" {
		t.Fatalf("formats = %v, want the note format only", formats)
	}
	for name, schema := range Export().MediaBlocks {
		assertClosed(t, name, schema.(map[string]any))
	}
}

// The questions the retrieval service expands from the three kinds
// (pipeline/tests/test_questions.py checks it writes exactly these) make a quiz
// the validator accepts.
func TestExpandedQuestionsAreValid(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "expanded_questions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var qs []map[string]any
	if err := json.Unmarshal(raw, &qs); err != nil {
		t.Fatal(err)
	}
	if len(qs) == 0 {
		t.Fatal("no expanded questions")
	}
	if err := questions.ValidateAll(qs, questions.Policy{}); err != nil {
		t.Fatal(err)
	}
}

// Marshal fills set_shape_text's and add_text_box's paragraph bounds and the
// contract's officeShapeText from the engine's limits.json (review L2).
func TestMarshalTakesTheShapeTextBoundsFromTheEngine(t *testing.T) {
	table := []byte(`{"commands":50,"shapeText":{"paragraphs":7,"characters":1234},` +
		`"formats":{"pptx":[{"count":"slides added","limit":20,"commands":["add_slide"]}]}}`)
	out, err := Marshal(table)
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		OfficeShapeText ShapeText `json:"officeShapeText"`
	}
	if err := json.Unmarshal(out, &contract); err != nil || contract.OfficeShapeText != (ShapeText{7, 1234}) {
		t.Fatalf("officeShapeText = %+v, %v", contract.OfficeShapeText, err)
	}
	text := string(out)
	if strings.Count(text, `"maxItems": 7`) != 2 ||
		strings.Count(text, "At most 7 paragraphs and 1,234 characters together.") != 2 ||
		strings.Contains(text, shapeTextKey) || strings.Contains(text, "{shape") {
		t.Fatal("the shape text bounds are not filled in")
	}
}
