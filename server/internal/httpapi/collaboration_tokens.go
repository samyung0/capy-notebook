package httpapi

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"slices"
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
	// ClientID is the Yjs client id this token offers the editing session
	// that joins with it (Epo 2026-10-23, Q213): a session takes the id of
	// its first joined token and keeps it, and the collaboration server
	// records which user each id was assigned to and admits document changes
	// under an id only from that user. Fresh per token, never 0 (the DOCX
	// seed's client).
	ClientID uint32 `json:"clientId"`
	// WorkerClientID is the second id a DOCX editing session is offered, for
	// its resident layout worker, which writes as a Yjs peer of its own (Epo
	// 2026-10-23, Q219). The join that binds ClientID records it to the same
	// user. Only on DOCX write tokens.
	WorkerClientID uint32 `json:"workerClientId,omitempty"`
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
		ClientID:  newClientID(),
	}
}

// regrantMaxAge is how old a previous token may be and still give its
// client ids again (Epo 2026-10-24, Q236): the unsent-edit expiry.
const regrantMaxAge = 7 * 24 * time.Hour

// regrantedClientIDs returns the client ids a reconnecting session's
// previous token offered (Epo 2026-10-24, Q236), so its Y.Doc keeps its id:
// the token must carry our signature, name this user and this room, and be
// issued at most 7 days before now; its expiry is otherwise ignored. ok is
// false for anything else, and the caller offers fresh ids. The caller's
// own access check runs first: a previous token never grants access.
func regrantedClientIDs(secret, previous, userID, room string, now time.Time) (client, worker uint32, ok bool) {
	parts := strings.Split(previous, ".")
	if secret == "" || len(parts) != 3 {
		return 0, 0, false
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return 0, 0, false
	}
	var alg struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(header, &alg) != nil || alg.Alg != "HS256" {
		return 0, 0, false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return 0, 0, false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return 0, 0, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, 0, false
	}
	var claims collaborationClaims
	if json.Unmarshal(payload, &claims) != nil {
		return 0, 0, false
	}
	issued := time.Unix(claims.IssuedAt, 0)
	if claims.Subject != userID || claims.Room != room || claims.ClientID == 0 ||
		issued.Before(now.Add(-regrantMaxAge)) || issued.After(now) {
		return 0, 0, false
	}
	return claims.ClientID, claims.WorkerClientID, true
}

// forkClientIDs are the ids BetterOffice writes seeds under within the
// uint32 range: the DOCX seed (0) and a standalone PPTX (1). No session
// draws them (M5).
var forkClientIDs = []uint32{0, 1}

// readRandom is crypto/rand's reader; a test feeds fixed draws.
var readRandom = rand.Read

// newClientID draws a Yjs client id: a random uint32 other than the fork's
// seed ids and any id in taken.
func newClientID(taken ...uint32) uint32 {
	var b [4]byte
	for {
		_, _ = readRandom(b[:])
		id := binary.BigEndian.Uint32(b[:])
		if !slices.Contains(forkClientIDs, id) && !slices.Contains(taken, id) {
			return id
		}
	}
}

// claimName is the name co-editors see on an avatar and a cursor label,
// without bidi controls or the zero-width space, word joiner and BOM, which
// could make one name read as another's. The zero-width joiner and non-joiner
// stay: Persian names and emoji sequences need them.
func claimName(name string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Bidi_Control, r) {
			return -1
		}
		switch r {
		case '\u200b', '\u2060', '\ufeff':
			return -1
		}
		return r
	}, name)
}
