package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

func TestVerifyElevenLabsSignature(t *testing.T) {
	now := time.Unix(1_750_000_000, 0)
	body := []byte(`{"type":"speech_to_text_transcription"}`)
	secret := "whsec_test"
	timestamp := fmt.Sprint(now.Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(body)
	header := "t=" + timestamp + ",v0=" + hex.EncodeToString(mac.Sum(nil))

	if !verifyElevenLabsSignature(body, header, secret, now) {
		t.Fatal("valid signature was rejected")
	}
	if verifyElevenLabsSignature([]byte("tampered"), header, secret, now) {
		t.Fatal("tampered body was accepted")
	}
	if verifyElevenLabsSignature(body, header, secret, now.Add(31*time.Minute)) {
		t.Fatal("stale signature was accepted")
	}
}
