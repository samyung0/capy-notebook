package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"
)

type collaborationClaims struct {
	Audience  string `json:"aud"`
	ExpiresAt int64  `json:"exp"`
	IssuedAt  int64  `json:"iat"`
	Issuer    string `json:"iss"`
	ID        string `json:"jti"`
	Subject   string `json:"sub"`
	Room      string `json:"room"`
	Access    string `json:"access"`
	Schema    int    `json:"schema"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

func signCollaborationToken(secret string, claims collaborationClaims) (string, error) {
	if secret == "" {
		return "", errors.New("collaboration token signing is not configured")
	}
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedHeader := base64.RawURLEncoding.EncodeToString(header)
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	signingInput := encodedHeader + "." + encodedPayload
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func newCollaborationClaims(userID, room, access, name, avatarURL, tokenID string, schema int) collaborationClaims {
	now := time.Now().UTC()
	return collaborationClaims{
		Audience:  "capy-collaboration",
		ExpiresAt: now.Add(5 * time.Minute).Unix(),
		IssuedAt:  now.Unix(),
		Issuer:    "capy-api",
		ID:        tokenID,
		Subject:   userID,
		Room:      room,
		Access:    access,
		Schema:    schema,
		Name:      name,
		AvatarURL: avatarURL,
	}
}
