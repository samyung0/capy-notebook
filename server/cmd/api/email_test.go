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
	if _, err := newEmailSender("production", "log", "", "", ""); err == nil {
		t.Fatal("production log backend was accepted")
	}
}
