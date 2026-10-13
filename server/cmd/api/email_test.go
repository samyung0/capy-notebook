package main

import "testing"

func TestStrongEmailSecret(t *testing.T) {
	if strongEmailSecret("short-A1!") {
		t.Fatal("short secret accepted")
	}
	if strongEmailSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatal("low-entropy secret accepted")
	}
	if !strongEmailSecret("aVeryLongRandomSecretValue-123456") {
		t.Fatal("strong secret rejected")
	}
}

func TestLogEmailBackendIsNotAllowedInProduction(t *testing.T) {
	if _, err := newEmailSender("production", "log", "", "", "", ""); err == nil {
		t.Fatal("production log backend was accepted")
	}
}

// Outbox payloads are camelCase JSON; templates read formatted PascalCase
// fields in the recipient's locale.
func TestEmailTemplateData(t *testing.T) {
	payload := map[string]any{
		"workspaceId":       "ws_1",
		"memberName":        "Mia Wong",
		"role":              "viewer",
		"periodEnd":         "2026-11-14T08:00:00Z",
		"storageUsedBytes":  float64(640_000_001),
		"storageLimitBytes": float64(100_000_000),
	}
	zh := emailTemplateData("workspace-invite-accepted", "zh", payload, "https://app.test", "tok")
	for key, want := range map[string]string{
		"Access":         "可查看",
		"EndsOn":         "2026年11月14日",
		"StorageUsed":    "641 MB",
		"StorageLimit":   "100 MB",
		"OpenURL":        "https://app.test/workspaces/ws_1",
		"UnsubscribeURL": "https://app.test/api/email/unsubscribe?token=tok",
	} {
		if zh[key] != want {
			t.Errorf("zh %s = %v, want %q", key, zh[key], want)
		}
	}
	en := emailTemplateData("subscription-started", "en", payload, "https://app.test", "")
	for key, want := range map[string]string{
		"RenewsOn":       "14 Nov 2026",
		"OpenURL":        "https://app.test/billing?tab=subscription",
		"UnsubscribeURL": "https://app.test/settings?tab=notifications",
	} {
		if en[key] != want {
			t.Errorf("en %s = %v, want %q", key, en[key], want)
		}
	}
	if emailCategory("welcome") != "" || emailCategory("subscription-cancelled") != "billing" {
		t.Error("welcome must carry no opt-out; subscription mail sits under billing")
	}
}
