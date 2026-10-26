package bank

import (
	"context"
	"encoding/binary"
	"hash/crc32"
	"io"
	"strings"
	"testing"
)

type assetCapture struct {
	key, mime, cache string
	bytes            []byte
}

func (a *assetCapture) PutObject(_ context.Context, key string, r io.Reader, mime, cache string) error {
	a.key, a.mime, a.cache = key, mime, cache
	a.bytes, _ = io.ReadAll(r)
	return nil
}

func TestPublicSVGIsStaticAndContentAddressed(t *testing.T) {
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><path d="M0 0L10 10" clip-path="url(#clip)" style="stroke: black; fill: none"/></svg>`)
	capture := &assetCapture{}
	link, err := UploadAsset(context.Background(), capture, "https://figures.example/bank", svg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(link, "https://figures.example/bank/") || !strings.HasSuffix(link, ".svg") || len(capture.key) != 68 || capture.mime != "image/svg+xml" || capture.cache != ImmutableCache {
		t.Fatalf("unexpected upload: %s %#v", link, capture)
	}
	again, err := UploadAsset(context.Background(), capture, "https://figures.example/bank/", svg)
	if err != nil || again != link {
		t.Fatalf("content address changed: %s %v", again, err)
	}
	for _, svg := range []string{
		`<svg onload="alert(1)"/>`, `<svg><script/></svg>`, `<svg><foreignObject/></svg>`,
		`<svg><use href="https://example.com/evil.svg"/></svg>`, `<svg><path fill="url(https://example.com/x)"/></svg>`,
		`<svg><path style="fill: u\72l(https://example.com/x)"/></svg>`, `<!DOCTYPE svg><svg/>`, `<svg/><svg/>`,
	} {
		if _, _, err := ValidateAsset([]byte(svg)); err == nil {
			t.Errorf("accepted active SVG: %s", svg)
		}
	}
	if _, _, err := ValidateAsset([]byte(strings.Repeat("x", AssetMaxBytes+1))); err == nil {
		t.Fatal("accepted oversized asset")
	}
}

// Security regression (Q348, review N2): a raster figure keeps the editors'
// 2,400 px limit on each side, read from its header.
func TestRasterFiguresKeepThePixelLimit(t *testing.T) {
	png := func(width, height uint32) []byte {
		ihdr := binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint32(nil, width), height)
		chunk := append([]byte("IHDR"), append(ihdr, 8, 2, 0, 0, 0)...)
		out := binary.BigEndian.AppendUint32([]byte("\x89PNG\r\n\x1a\n"), 13)
		return binary.BigEndian.AppendUint32(append(out, chunk...), crc32.ChecksumIEEE(chunk))
	}
	if _, ext, err := ValidateAsset(png(2400, 100)); err != nil || ext != ".png" {
		t.Fatalf("a 2400 px figure: %s %v", ext, err)
	}
	for _, data := range [][]byte{png(2401, 100), png(100, 2401)} {
		if _, _, err := ValidateAsset(data); err == nil {
			t.Fatal("accepted a figure past 2,400 px")
		}
	}
}
