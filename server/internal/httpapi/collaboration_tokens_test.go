package httpapi

import (
	"crypto/rand"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// Security regression (Epo 2026-10-20): the claims co-editors see through the
// room's presence are bounded: the name without bidi controls, the zero-width
// space, word joiner or BOM (the joiner and non-joiner stay) and cut to the
// user name limit, an avatar past its bound left out.
func TestCollaborationClaimsCarryABoundedIdentity(t *testing.T) {
	claims := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", "\u202eAnn\u200b Lee\u2066\ufeff", "/icons/waves-01.svg", "collab_1", 1)
	if claims.Name != "Ann Lee" || claims.AvatarURL != "/icons/waves-01.svg" {
		t.Fatalf("claims = %+v", claims)
	}
	// The joiner and non-joiner stay: a Persian name and an emoji sequence
	// keep their shape.
	for _, name := range []string{"\u0646\u06cc\u06a9\u200c\u0646\u0627\u0645", "Ann \U0001F469\u200d\U0001F4BB"} {
		if got := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", name, "", "collab_3", 1).Name; got != name {
			t.Errorf("name %q became %q", name, got)
		}
	}
	long := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", strings.Repeat("名", 90), "https://img.example/"+strings.Repeat("a", maxClaimAvatarURL), "collab_2", 1)
	if utf8.RuneCountInString(long.Name) != fieldlimits.UserName {
		t.Fatalf("name has %d runes, want %d", utf8.RuneCountInString(long.Name), fieldlimits.UserName)
	}
	if long.AvatarURL != "" {
		t.Fatalf("unbounded avatar kept: %+v", long)
	}
}

// Security regression (Q213, Epo 2026-10-23): every token offers its own
// Yjs client id, never 0 (the DOCX seed's client), so no two sessions are
// handed the same id. Fails if the claim is missing or repeats.
// Security regression (Epo 2026-10-24, Q236): a previous token gives its
// client ids again only when it carries our signature, names the same user
// and room, and was issued at most 7 days ago (its expiry is otherwise
// ignored). Fails if a token of another user or room, an older one, or a
// forged one re-grants its id.
func TestRegrantedClientIDsNeedOurTokenForTheSameUserAndRoomWithinSevenDays(t *testing.T) {
	const secret = "collab-test-secret"
	now := time.Now()
	mint := func(user, room string, issued time.Time, key string) string {
		t.Helper()
		claims := newCollaborationClaims(user, room, "write", "Ann", "", "collab_1", 1)
		claims.IssuedAt = issued.Unix()
		claims.ExpiresAt = issued.Add(5 * time.Minute).Unix()
		claims.WorkerClientID = 77
		token, err := signCollaborationToken(key, claims)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	room := "source:f_1:epoch:1"
	expired := mint("u_1", room, now.Add(-6*24*time.Hour), secret)
	client, worker, ok := regrantedClientIDs(secret, expired, "u_1", room, now)
	if !ok || client == 0 || worker != 77 {
		t.Fatalf("an expired token under 7 days: %d %d %v", client, worker, ok)
	}
	for name, token := range map[string]string{
		"another user": mint("u_2", room, now, secret),
		"another room": mint("u_1", "source:f_1:epoch:2", now, secret),
		"over 7 days":  mint("u_1", room, now.Add(-8*24*time.Hour), secret),
		"another key":  mint("u_1", room, now, "other-secret"),
		"not a token":  "not.a.token",
		"no signature": strings.Join(strings.Split(expired, ".")[:2], ".") + ".",
		"issued ahead": mint("u_1", room, now.Add(time.Hour), secret),
	} {
		if _, _, ok := regrantedClientIDs(secret, token, "u_1", room, now); ok {
			t.Fatalf("%s re-granted its ids", name)
		}
	}
}

// Security regression (Epo 2026-10-24, M5): no session draws an id the fork
// writes seeds under (the DOCX seed 0, a standalone PPTX 1). Fails if either
// can be drawn.
func TestNewClientIDSkipsTheForksSeedIDs(t *testing.T) {
	draws := [][4]byte{{0, 0, 0, 0}, {0, 0, 0, 1}, {0, 0, 0, 5}}
	t.Cleanup(func() { readRandom = rand.Read })
	readRandom = func(b []byte) (int, error) {
		next := draws[0]
		draws = draws[1:]
		return copy(b, next[:]), nil
	}
	if id := newClientID(); id != 5 {
		t.Fatalf("drew client id %d", id)
	}
}

func TestCollaborationClaimsOfferAFreshClientID(t *testing.T) {
	seen := map[uint32]bool{}
	for range 64 {
		id := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", "Ann", "", "collab_1", 1).ClientID
		if id == 0 || seen[id] {
			t.Fatalf("client id %d (seen before: %v)", id, seen[id])
		}
		seen[id] = true
	}
}
