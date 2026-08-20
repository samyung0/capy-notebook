package sourceupload

import (
	"strings"
	"testing"
)

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
		{name: "notes.pdf", kind: "pdf", mode: ParseModeAccurate, size: 1},
		{name: "script.py", kind: "txt", mode: ParseModeNone, size: 1},
		{name: "notes.pdf", kind: "pdf", mode: ParseModeFast, size: FreeSourceMaxBytes + 1, wantError: "10 MB"},
		{name: "notes.pdf", kind: "pdf", mode: ParseModeFast, size: ProSourceMaxBytes + 1, maxBytes: ProSourceMaxBytes, wantError: "30 MB"},
		{name: "notes.pdf", kind: "pdf", mode: ParseModeFast, size: ProSourceMaxBytes, maxBytes: ProSourceMaxBytes},
		{name: "song.mp3", kind: "audio", mode: ParseModeFast, size: 1, wantError: "does not support"},
		{name: "notes.pdf", kind: "txt", mode: ParseModeFast, size: 1, wantError: "does not match"},
		{name: "archive.zip", kind: "unknown", mode: ParseModeNone, size: 1, wantError: "not supported"},
		{name: "notes.pdf", kind: "pdf", mode: "invalid", size: 1, wantError: "unknown parse mode"},
	}
	for _, test := range tests {
		t.Run(test.name+"-"+test.mode, func(t *testing.T) {
			maxBytes := test.maxBytes
			if maxBytes == 0 {
				maxBytes = FreeSourceMaxBytes
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
		kind, mode string
		want       bool
	}{
		{kind: "txt", mode: ParseModeNone, want: true},
		{kind: "md", mode: ParseModeNone, want: true},
		{kind: "json", mode: ParseModeNone, want: true},
		{kind: "pdf", mode: ParseModeFast, want: true},
		{kind: "pdf", mode: ParseModeNone, want: false},
		{kind: "audio", mode: ParseModeNone, want: false},
	}
	for _, test := range tests {
		if got := NeedsIngestJob(test.kind, test.mode); got != test.want {
			t.Errorf("NeedsIngestJob(%q, %q) = %t, want %t",
				test.kind, test.mode, got, test.want)
		}
	}
}

func TestParsePolicyLists(t *testing.T) {
	fast := ParseExtensions(ParseModeFast)
	supported := SupportedExtensions()
	if !contains(fast, ".doc") || !contains(fast, ".pptx") {
		t.Fatalf("fast policy is missing expected extensions: %v", fast)
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
		{kind: "pdf", mode: ParseModeAccurate, requested: false, want: false},
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

func TestCanonicalParseMode(t *testing.T) {
	if got := CanonicalParseMode(ParseModeAccurate); got != ParseModeFast {
		t.Fatalf("accurate alias = %q, want fast", got)
	}
	if got := CanonicalParseMode("advanced"); got != ParseModeFast {
		t.Fatalf("advanced alias = %q, want fast", got)
	}
	if got := CanonicalParseMode(ParseModeFast); got != ParseModeFast {
		t.Fatalf("fast stayed %q", got)
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
