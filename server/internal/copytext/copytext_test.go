package copytext

import "testing"

func TestTUsesAccountLocaleThenEnglish(t *testing.T) {
	if got := T("zh", UntitledNote); got != "未命名笔记" {
		t.Fatalf("zh untitled note = %q", got)
	}
	if got := T("fr", UntitledNote); got != "Untitled note" {
		t.Fatalf("unknown locale = %q", got)
	}
	if got := T("en", NewFlashcards); got != "New flashcards" {
		t.Fatalf("en new flashcards = %q", got)
	}
	if got := T("zh", NewFlashcards); got != "新建闪卡" {
		t.Fatalf("zh new flashcards = %q", got)
	}
}
