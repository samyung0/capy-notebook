package httpapi

import (
	"bytes"
	"compress/gzip"
	"image"
	"image/png"
	"io"
	"testing"
)

// TestBoardIsStoredGzipped: a board goes to the bucket gzipped, smaller, and
// inflates back to the bytes the browser sent.
func TestBoardIsStoredGzipped(t *testing.T) {
	board := bytes.Repeat([]byte(`{"type":"brush","points":[[1.25,2.5],[3.75,4.125]]}`), 200)
	packed, err := gzipBoard(board)
	if err != nil {
		t.Fatal(err)
	}
	if len(packed) >= len(board) {
		t.Fatalf("gzipped %d of %d bytes", len(packed), len(board))
	}
	r, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		t.Fatal(err)
	}
	back, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(back, board) {
		t.Fatalf("inflated %d bytes, err %v", len(back), err)
	}
}

// TestDrawingImageIsCappedAt1568: the server takes a marking image up to the
// 1,568 px the browser makes (Epo 2026-11-06) and refuses a bigger one.
func TestDrawingImageIsCappedAt1568(t *testing.T) {
	sized := func(width int) drawingUpload {
		var out bytes.Buffer
		if err := png.Encode(&out, image.NewGray(image.Rect(0, 0, width, 2))); err != nil {
			t.Fatal(err)
		}
		return drawingUpload{Board: []byte("a board"), Image: out.Bytes()}
	}
	if _, err := checkedDrawing(sized(1568)); err != nil {
		t.Fatalf("a 1,568 px image was refused: %v", err)
	}
	if _, err := checkedDrawing(sized(1569)); err == nil {
		t.Fatal("a 1,569 px image was taken")
	}
}
