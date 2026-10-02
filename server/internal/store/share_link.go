package store

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
)

// shareTokenPattern matches `{id}.{signature}` for a prefixed workspace or
// material id; callers check the id resolves to the kind they serve.
var shareTokenPattern = regexp.MustCompile(`^([a-z]+_[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16})$`)

// ShareToken signs a workspace or standalone material id as `{id}.{signature}`.
// The signature only proves the link came from us; privacy is still read live.
// src/lib/shareLink.ts signs and verifies the same format in the Worker.
func ShareToken(secret []byte, id string) string {
	return id + "." + base64.RawURLEncoding.EncodeToString(shareMAC(secret, id))
}

func shareMAC(secret []byte, id string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("share:v1:" + id))
	return mac.Sum(nil)[:12]
}

// VerifyShareToken returns the id a token signs, or false when it is forged.
func VerifyShareToken(secret []byte, token string) (string, bool) {
	match := shareTokenPattern.FindStringSubmatch(token)
	if match == nil {
		return "", false
	}
	given, err := base64.RawURLEncoding.DecodeString(match[2])
	if err != nil || !hmac.Equal(given, shareMAC(secret, match[1])) {
		return "", false
	}
	return match[1], true
}

// SharePath is a workspace's signed public summary path, /w/{id}.{signature}.
func SharePath(secret []byte, workspaceID string) string {
	return "/w/" + ShareToken(secret, workspaceID)
}

// materialSharePath is the signed link of a standalone quiz or flashcard set;
// workspace and embedded materials have no sharing of their own.
func materialSharePath(secret []byte, kind, id, workspaceID, parentID string) string {
	if workspaceID != "" || parentID != "" {
		return ""
	}
	switch kind {
	case "quiz":
		return "/share/quizzes/" + ShareToken(secret, id)
	case "flashcards":
		return "/share/flashcards/" + ShareToken(secret, id)
	}
	return ""
}

// VerifyShareToken checks a token against this store's link secret.
func (s *Store) VerifyShareToken(token string) (string, bool) {
	return VerifyShareToken(s.shareLinkSecret, token)
}
