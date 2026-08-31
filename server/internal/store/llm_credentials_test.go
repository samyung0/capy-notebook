package store

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestParseCredentialKey(t *testing.T) {
	_, err := ParseCredentialKey("")
	if err != ErrLLMCredentialsUnavailable {
		t.Fatalf("empty: %v", err)
	}
	hexKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	got, err := ParseCredentialKey(hexKey)
	if err != nil || len(got) != 32 {
		t.Fatalf("hex: %v %#v", err, got)
	}
	b64 := "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
	got, err = ParseCredentialKey(b64)
	if err != nil || len(got) != 32 {
		t.Fatalf("base64: %v %#v", err, got)
	}
	if _, err := ParseCredentialKey("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); err == nil {
		t.Fatal("raw 32-byte ascii must be rejected")
	}
}

func TestEncryptSecretRoundTrip(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	nonce, ct, err := encryptSecret(key, []byte("sk-test-secret"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := decryptSecret(key, nonce, ct)
	if err != nil || string(plain) != "sk-test-secret" {
		t.Fatalf("round trip: %v %q", err, plain)
	}
	if secretLast4("sk-test-secret") != "cret" {
		t.Fatalf("last4: %s", secretLast4("sk-test-secret"))
	}
}

func TestUpsertLLMCredentialRejectsMarketplaceHop(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	s.SetLLMCredentialKey(bytes.Repeat([]byte{7}, 32))
	userID := newCreditsTestUser(t, s)
	if err := s.UpsertLLMCredential(ctx, userID, "deepinfra", "sk-or-test"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deepinfra upsert = %v, want ErrNotFound", err)
	}
}

func TestPurgeUserDeletesLLMCredentials(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	s.SetLLMCredentialKey(bytes.Repeat([]byte{7}, 32))
	userID := newCreditsTestUser(t, s)
	if err := s.UpsertLLMCredential(ctx, userID, LLMProviderOpenAI, "sk-test-openai"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, userID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM user_llm_credentials WHERE user_id=$1`, userID,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("credentials left after purge: %d", n)
	}
}

func TestDeleteLLMCredentialRequiresCatalogDefaultsBeforeMutation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	s.SetLLMCredentialKey(bytes.Repeat([]byte{7}, 32))
	userID := newCreditsTestUser(t, s)
	if err := s.UpsertLLMCredential(ctx, userID, LLMProviderOpenAI, "sk-test-openai"); err != nil {
		t.Fatal(err)
	}

	err := s.DeleteLLMCredential(ctx, userID, LLMProviderOpenAI)
	if !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("delete without registry = %v, want ErrModelUnavailable", err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM user_llm_credentials
		WHERE user_id=$1 AND provider_slug=$2`, userID, LLMProviderOpenAI).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("credential count = %d, want 1", count)
	}
}
