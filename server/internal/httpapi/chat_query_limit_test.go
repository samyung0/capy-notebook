package httpapi

import (
	"strings"
	"testing"
)

func TestChatQueryLimitKeepsAboutFiveThousandEnglishWords(t *testing.T) {
	query := strings.Repeat("word ", 5_000)
	if chatQueryTooLong(query) {
		t.Fatal("five thousand ordinary English words should fit")
	}
}

func TestChatQueryLimitRejectsEstimatedTokenOverflow(t *testing.T) {
	english := strings.Repeat("word ", 7_000)
	if !chatQueryTooLong(english) {
		t.Fatal("query above the estimated token limit was accepted")
	}
	cjk := strings.Repeat("光", chatQueryMaxEstimatedTokens+1)
	if !chatQueryTooLong(cjk) {
		t.Fatal("CJK query above the estimated token limit was accepted")
	}
}
