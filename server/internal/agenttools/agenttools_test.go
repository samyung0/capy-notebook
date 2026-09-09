package agenttools

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
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
		assertClosed(t, def.Name, def.InputSchema)
	}
	for _, name := range []string{"search_workspace", "create_material", "trash_file"} {
		if !seen[name] {
			t.Fatalf("missing tool %s", name)
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
}

// The committed Python asset must match the Go source of truth. Regenerate
// with `pnpm gen:openapi`.
func TestGeneratedContractIsCurrent(t *testing.T) {
	want, err := Marshal()
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
