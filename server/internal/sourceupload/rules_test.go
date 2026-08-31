package sourceupload

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

const (
	testFreeSourceBytes = 10 << 20
	testProSourceBytes  = 30 << 20
)

func TestWorkerTextFormatContractMatchesServerPolicy(t *testing.T) {
	raw, err := os.ReadFile("text_extensions.json")
	if err != nil {
		t.Fatal(err)
	}
	var workerFormats []string
	if err := json.Unmarshal(raw, &workerFormats); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(workerFormats, textExtensions) {
		t.Fatal("worker text-format contract is out of sync with the server policy")
	}
}

func TestKindFromNameUsesFrontendExtensionMap(t *testing.T) {
	tests := map[string]string{
		"notes.pdf":         "pdf",
		"report.DOCX":       "doc",
		"readme.mdc":        "md",
		"script.py":         "txt",
		"data.csv":          "sheet",
		"state.json":        "json",
		"no-extension":      "unknown",
		"archive.zip":       "unknown",
		"legacy.doc":        "doc",
		"legacy.xls":        "sheet",
		"legacy.ppt":        "slides",
		"table.tsv":         "sheet",
		"component.h++":     "txt",
		"configuration.YML": "txt",
	}
	for name, want := range tests {
		if got := KindFromName(name); got != want {
			t.Errorf("KindFromName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name      string
		kind      string
		mode      string
		size      int64
		maxBytes  int64
		wantError string
	}{
		{name: "notes.pdf", kind: "pdf", mode: ParseModeFast, size: 1},
		{name: "notes.pdf", kind: "pdf", mode: "accurate", size: 1, wantError: "unknown parse mode"},
		{name: "script.py", kind: "txt", mode: ParseModeNone, size: 1},
		{name: "notes.pdf", kind: "pdf", mode: ParseModeFast, size: testFreeSourceBytes + 1, wantError: "10 MB"},
		{name: "notes.pdf", kind: "pdf", mode: ParseModeFast, size: testProSourceBytes + 1, maxBytes: testProSourceBytes, wantError: "30 MB"},
		{name: "notes.pdf", kind: "pdf", mode: ParseModeFast, size: testProSourceBytes, maxBytes: testProSourceBytes},
		{name: "song.mp3", kind: "audio", mode: ParseModeFast, size: 1, wantError: "does not support"},
		{name: "notes.pdf", kind: "txt", mode: ParseModeFast, size: 1, wantError: "does not match"},
		{name: "archive.zip", kind: "unknown", mode: ParseModeNone, size: 1},
		{name: "no-extension", kind: "unknown", mode: ParseModeNone, size: 1},
		{name: "notes.pdf", kind: "pdf", mode: "invalid", size: 1, wantError: "unknown parse mode"},
	}
	for _, test := range tests {
		t.Run(test.name+"-"+test.mode, func(t *testing.T) {
			maxBytes := test.maxBytes
			if maxBytes == 0 {
				maxBytes = testFreeSourceBytes
			}
			err := Validate(test.name, test.kind, test.mode, test.size, maxBytes)
			if test.wantError == "" {
				if err != nil {
					t.Fatalf("Validate returned unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Validate error = %v, want substring %q", err, test.wantError)
			}
		})
	}
}

func TestDefaultParseMode(t *testing.T) {
	tests := map[string]string{
		"notes.pdf":    ParseModeFast,
		"slides.pptx":  ParseModeFast,
		"readme.md":    ParseModeNone,
		"script.py":    ParseModeNone,
		"song.mp3":     ParseModeNone,
		"archive.zip":  ParseModeNone,
		"no-extension": ParseModeNone,
	}
	for name, want := range tests {
		kind := KindFromName(name)
		if got := DefaultParseMode(name, kind); got != want {
			t.Errorf("DefaultParseMode(%q, %q) = %q, want %q", name, kind, got, want)
		}
	}
}

func TestNeedsIngestJob(t *testing.T) {
	tests := []struct {
		name, kind, mode string
		want             bool
	}{
		{name: "notes.txt", kind: "txt", mode: ParseModeNone, want: true},
		{name: "notes.md", kind: "md", mode: ParseModeNone, want: true},
		{name: "data.json", kind: "json", mode: ParseModeNone, want: true},
		{name: "paper.pdf", kind: "pdf", mode: ParseModeFast, want: true},
		{name: "paper.pdf", kind: "pdf", mode: ParseModeNone, want: false},
		{name: "song.mp3", kind: "audio", mode: ParseModeNone, want: true},
		{name: "scan.svg", kind: "image", mode: ParseModeNone, want: true},
		{name: "data.csv", kind: "sheet", mode: ParseModeNone, want: true},
		{name: "data.tsv", kind: "sheet", mode: ParseModeNone, want: true},
		{name: "legacy.xls", kind: "sheet", mode: ParseModeNone, want: false},
		{name: "archive.zip", kind: "unknown", mode: ParseModeNone, want: false},
	}
	for _, test := range tests {
		if got := NeedsIngestJob(test.name, test.kind, test.mode); got != test.want {
			t.Errorf("NeedsIngestJob(%q, %q, %q) = %t, want %t",
				test.name, test.kind, test.mode, got, test.want)
		}
	}
}

func TestBuildProcessingPlan(t *testing.T) {
	tests := []struct {
		name, kind, mode string
		caption          bool
		wantRoute        string
		wantCaption      string
		wantParser       string
		wantPreview      bool
		wantStages       []string
	}{
		{name: "notes.txt", kind: "txt", mode: ParseModeNone, wantRoute: RouteRawText, wantCaption: CaptionNone},
		{name: "page.html", kind: "txt", mode: ParseModeNone, wantRoute: RouteRawText, wantCaption: CaptionNone},
		{name: "data.csv", kind: "sheet", mode: ParseModeNone, wantRoute: RouteDelimitedText, wantCaption: CaptionNone, wantStages: []string{"fetch_source", "normalize_delimited", "chunk", "index", "generate_derivatives"}},
		{name: "photo.png", kind: "image", mode: ParseModeNone, wantRoute: RouteImageCaption, wantCaption: CaptionStandalone},
		{name: "lecture.mp3", kind: "audio", mode: ParseModeNone, wantRoute: RouteAudioTranscript, wantCaption: CaptionNone},
		{name: "paper.pdf", kind: "pdf", mode: ParseModeFast, caption: true, wantRoute: RouteDocumentParse, wantCaption: CaptionEmbedded, wantParser: ParseModeFast, wantStages: []string{"fetch_source", "parse_document", "caption_images", "persist_captions", "chunk", "index", "generate_derivatives"}},
		{name: "book.xlsx", kind: "sheet", mode: ParseModeFast, wantRoute: RouteDocumentParse, wantCaption: CaptionNone, wantParser: ParseModeFast, wantPreview: true, wantStages: []string{"fetch_source", "parse_document", "persist_office_preview", "chunk", "index", "generate_derivatives"}},
		{name: "legacy.xls", kind: "sheet", mode: ParseModeNone, wantRoute: RouteStoreOnly, wantCaption: CaptionNone},
		{name: "archive.zip", kind: "unknown", mode: ParseModeNone, wantRoute: RouteStoreOnly, wantCaption: CaptionNone},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan, err := BuildProcessingPlan(test.name, test.kind, test.mode, test.caption)
			if err != nil {
				t.Fatalf("BuildProcessingPlan returned unexpected error: %v", err)
			}
			if plan.Version != ProcessingPlanVersion || plan.Format != extensionKey(test.name) || plan.Route != test.wantRoute || plan.CaptionMode != test.wantCaption || plan.ParserRoute != test.wantParser || plan.OfficePreview != test.wantPreview {
				t.Fatalf("BuildProcessingPlan(%q) = %#v", test.name, plan)
			}
			if test.wantStages != nil && !reflect.DeepEqual(plan.Stages, test.wantStages) {
				t.Fatalf("BuildProcessingPlan(%q).Stages = %v, want %v", test.name, plan.Stages, test.wantStages)
			}
		})
	}
}

func TestBuildProcessingPlanRejectsInvalidContractInput(t *testing.T) {
	if _, err := BuildProcessingPlan("paper.pdf", "txt", ParseModeFast, false); err == nil {
		t.Fatal("expected a kind mismatch error")
	}
	if _, err := BuildProcessingPlan("paper.pdf", "pdf", "accurate", false); err == nil {
		t.Fatal("expected an unknown parse mode error")
	}
}

func TestParsePolicyLists(t *testing.T) {
	fast := ParseExtensions(ParseModeFast)
	supported := SupportedExtensions()
	if !contains(fast, ".docx") || !contains(fast, ".pptx") {
		t.Fatalf("fast policy is missing expected extensions: %v", fast)
	}
	for _, legacy := range []string{".doc", ".xls", ".ppt"} {
		if contains(fast, legacy) || !contains(supported, legacy) {
			t.Fatalf("legacy Office extension %s must be store-only", legacy)
		}
	}
	if contains(ParseExtensions(ParseModeNone), ".pdf") {
		t.Fatal("parse mode none should advertise no extensions")
	}
	if !contains(supported, ".py") || !contains(supported, ".mdc") || contains(supported, ".zip") {
		t.Fatalf("supported policy does not mirror the frontend allowlist: %v", supported)
	}
}

func TestNormalizeCaptionImages(t *testing.T) {
	tests := []struct {
		kind, mode string
		requested  bool
		want       bool
	}{
		{kind: "pdf", mode: ParseModeFast, requested: true, want: true},
		{kind: "pdf", mode: ParseModeFast, requested: false, want: false},
		// Nothing to caption: no parse ran, or the source has no figures.
		{kind: "pdf", mode: ParseModeNone, requested: true, want: false},
		{kind: "txt", mode: ParseModeFast, requested: true, want: false},
		{kind: "md", mode: ParseModeFast, requested: true, want: false},
	}
	for _, test := range tests {
		if got := NormalizeCaptionImages(test.kind, test.mode, test.requested); got != test.want {
			t.Errorf("NormalizeCaptionImages(%q, %q, %t) = %t, want %t",
				test.kind, test.mode, test.requested, got, test.want)
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
