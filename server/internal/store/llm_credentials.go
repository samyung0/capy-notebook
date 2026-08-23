package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"strings"

	"github.com/evonotes/server/internal/models"
)

const (
	LLMProviderOpenAI    = "openai"
	LLMProviderAnthropic = "anthropic"
	LLMProviderDeepSeek  = "deepseek"
)

var LLMCredentialProviders = []string{LLMProviderOpenAI, LLMProviderAnthropic, LLMProviderDeepSeek}

type LLMCredential struct {
	ProviderSlug string `json:"providerSlug"`
	Last4        string `json:"last4"`
}

func ValidLLMProvider(slug string) bool {
	for _, item := range LLMCredentialProviders {
		if item == slug {
			return true
		}
	}
	return false
}

func ParseCredentialKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, ErrLLMCredentialsUnavailable
	}
	if b, err := hex.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	return nil, fmt.Errorf("%w: LLM_CREDENTIALS_KEY must be 32-byte hex or base64", ErrLLMCredentialsUnavailable)
}

func encryptSecret(key, plaintext []byte) (nonce, ciphertext []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return nonce, gcm.Seal(nil, nonce, plaintext, nil), nil
}

func decryptSecret(key, nonce, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, nil)
}

func secretLast4(key string) string {
	runes := []rune(strings.TrimSpace(key))
	if len(runes) <= 4 {
		return strings.Repeat("•", 4)
	}
	return string(runes[len(runes)-4:])
}

func (s *Store) requireCredKey() error {
	if len(s.credKey) != 32 {
		return ErrLLMCredentialsUnavailable
	}
	return nil
}

func (s *Store) ListLLMCredentials(ctx context.Context, userID string) ([]LLMCredential, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT provider_slug, key_last4
		  FROM user_llm_credentials
		 WHERE user_id=$1
		 ORDER BY provider_slug`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LLMCredential{}
	for rows.Next() {
		var c LLMCredential
		if err := rows.Scan(&c.ProviderSlug, &c.Last4); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) LLMCredentialSlugs(ctx context.Context, userID string) (map[string]bool, error) {
	list, err := s.ListLLMCredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, c := range list {
		out[c.ProviderSlug] = true
	}
	return out, nil
}

func (s *Store) HasLLMCredential(ctx context.Context, userID, providerSlug string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM user_llm_credentials
			 WHERE user_id=$1 AND provider_slug=$2
		)`, userID, providerSlug).Scan(&ok)
	return ok, err
}

func (s *Store) UpsertLLMCredential(ctx context.Context, userID, providerSlug, apiKey string) error {
	if err := s.requireCredKey(); err != nil {
		return err
	}
	if !ValidLLMProvider(providerSlug) {
		return ErrNotFound
	}
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return ErrInvalidLLMKey
	}
	nonce, ct, err := encryptSecret(s.credKey, []byte(apiKey))
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO user_llm_credentials (user_id, provider_slug, key_ciphertext, key_nonce, key_last4)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id, provider_slug) DO UPDATE SET
			key_ciphertext = EXCLUDED.key_ciphertext,
			key_nonce = EXCLUDED.key_nonce,
			key_last4 = EXCLUDED.key_last4,
			updated_at = now()`,
		userID, providerSlug, ct, nonce, secretLast4(apiKey))
	return err
}

func (s *Store) DecryptLLMCredential(ctx context.Context, userID, providerSlug string) (string, error) {
	if err := s.requireCredKey(); err != nil {
		return "", err
	}
	var nonce, ct []byte
	err := s.pool.QueryRow(ctx, `
		SELECT key_nonce, key_ciphertext
		  FROM user_llm_credentials
		 WHERE user_id=$1 AND provider_slug=$2`, userID, providerSlug).
		Scan(&nonce, &ct)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	plain, err := decryptSecret(s.credKey, nonce, ct)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func (s *Store) DeleteLLMCredential(ctx context.Context, userID, providerSlug string) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM user_llm_credentials WHERE user_id=$1 AND provider_slug=$2`,
		userID, providerSlug)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return s.remapUserKeyPrefs(ctx, userID, providerSlug)
}

// remapUserKeyPrefs moves surfaces still pointing at a now-locked user_key
// model back to the surface default. platform_or_user rows stay put: they
// fall back to the env key.
func (s *Store) remapUserKeyPrefs(ctx context.Context, userID, providerSlug string) error {
	defaults := map[string]string{}
	if s.registry != nil {
		for _, surface := range []string{models.SurfaceChat, models.SurfaceGenerate, models.SurfaceEditor, models.SurfaceQuiz} {
			if pin, err := s.registry.DefaultPin(surface); err == nil {
				defaults[surface] = pin.Key
			}
		}
	}
	fallback := "deepseek-flash"
	chat := defaults[models.SurfaceChat]
	if chat == "" {
		chat = fallback
	}
	generate := defaults[models.SurfaceGenerate]
	if generate == "" {
		generate = fallback
	}
	quiz := defaults[models.SurfaceQuiz]
	if quiz == "" {
		quiz = fallback
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET
			chat_model_key = CASE
				WHEN chat_model_key IN (
					SELECT model_key FROM model_configs
					 WHERE provider_slug=$2 AND auth_mode='user_key' AND enabled
				) THEN $3 ELSE chat_model_key END,
			generate_model_key = CASE
				WHEN generate_model_key IN (
					SELECT model_key FROM model_configs
					 WHERE provider_slug=$2 AND auth_mode='user_key' AND enabled
				) THEN $4 ELSE generate_model_key END,
			quiz_model_key = CASE
				WHEN quiz_model_key IN (
					SELECT model_key FROM model_configs
					 WHERE provider_slug=$2 AND auth_mode='user_key' AND enabled
				) THEN $5 ELSE quiz_model_key END,
			updated_at = now()
		WHERE id=$1`, userID, providerSlug, chat, generate, quiz)
	return err
}
