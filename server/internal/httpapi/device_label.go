package httpapi

import "strings"

// deviceLabel reads a coarse browser and OS from a User-Agent for the
// collaboration token, which co-editors see on the header's avatar hover (Epo
// 2026-10-20). It names only the products below, never echoes the header, and
// stores nothing; an unknown part is "". Order matters: Edge and Opera also
// say Chrome, Chrome also says Safari, Android also says Linux and iOS also
// says Mac OS X.
func deviceLabel(userAgent string) (browser, os string) {
	has := func(token string) bool { return strings.Contains(userAgent, token) }
	switch {
	case has("Edg/") || has("EdgA/") || has("EdgiOS/"):
		browser = "Edge"
	case has("OPR/") || has("OPiOS/"):
		browser = "Opera"
	case has("SamsungBrowser/"):
		browser = "Samsung Internet"
	case has("Firefox/") || has("FxiOS/"):
		browser = "Firefox"
	case has("Chrome/") || has("CriOS/"):
		browser = "Chrome"
	case has("Safari/") && has("Version/"):
		browser = "Safari"
	}
	switch {
	case has("Windows"):
		os = "Windows"
	case has("iPhone") || has("iPad") || has("iPod"):
		os = "iOS"
	case has("Android"):
		os = "Android"
	case has("CrOS"):
		os = "ChromeOS"
	case has("Macintosh") || has("Mac OS X"):
		os = "macOS"
	case has("Linux"):
		os = "Linux"
	}
	return browser, os
}
