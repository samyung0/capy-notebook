package mail

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

func UnsubscribeToken(secret, userID, category string) string {
	if secret == "" || userID == "" || category == "" {
		return ""
	}
	message := userID + "|" + category
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(message))
	payload := message + "|" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func ParseUnsubscribeToken(secret, token string) (userID, category string, err error) {
	if secret == "" || token == "" {
		return "", "", errors.New("unsubscribe token is not configured")
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return "", "", errors.New("invalid unsubscribe token")
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", "", errors.New("invalid unsubscribe token")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "|" + parts[1]))
	expected, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(expected, mac.Sum(nil)) {
		return "", "", errors.New("invalid unsubscribe token")
	}
	return parts[0], parts[1], nil
}
