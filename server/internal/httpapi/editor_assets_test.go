package httpapi

import (
	"strings"
	"testing"
)

func TestValidateEditorAssetMetadata(t *testing.T) {
	t.Run("accepts matching image metadata", func(t *testing.T) {
		name, ext, contentType, err := validateEditorAssetMetadata(reserveEditorAssetRequest{
			Name: "photo.JPEG", Purpose: "image", SizeBytes: 1024, ContentType: "image/jpeg",
		}, 100_000_000, 2<<20)
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
		{"rejects purpose mismatch", reserveEditorAssetRequest{
			Name: "paper.pdf", Purpose: "file", SizeBytes: 20, ContentType: "application/pdf",
		}},
		{"rejects empty file", reserveEditorAssetRequest{
			Name: "notes.txt", Purpose: "file", SizeBytes: 0, ContentType: "text/plain",
		}},
		{"rejects oversized image", reserveEditorAssetRequest{
			Name: "photo.png", Purpose: "image", SizeBytes: (2 << 20) + 1, ContentType: "image/png",
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, _, _, err := validateEditorAssetMetadata(tt.in, 100_000_000, 2<<20); err == nil {
				t.Fatal("metadata was accepted")
			}
		})
	}
}

// Images stop at the payer's plan cap (2 MiB Free, 5 MiB Pro); other purposes
// keep their own limits.
func TestValidateEditorAssetMetadataImageCap(t *testing.T) {
	image := func(size int64) reserveEditorAssetRequest {
		return reserveEditorAssetRequest{Name: "figure.png", Purpose: "image", SizeBytes: size, ContentType: "image/png"}
	}
	for _, tc := range []struct {
		name string
		in   reserveEditorAssetRequest
		cap  int64
		ok   bool
	}{
		{"free image at 2 MiB", image(2 << 20), 2 << 20, true},
		{"free image over 2 MiB", image(2<<20 + 1), 2 << 20, false},
		{"pro image over 2 MiB", image(2<<20 + 1), 5 << 20, true},
		{"pdf over the image cap", reserveEditorAssetRequest{
			Name: "paper.pdf", Purpose: "pdf", SizeBytes: 3 << 20, ContentType: "application/pdf",
		}, 2 << 20, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, err := validateEditorAssetMetadata(tc.in, 100_000_000, tc.cap)
			if (err == nil) != tc.ok {
				t.Fatalf("err = %v, want ok=%v", err, tc.ok)
			}
			if err != nil && !strings.Contains(err.Error(), "2 MB") {
				t.Fatalf("refusal %q does not name the 2 MB limit", err)
			}
		})
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
		{"pdf", "pdf", ".pdf", []byte("%PDF-1.7"), true},
		{"docx", "file", ".docx", []byte{'P', 'K', 0x03, 0x04}, true},
		{"utf8 text", "file", ".txt", []byte("hello"), true},
		{"binary text", "file", ".txt", []byte{'a', 0, 'b'}, false},
		{"renamed executable", "image", ".png", []byte("MZ executable"), false},
		{"wrong purpose", "file", ".png", []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, false},
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
	if strings.Contains(key, "private-photo") || !strings.HasPrefix(key, "editor-assets/asset_") {
		t.Fatalf("unexpected editor asset key %q", key)
	}
	if !strings.HasSuffix(key, ".png") {
		t.Fatalf("object key lost validated extension: %q", key)
	}
}
