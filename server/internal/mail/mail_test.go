package mail

import (
	"strings"
	"testing"
)

func TestRenderWorkspaceInvite(t *testing.T) {
	subject, html, text, err := Render("workspace-invite", "en", map[string]string{
		"InviteURL":      "https://example.test/invite",
		"UnsubscribeURL": "https://example.test/unsubscribe",
		"WorkspaceName":  "Biology",
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

func TestRenderOfficeMaintenance(t *testing.T) {
	_, html, text, err := Render("office-maintenance", "en", map[string]any{
		"Hours":    4,
		"OpenURL":  "https://example.test/workspaces",
		"StartsAt": "13 Oct 2026, 02:00 UTC",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(html+text, "{{.") || !strings.Contains(text, "from 13 Oct 2026, 02:00 UTC for about 4 hours") {
		t.Fatalf("office maintenance text = %q", text)
	}
}

func TestRenderUsesLocalizedCopy(t *testing.T) {
	subject, html, _, err := Render("workspace-invite", "zh", map[string]string{
		"InviteURL":      "https://example.test/invite",
		"UnsubscribeURL": "https://example.test/unsubscribe",
		"WorkspaceName":  "生物",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(subject, "邀请你加入") {
		t.Fatalf("subject = %q", subject)
	}
	// The unsubscribe label is baked in at build time rather than passed as
	// template data, so a missing translation would surface here.
	if !strings.Contains(html, "管理产品邮件偏好") {
		t.Fatal("localized unsubscribe label missing from HTML")
	}
}

func TestUnsubscribeToken(t *testing.T) {
	token := UnsubscribeToken("secret", "u_1", "billing")
	userID, category, err := ParseUnsubscribeToken("secret", token)
	if err != nil {
		t.Fatal(err)
	}
	if userID != "u_1" || category != "billing" {
		t.Fatalf("parsed token = %q/%q", userID, category)
	}
	if _, _, err := ParseUnsubscribeToken("wrong", token); err == nil {
		t.Fatal("token accepted with wrong secret")
	}
}
