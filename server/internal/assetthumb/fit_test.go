package assetthumb

import (
	"bytes"
	"image"
	"image/jpeg"
	"testing"
)

// A figure is sent whole, within the grader's edge; a small one keeps its size.
func TestFitScalesWholeWithinTheEdge(t *testing.T) {
	for _, c := range []struct{ w, h, wantW, wantH int }{{2000, 1000, 1568, 784}, {300, 200, 300, 200}} {
		out, err := Fit(encodePNG(t, image.NewRGBA(image.Rect(0, 0, c.w, c.h))), 1568, 85)
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(bytes.NewReader(out))
		if err != nil {
			t.Fatalf("not a JPEG: %v", err)
		}
		if b := img.Bounds(); b.Dx() != c.wantW || b.Dy() != c.wantH {
			t.Fatalf("%dx%d became %dx%d, want %dx%d", c.w, c.h, b.Dx(), b.Dy(), c.wantW, c.wantH)
		}
	}
}
