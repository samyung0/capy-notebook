package assetthumb

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decodeThumb(t *testing.T, data []byte) image.Image {
	t.Helper()
	thumb, err := Make(data)
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(thumb))
	if err != nil {
		t.Fatalf("thumbnail is not a JPEG: %v", err)
	}
	return img
}

// 200 px wide, cut at 400 from the top, narrower images kept at their size,
// and transparency flattened on white.
func TestMakeScalesCutsAndFlattens(t *testing.T) {
	for _, tc := range []struct {
		name         string
		w, h         int
		wantW, wantH int
	}{
		{"landscape", 2400, 1350, 200, 113},
		{"tall", 600, 2400, 200, 400},
		{"narrow", 120, 80, 120, 80},
	} {
		t.Run(tc.name, func(t *testing.T) {
			img := decodeThumb(t, encodePNG(t, image.NewNRGBA(image.Rect(0, 0, tc.w, tc.h))))
			if got := img.Bounds().Size(); got != image.Pt(tc.wantW, tc.wantH) {
				t.Fatalf("size %v, want %dx%d", got, tc.wantW, tc.wantH)
			}
			// Fully transparent in, white out (JPEG keeps it near 255).
			if r, g, b, _ := img.At(tc.wantW/2, tc.wantH/2).RGBA(); r>>8 < 245 || g>>8 < 245 || b>>8 < 245 {
				t.Fatalf("transparent pixel is %d,%d,%d, want white", r>>8, g>>8, b>>8)
			}
		})
	}
}

// The cut keeps the top: a tall image black above and white below shows
// only black.
func TestMakeKeepsTheTop(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 200, 1000))
	for y := 0; y < 1000; y++ {
		for x := 0; x < 200; x++ {
			c := color.RGBA{A: 255}
			if y >= 500 {
				c = color.RGBA{255, 255, 255, 255}
			}
			src.Set(x, y, c)
		}
	}
	img := decodeThumb(t, encodePNG(t, src))
	if r, _, _, _ := img.At(100, 390).RGBA(); r>>8 > 30 {
		t.Fatalf("row 390 is %d, want black (the white half was cut)", r>>8)
	}
}

func TestMakeRefusesWhatItCannotRead(t *testing.T) {
	if _, err := Make([]byte("not an image")); err == nil {
		t.Fatal("garbage made a thumbnail")
	}
	if _, err := Make(encodePNG(t, image.NewNRGBA(image.Rect(0, 0, 2401, 10)))); err == nil {
		t.Fatal("an image over the editors' side limit made a thumbnail")
	}
}
