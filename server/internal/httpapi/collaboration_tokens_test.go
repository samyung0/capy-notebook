package httpapi

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

func TestDeviceLabelReadsBrowserAndOS(t *testing.T) {
	for _, c := range []struct{ ua, browser, os string }{
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "Chrome", "Windows"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0", "Edge", "Windows"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Safari", "macOS"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari", "iOS"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1", "Chrome", "iOS"},
		{"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "Samsung Internet", "Android"},
		{"Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox", "Linux"},
		{"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "Chrome", "ChromeOS"},
		{"curl/8.4.0", "", ""},
		{"", "", ""},
	} {
		browser, os := deviceLabel(c.ua)
		if browser != c.browser || os != c.os {
			t.Errorf("deviceLabel(%q) = %q, %q; want %q, %q", c.ua, browser, os, c.browser, c.os)
		}
	}
}

// Security regression (Epo 2026-10-20): the claims co-editors see through the
// room's presence are present and bounded: the name cut to the user name
// limit, an avatar past its bound left out, the device a named product and
// never the raw header.
func TestCollaborationClaimsCarryABoundedIdentity(t *testing.T) {
	ua := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36 <script>"
	claims := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", "Ann Lee", "/icons/waves-01.svg", ua, "collab_1", 1)
	if claims.Name != "Ann Lee" || claims.AvatarURL != "/icons/waves-01.svg" || claims.Browser != "Chrome" || claims.OS != "Windows" {
		t.Fatalf("claims = %+v", claims)
	}
	long := newCollaborationClaims("u_1", "material:m_1:schema:1", "write", strings.Repeat("名", 90), "https://img.example/"+strings.Repeat("a", maxClaimAvatarURL), strings.Repeat("x", 4096), "collab_2", 1)
	if utf8.RuneCountInString(long.Name) != fieldlimits.UserName {
		t.Fatalf("name has %d runes, want %d", utf8.RuneCountInString(long.Name), fieldlimits.UserName)
	}
	if long.AvatarURL != "" || long.Browser != "" || long.OS != "" {
		t.Fatalf("unbounded claims kept: %+v", long)
	}
}
