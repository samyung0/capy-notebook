package relayauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

const (
	HeaderTimestamp = "X-Import-Relay-Timestamp"
	HeaderSignature = "X-Import-Relay-Signature"
)

func Sign(secret, timestamp, method, requestURI string, body []byte) string {
	bodyHash := sha256.Sum256(body)
	canonical := strings.Join([]string{
		timestamp,
		strings.ToUpper(method),
		requestURI,
		hex.EncodeToString(bodyHash[:]),
	}, "\n")
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

func Verify(
	secret, timestamp, signature, method, requestURI string,
	body []byte,
	now time.Time,
) bool {
	if secret == "" || timestamp == "" || signature == "" {
		return false
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return false
	}
	signedAt := time.Unix(seconds, 0)
	if delta := now.Sub(signedAt); delta < -5*time.Minute || delta > 5*time.Minute {
		return false
	}
	expected, err := hex.DecodeString(Sign(secret, timestamp, method, requestURI, body))
	if err != nil {
		return false
	}
	got, err := hex.DecodeString(signature)
	return err == nil && hmac.Equal(got, expected)
}
