package store

import (
	"errors"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// A diagram an agent or generator writes as a ```mermaid fence is built into
// its document before the written check, which then holds its source to the
// cap. Fails if the check reads the fence as JSON (every agent diagram
// refused with "invalid character '`'").
func TestADiagramDraftFromAMermaidFenceIsBuilt(t *testing.T) {
	fence := func(source string) string { return "```mermaid\n" + source + "\n```" }
	mt, err := MaterialDraft{Kind: MaterialDiagram, Title: "Flow", Content: fence("flowchart LR\n  A --> B")}.material()
	if err != nil {
		t.Fatal(err)
	}
	if source, err := materialdoc.ExtractMermaidSource(mt.Content); err != nil || source != "flowchart LR\n  A --> B" {
		t.Fatalf("source %q, %v", source, err)
	}
	long := fence("flowchart LR\n" + strings.Repeat("a", embeds.MermaidSourceMax))
	_, err = MaterialDraft{Kind: MaterialMindmap, Title: "Map", Content: long}.material()
	if !errors.Is(err, materialdoc.ErrInvalid) || !strings.Contains(err.Error(), "diagram source characters over 50000") {
		t.Fatalf("a source past the cap: %v", err)
	}
}
