package fieldlimits

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestClampFileNameKeepsExtension(t *testing.T) {
	long := strings.Repeat("光", 200) + ".pdf"
	got := ClampFileName(long)
	if utf8.RuneCountInString(got) != FileName || !strings.HasSuffix(got, ".pdf") {
		t.Fatalf("got %d runes, suffix %q", utf8.RuneCountInString(got), got[len(got)-4:])
	}
	if ClampFileName(" notes.md ") != "notes.md" {
		t.Fatal("short names are only trimmed")
	}
	if got := ClampFileName(strings.Repeat("a", 130) + "." + strings.Repeat("x", 20)); utf8.RuneCountInString(got) != FileName || strings.Contains(got, ".") {
		t.Fatalf("an oversized extension is dropped, got %q", got)
	}
}

func TestClampCountsRunes(t *testing.T) {
	if got := Clamp(strings.Repeat("é", 70), UserName); utf8.RuneCountInString(got) != UserName {
		t.Fatalf("got %d runes", utf8.RuneCountInString(got))
	}
}

func TestValidFileName(t *testing.T) {
	for name, want := range map[string]bool{
		"Lecture 3.pdf": true, "计划 v2.docx": true, "👩‍💻 notes.txt": true,
		"": false, "   ": false, "a/b.pdf": false, `a\b.pdf`: false, "x\u0000.pdf": false, "x\n.pdf": false,
		"x\u202e.pdf": false, "x\u2067.pdf": false, strings.Repeat("a", FileName+1): false,
	} {
		if got := ValidFileName(name); got != want {
			t.Errorf("ValidFileName(%q) = %v, want %v", name, got, want)
		}
	}
}
