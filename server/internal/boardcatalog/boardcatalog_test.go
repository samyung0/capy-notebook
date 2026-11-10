package boardcatalog_test

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/boardcatalog"
)

func TestGeneratedFileIsCurrent(t *testing.T) {
	want, err := boardcatalog.TypeScript()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("..", "..", "..", filepath.FromSlash(boardcatalog.TypeScriptPath))
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run pnpm gen:openapi)", boardcatalog.TypeScriptPath, err)
	}
	if !bytes.Equal(bytes.ReplaceAll(got, []byte("\r\n"), []byte("\n")), want) {
		t.Errorf("%s is stale; run pnpm gen:openapi", boardcatalog.TypeScriptPath)
	}
}

// Every kind names boards the catalog lists, and every parent is a listed block.
func TestCatalogIsConsistent(t *testing.T) {
	c := boardcatalog.Get()
	flavours := map[string]bool{}
	for _, b := range c.Blocks {
		flavours[b.Flavour] = true
	}
	boards := func(kind string, list []string) {
		if len(list) == 0 {
			t.Errorf("%s is on no board", kind)
		}
		for _, board := range list {
			if !slices.Contains(c.Boards, board) {
				t.Errorf("%s names board %q", kind, board)
			}
		}
	}
	for _, e := range c.Elements {
		boards(e.Type, e.Boards)
	}
	for _, b := range c.Blocks {
		boards(b.Flavour, b.Boards)
		for _, parent := range b.Parents {
			if !flavours[parent] {
				t.Errorf("%s sits under unlisted %s", b.Flavour, parent)
			}
		}
	}
}
