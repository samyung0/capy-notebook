package mail

import (
	"strings"
	"testing"
)

func TestRenderWorkspaceInvite(t *testing.T) {
	subject, html, text, err := Render("workspace-invite", "en", map[string]string{
		"InviteURL":       "https://example.test/invite",
		"UnsubscribeText": "Manage preferences",
		"UnsubscribeURL":  "https://example.test/unsubscribe",
		"WorkspaceName":   "Biology",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(subject, "Biology") {
		t.Fatalf("subject = %q", subject)
	}
	for _, content := range []string{html, text} {
		if strings.Contains(content, "{{.") {
			t.Fatalf("unrendered placeholder in %q", content)
		}
	}
	if !strings.Contains(html, "https://example.test/invite") {
		t.Fatalf("invite URL missing from HTML")
	}
}

func TestUnsubscribeToken(t *testing.T) {
	token := UnsubscribeToken("secret", "u_1", "membership")
	userID, category, err := ParseUnsubscribeToken("secret", token)
	if err != nil {
		t.Fatal(err)
	}
	if userID != "u_1" || category != "membership" {
		t.Fatalf("parsed token = %q/%q", userID, category)
	}
	if _, _, err := ParseUnsubscribeToken("wrong", token); err == nil {
		t.Fatal("token accepted with wrong secret")
	}
}
