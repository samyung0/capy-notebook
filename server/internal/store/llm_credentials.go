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
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

const (
	LLMProviderOpenAI    = "openai"
	LLMProviderAnthropic = "anthropic"
	LLMProviderDeepSeek  = "deepseek"
)

var providerSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

func ValidLLMProvider(slug string) bool {
	return ValidLLMProviderSlug(slug)
}

type LLMCredential struct {
	ProviderSlug string `json:"providerSlug"`
	Last4        string `json:"last4"`
}

type LLMCredentialProvider struct {
	ProviderSlug string   `json:"providerSlug"`
	Eligible     bool     `json:"eligible"`
	Reason       string   `json:"reason,omitempty"`
	Unlocks      []string `json:"unlocks"`
	Last4        string   `json:"last4,omitempty"`
}

func ValidLLMProviderSlug(slug string) bool {
	return providerSlugPattern.MatchString(strings.TrimSpace(slug))
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
	if err := s.canUpsertLLMCredential(ctx, providerSlug); err != nil {
		return err
	}
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return ErrInvalidLLMKey
	}
	nonce, ct, err := encryptSecret(s.credKey, []byte(apiKey))
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO user_llm_credentials (user_id, provider_slug, key_ciphertext, key_nonce, key_last4)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id, provider_slug) DO UPDATE SET
			key_ciphertext = EXCLUDED.key_ciphertext,
			key_nonce = EXCLUDED.key_nonce,
			key_last4 = EXCLUDED.key_last4,
			updated_at = now()`,
		userID, providerSlug, ct, nonce, secretLast4(apiKey))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
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
	defaults, err := s.modelPreferenceDefaults()
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit decides the outcome
	if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		DELETE FROM user_llm_credentials WHERE user_id=$1 AND provider_slug=$2`,
		userID, providerSlug)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := remapUserKeyPrefs(ctx, tx, userID, providerSlug, defaults); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// modelPreferenceDefaults resolves every operator-selected default before a
// credential is deleted, so the delete never needs a hardcoded model fallback.
func (s *Store) modelPreferenceDefaults() (map[string]models.Ref, error) {
	if s.registry == nil {
		return nil, fmt.Errorf("%w: registry not configured", ErrModelUnavailable)
	}
	defaults := make(map[string]models.Ref, 4)
	for _, slot := range []string{models.SlotChat, models.SlotGenerate, models.SlotEditor, models.SlotQuiz} {
		pin, err := s.registry.DefaultPin(slot)
		if err != nil {
			return nil, fmt.Errorf("%w: %s default: %v", ErrModelUnavailable, slot, err)
		}
		defaults[slot] = pin.Ref
	}
	return defaults, nil
}

// remapUserKeyPrefs moves slots still pointing at a now-locked user_key
// model back to the slot default. platform_or_user rows stay put: they
// continue using the platform key.
func remapUserKeyPrefs(ctx context.Context, tx pgx.Tx, userID, providerSlug string, defaults map[string]models.Ref) error {
	chat := defaults[models.SlotChat]
	generate := defaults[models.SlotGenerate]
	editor := defaults[models.SlotEditor]
	quiz := defaults[models.SlotQuiz]
	_, err := tx.Exec(ctx, `
		UPDATE users SET
			chat_model_provider_slug = CASE
				WHEN (chat_model_provider_slug, chat_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $3 ELSE chat_model_provider_slug END,
			chat_model_slug = CASE
				WHEN (chat_model_provider_slug, chat_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $4 ELSE chat_model_slug END,
			generate_model_provider_slug = CASE
				WHEN (generate_model_provider_slug, generate_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $5 ELSE generate_model_provider_slug END,
			generate_model_slug = CASE
				WHEN (generate_model_provider_slug, generate_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $6 ELSE generate_model_slug END,
			editor_model_provider_slug = CASE
				WHEN (editor_model_provider_slug, editor_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $7 ELSE editor_model_provider_slug END,
			editor_model_slug = CASE
				WHEN (editor_model_provider_slug, editor_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $8 ELSE editor_model_slug END,
			quiz_model_provider_slug = CASE
				WHEN (quiz_model_provider_slug, quiz_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $9 ELSE quiz_model_provider_slug END,
			quiz_model_slug = CASE
				WHEN (quiz_model_provider_slug, quiz_model_slug) IN (
					SELECT provider_slug, model_slug FROM model_configs
					 WHERE provider_slug=$2 AND byok_enabled AND NOT platform_enabled AND enabled
				) THEN $10 ELSE quiz_model_slug END,
			updated_at = now()
		WHERE id=$1`, userID, providerSlug,
		chat.ProviderSlug, chat.ModelSlug,
		generate.ProviderSlug, generate.ModelSlug,
		editor.ProviderSlug, editor.ModelSlug,
		quiz.ProviderSlug, quiz.ModelSlug)
	return err
}

func (s *Store) canUpsertLLMCredential(ctx context.Context, providerSlug string) error {
	if !ValidLLMProviderSlug(providerSlug) {
		return ErrNotFound
	}
	if !models.IsFirstPartyProvider(providerSlug) {
		return ErrNotFound
	}
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM model_configs
			 WHERE provider_slug=$1 AND enabled AND byok_enabled
		)`, providerSlug).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListLLMCredentialProviders(ctx context.Context, userID string) ([]LLMCredentialProvider, error) {
	saved, err := s.LLMCredentialSlugs(ctx, userID)
	if err != nil {
		return nil, err
	}
	last4 := map[string]string{}
	list, err := s.ListLLMCredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, item := range list {
		last4[item.ProviderSlug] = item.Last4
	}
	rows, err := s.pool.Query(ctx, `
		SELECT provider_slug, provider_name, model_name
		  FROM model_configs
		 WHERE enabled AND byok_enabled
		 ORDER BY provider_slug, provider_name, model_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bySlug := map[string]*LLMCredentialProvider{}
	for rows.Next() {
		var slug, providerName, modelName string
		if err := rows.Scan(&slug, &providerName, &modelName); err != nil {
			return nil, err
		}
		if !models.IsFirstPartyProvider(slug) {
			continue
		}
		name := models.JoinModelLabel(providerName, modelName)
		item, ok := bySlug[slug]
		if !ok {
			item = &LLMCredentialProvider{ProviderSlug: slug, Eligible: true, Unlocks: []string{}}
			bySlug[slug] = item
		}
		item.Unlocks = append(item.Unlocks, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for slug, four := range last4 {
		if bySlug[slug] == nil {
			bySlug[slug] = &LLMCredentialProvider{
				ProviderSlug: slug,
				Eligible:     true,
				Unlocks:      []string{},
			}
		}
		bySlug[slug].Last4 = four
		_ = saved
	}
	out := make([]LLMCredentialProvider, 0, len(bySlug))
	for _, item := range bySlug {
		if item.Eligible || item.Last4 != "" {
			out = append(out, *item)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ProviderSlug < out[j].ProviderSlug
	})
	return out, nil
}
