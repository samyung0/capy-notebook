package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
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
	// Parent is the note an embedded quiz or flashcard set belongs to: its
	// rooms join inside that note's channel, which the collaboration server
	// checks against this claim (Epo 2026-10-20).
	Parent string `json:"parent,omitempty"`
	// Who the connection is, for the room's presence and cursor labels (Epo
	// 2026-10-20): the verified display name and avatar, nothing about the
	// device (Epo 2026-10-20, privacy). Both are bounded, since the
	// collaboration server sends them to every co-editor.
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// maxClaimAvatarURL bounds the avatar a token carries; a longer one (none
// the app sets is near it) is left out, and co-editors see initials.
const maxClaimAvatarURL = 1024

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
	if len(avatarURL) > maxClaimAvatarURL {
		avatarURL = ""
	}
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
		Name:      fieldlimits.Clamp(claimName(name), fieldlimits.UserName),
		AvatarURL: avatarURL,
	}
}

// claimName is the name co-editors see on an avatar and a cursor label,
// without bidi controls or zero-width characters, which could make one name
// read as another's.
func claimName(name string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Bidi_Control, r) {
			return -1
		}
		switch r {
		case '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff':
			return -1
		}
		return r
	}, name)
}
