package store

import (
	"testing"

	"github.com/evonotes/server/internal/sourceupload"
)

func TestInitialPipelineJobType(t *testing.T) {
	tests := []struct {
		name  string
		route string
		want  string
	}{
		{name: "document", route: sourceupload.RouteDocumentParse, want: "parse"},
		{name: "text", route: sourceupload.RouteRawText, want: "ingest"},
		{name: "image", route: sourceupload.RouteImageCaption, want: "ingest"},
		{name: "audio", route: sourceupload.RouteAudioTranscript, want: "ingest"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := initialPipelineJobType(sourceupload.ProcessingPlan{Route: test.route})
			if got != test.want {
				t.Fatalf("initialPipelineJobType(%q) = %q, want %q", test.route, got, test.want)
			}
		})
	}
}
