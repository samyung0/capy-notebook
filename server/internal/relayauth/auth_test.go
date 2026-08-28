package relayauth

import (
	"testing"
	"time"
)

func TestSignAndVerify(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	timestamp := "1800000000"
	body := []byte(`{"jobId":"imp_1"}`)
	signed := Sign("secret", timestamp, "POST", "/enqueue?source=go", body)
	if !Verify(
		"secret", timestamp, signed, "POST", "/enqueue?source=go", body, now,
	) {
		t.Fatal("valid signature rejected")
	}
	if Verify(
		"secret", timestamp, signed, "POST", "/enqueue?source=go",
		[]byte(`{"jobId":"imp_2"}`), now,
	) {
		t.Fatal("tampered body accepted")
	}
}

func TestVerifyRejectsStaleSignature(t *testing.T) {
	body := []byte(`{}`)
	signed := Sign("secret", "1800000000", "POST", "/enqueue", body)
	if Verify(
		"secret", "1800000000", signed, "POST", "/enqueue", body,
		time.Unix(1_800_000_301, 0),
	) {
		t.Fatal("stale signature accepted")
	}
}
