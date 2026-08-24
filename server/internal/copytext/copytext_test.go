package copytext

import "testing"

func TestTUsesAccountLocaleThenEnglish(t *testing.T) {
	if got := T("zh", UntitledNote); got != "未命名笔记" {
		t.Fatalf("zh untitled note = %q", got)
	}
	if got := T("fr", UntitledNote); got != "Untitled note" {
		t.Fatalf("unknown locale = %q", got)
	}
	if got := T("en", NewDeck); got != "New deck" {
		t.Fatalf("en new deck = %q", got)
	}
	if got := T("zh", NewDeck); got != "新建卡组" {
		t.Fatalf("zh new deck = %q", got)
	}
}
