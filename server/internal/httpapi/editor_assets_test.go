package httpapi

import (
	"strings"
	"testing"
)

func TestValidateEditorAssetMetadata(t *testing.T) {
	t.Run("accepts matching image metadata", func(t *testing.T) {
		name, ext, contentType, err := validateEditorAssetMetadata(reserveEditorAssetRequest{
			Name: "photo.JPEG", Purpose: "image", SizeBytes: 1024, ContentType: "image/jpeg",
		})
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
			Name: "photo.png", Purpose: "image", SizeBytes: (20 << 20) + 1, ContentType: "image/png",
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, _, _, err := validateEditorAssetMetadata(tt.in); err == nil {
				t.Fatal("metadata was accepted")
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
