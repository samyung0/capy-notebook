package httpapi

import (
	"crypto/rand"
	"strings"
	"testing"
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
