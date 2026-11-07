package httpapi

import (
	"bytes"
	"compress/gzip"
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
