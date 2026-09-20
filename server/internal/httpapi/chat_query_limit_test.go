package httpapi

import (
	"strings"
	"testing"
)

func TestChatQueryCharacterLimit(t *testing.T) {
	for _, character := range []string{"a", "光", "😀"} {
		t.Run(character, func(t *testing.T) {
			if chatQueryTooLong(strings.Repeat(character, 5_000)) {
				t.Fatal("exactly 5,000 Unicode code points should fit")
			}
			if !chatQueryTooLong(strings.Repeat(character, 5_001)) {
				t.Fatal("5,001 Unicode code points must be rejected")
			}
		})
	}
}

func TestChatQueryLimitRejectsInvalidUTF8(t *testing.T) {
	if !chatQueryTooLong(string([]byte{0xff})) {
		t.Fatal("invalid UTF-8 must be rejected")
	}
}
