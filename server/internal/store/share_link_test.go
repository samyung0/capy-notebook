package store

import "testing"

// src/lib/shareLink.test.ts checks the same vector.
func TestSharePathVector(t *testing.T) {
	got := SharePath([]byte("test-secret-0123456789abcdef0000"), "ws_1a2b3c4d5e")
	if want := "/w/ws_1a2b3c4d5e.FVCxkY8emO_wohfF"; got != want {
		t.Fatalf("SharePath = %q, want %q", got, want)
	}
}
