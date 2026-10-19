package httpapi

import (
	"regexp"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/planlimits"
)

// The plan caps an editor asset takes (plan_limits): images 2 MiB Free and
// 5 MiB Pro, audio the per-file cap, 10 MiB Free and 30 MiB Pro.
var (
	freeAssetLimits = planlimits.Limits{ImageBytes: 2 << 20, SourceFileBytes: 10 << 20}
	proAssetLimits  = planlimits.Limits{ImageBytes: 5 << 20, SourceFileBytes: 30 << 20}
)

func TestValidateEditorAssetMetadata(t *testing.T) {
	t.Run("accepts matching image metadata", func(t *testing.T) {
		name, ext, contentType, err := validateEditorAssetMetadata(reserveEditorAssetRequest{
			Name: "photo.JPEG", Purpose: "image", SizeBytes: 1024, ContentType: "image/jpeg",
		}, 100_000_000, freeAssetLimits)
		if err != nil {
			t.Fatalf("validateEditorAssetMetadata: %v", err)
		}
		if name != "photo.JPEG" || ext != ".jpeg" || contentType != "image/jpeg" {
			t.Fatalf("unexpected normalized metadata: %q %q %q", name, ext, contentType)
		}
	})

	tests := []struct {
		name string
		in   reserveEditorAssetRequest
	}{
		{"rejects svg", reserveEditorAssetRequest{
			Name: "active.svg", Purpose: "image", SizeBytes: 20, ContentType: "image/svg+xml",
		}},
		{"rejects mismatched mime", reserveEditorAssetRequest{
			Name: "photo.png", Purpose: "image", SizeBytes: 20, ContentType: "image/jpeg",
		}},
		// Notes embed images and audio only (Epo 2026-10-15).
		{"rejects the pdf purpose", reserveEditorAssetRequest{
			Name: "paper.pdf", Purpose: "pdf", SizeBytes: 20, ContentType: "application/pdf",
		}},
		{"rejects the file purpose", reserveEditorAssetRequest{
			Name: "notes.txt", Purpose: "file", SizeBytes: 20, ContentType: "text/plain",
		}},
		{"rejects purpose mismatch", reserveEditorAssetRequest{
			Name: "paper.pdf", Purpose: "audio", SizeBytes: 20, ContentType: "application/pdf",
		}},
		{"rejects empty file", reserveEditorAssetRequest{
			Name: "tide.wav", Purpose: "audio", SizeBytes: 0, ContentType: "audio/wav",
		}},
		{"rejects oversized image", reserveEditorAssetRequest{
			Name: "photo.png", Purpose: "image", SizeBytes: (2 << 20) + 1, ContentType: "image/png",
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, _, _, err := validateEditorAssetMetadata(tt.in, 100_000_000, freeAssetLimits); err == nil {
				t.Fatal("metadata was accepted")
			}
		})
	}
}

// Each asset stops at the payer's plan cap: images at the image cap, audio at
// the per-file cap uploads take, both by plan.
func TestValidateEditorAssetMetadataPlanCaps(t *testing.T) {
	image := func(size int64) reserveEditorAssetRequest {
		return reserveEditorAssetRequest{Name: "figure.png", Purpose: "image", SizeBytes: size, ContentType: "image/png"}
	}
	audio := func(size int64) reserveEditorAssetRequest {
		return reserveEditorAssetRequest{Name: "tide.mp3", Purpose: "audio", SizeBytes: size, ContentType: "audio/mpeg"}
	}
	for _, tc := range []struct {
		name   string
		in     reserveEditorAssetRequest
		limits planlimits.Limits
		limit  string // the refusal names it
	}{
		{"free image at 2 MiB", image(2 << 20), freeAssetLimits, ""},
		{"free image over 2 MiB", image(2<<20 + 1), freeAssetLimits, "2 MB"},
		{"pro image over 2 MiB", image(2<<20 + 1), proAssetLimits, ""},
		{"pro image over 5 MiB", image(5<<20 + 1), proAssetLimits, "5 MB"},
		{"free audio at 10 MiB", audio(10 << 20), freeAssetLimits, ""},
		{"free audio over 10 MiB", audio(10<<20 + 1), freeAssetLimits, "10 MB"},
		{"pro audio over 10 MiB", audio(10<<20 + 1), proAssetLimits, ""},
		{"pro audio at 30 MiB", audio(30 << 20), proAssetLimits, ""},
		{"pro audio over 30 MiB", audio(30<<20 + 1), proAssetLimits, "30 MB"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, err := validateEditorAssetMetadata(tc.in, 100_000_000, tc.limits)
			if (err == nil) != (tc.limit == "") {
				t.Fatalf("err = %v, want refused=%v", err, tc.limit != "")
			}
			if err != nil && !strings.Contains(err.Error(), tc.limit) {
				t.Fatalf("refusal %q does not name the %s limit", err, tc.limit)
			}
		})
	}
	// The storage ceiling still bounds a plan cap above it.
	if _, _, _, err := validateEditorAssetMetadata(audio(2<<20), 1<<20, proAssetLimits); err == nil {
		t.Fatal("audio over the storage ceiling was accepted")
	}
}

func TestEditorAssetSignatureAllowed(t *testing.T) {
	tests := []struct {
		name    string
		purpose string
		ext     string
		data    []byte
		want    bool
	}{
		{"png", "image", ".png", []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, true},
		{"jpeg", "image", ".jpg", []byte{0xff, 0xd8, 0xff, 0xe0}, true},
		{"webp", "image", ".webp", []byte("RIFF1234WEBP"), true},
		{"wav", "audio", ".wav", []byte("RIFF1234WAVE"), true},
		{"pdf", "pdf", ".pdf", []byte("%PDF-1.7"), false},
		{"renamed executable", "image", ".png", []byte("MZ executable"), false},
		{"wrong purpose", "audio", ".png", []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := editorAssetSignatureAllowed(tt.purpose, tt.ext, tt.data); got != tt.want {
				t.Fatalf("editorAssetSignatureAllowed() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEditorAssetObjectKeyDoesNotUseOriginalName(t *testing.T) {
	assetID := randID("asset")
	key := editorAssetObjectKey(assetID, ".png")
	if strings.Contains(key, "private-photo") ||
		!regexp.MustCompile(`^editor-assets/asset_[0-9a-f]{10}/blob_[0-9a-f]{32}\.png$`).MatchString(key) {
		t.Fatalf("unexpected editor asset key %q, want a 128-bit blob id", key)
	}
	if !strings.HasSuffix(key, ".png") {
		t.Fatalf("object key lost validated extension: %q", key)
	}
}
