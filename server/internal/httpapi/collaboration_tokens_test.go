package httpapi

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// Security regression (Epo 2026-10-20): the claims co-editors see through the
// room's presence are bounded: the name without bidi controls or zero-width
// characters and cut to the user name limit, an avatar past its bound left
// out.
func TestCollaborationClaimsCarryABoundedIdentity(t *testing.T) {
	claims := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", "\u202eAnn\u200b Lee\u2066\ufeff", "/icons/waves-01.svg", "collab_1", 1)
	if claims.Name != "Ann Lee" || claims.AvatarURL != "/icons/waves-01.svg" {
		t.Fatalf("claims = %+v", claims)
	}
	long := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", strings.Repeat("名", 90), "https://img.example/"+strings.Repeat("a", maxClaimAvatarURL), "collab_2", 1)
	if utf8.RuneCountInString(long.Name) != fieldlimits.UserName {
		t.Fatalf("name has %d runes, want %d", utf8.RuneCountInString(long.Name), fieldlimits.UserName)
	}
	if long.AvatarURL != "" {
		t.Fatalf("unbounded avatar kept: %+v", long)
	}
}
