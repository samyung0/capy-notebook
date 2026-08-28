package models

import (
	"reflect"
	"testing"
)

func TestAllSurfacesAndParsingStayInSync(t *testing.T) {
	want := []Surface{
		SurfaceChat,
		SurfaceGenerate,
		SurfaceEditor,
		SurfaceQuiz,
		SurfaceIngest,
		SurfaceEmbedding,
		SurfaceVision,
	}
	if got := AllSurfaces(); !reflect.DeepEqual(got, want) {
		t.Fatalf("surfaces = %v, want %v", got, want)
	}
	for _, surface := range want {
		parsed, ok := ParseSurface(string(surface))
		if !ok || parsed != surface {
			t.Fatalf("ParseSurface(%q) = %q, %t", surface, parsed, ok)
		}
	}
	if _, ok := ParseSurface("unknown"); ok {
		t.Fatal("unknown surface must fail parsing")
	}
}

func TestAgenticLoopSurfacePolicy(t *testing.T) {
	if got, want := AgenticLoopSurfaces(), []Surface{SurfaceChat}; !reflect.DeepEqual(got, want) {
		t.Fatalf("agentic-loop surfaces = %v, want %v", got, want)
	}
	for _, surface := range AllSurfaces() {
		want := surface == SurfaceChat
		if got := RequiresAgenticLoop(surface); got != want {
			t.Fatalf("RequiresAgenticLoop(%q) = %t, want %t", surface, got, want)
		}
	}
}
