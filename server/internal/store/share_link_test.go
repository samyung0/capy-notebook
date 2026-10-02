package store

import "testing"

// src/lib/shareLink.test.ts checks the same vector.
func TestSharePathVector(t *testing.T) {
	got := SharePath([]byte("test-secret-0123456789abcdef0000"), "ws_1a2b3c4d5e")
	if want := "/w/ws_1a2b3c4d5e.FVCxkY8emO_wohfF"; got != want {
		t.Fatalf("SharePath = %q, want %q", got, want)
	}
}

func TestShareTokenVerifiesMaterialsAndRejectsForgeries(t *testing.T) {
	secret := []byte("test-secret-0123456789abcdef0000")
	token := ShareToken(secret, "mat_1a2b3c4d5e")
	// src/lib/shareLink.test.ts checks the same vector.
	if token != "mat_1a2b3c4d5e.tWUDh1a-tb_YSGgu" {
		t.Fatalf("ShareToken = %q", token)
	}
	if id, ok := VerifyShareToken(secret, token); !ok || id != "mat_1a2b3c4d5e" {
		t.Fatalf("VerifyShareToken(%q) = %q, %v", token, id, ok)
	}
	for _, forged := range []string{
		token[:len(token)-1] + "A", "mat_1a2b3c4d5e", "Mat_1." + token[len(token)-16:],
		ShareToken([]byte("other-secret-0123456789abcdef000"), "mat_1a2b3c4d5e"),
	} {
		if _, ok := VerifyShareToken(secret, forged); ok {
			t.Fatalf("accepted forged token %q", forged)
		}
	}
}
