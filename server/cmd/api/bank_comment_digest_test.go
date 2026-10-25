package main

import (
	"strings"
	"testing"
)

// A digest past its 200 listed comments ends with how many more there are
// and a link to the bank (Epo 2026-10-24, Q314; security regression:
// rate-limit audit r2 N-8).
func TestBankCommentDigestCountsTheRest(t *testing.T) {
	msg := bankCommentDigest("bank@example.test", []string{"one", "two"}, 3, "https://app.example.test/qb")
	if msg.Subject != "5 question bank comments" {
		t.Fatalf("subject %q", msg.Subject)
	}
	if !strings.HasSuffix(msg.Text, "and 3 more: https://app.example.test/qb") {
		t.Fatalf("text ends %q", msg.Text[max(0, len(msg.Text)-60):])
	}
	if got := bankCommentDigest("bank@example.test", []string{"one"}, 0, "https://app.example.test/qb"); strings.Contains(got.Text, "more") {
		t.Fatalf("a full listing mentions more: %q", got.Text)
	}
}
