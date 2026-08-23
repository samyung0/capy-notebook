package store

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/evonotes/server/internal/models"
)

const browserQuizPrefix = "browser:"

// IsBrowserQuizKey is a client-only in-tab GGUF id. Those keys never appear
// in model_configs; the browser loads the weights itself.
func IsBrowserQuizKey(key string) bool {
	return strings.HasPrefix(key, browserQuizPrefix) && key != browserQuizPrefix
}

type BillingInfo struct {
	PlanTier           PlanTier           `json:"planTier"`
	SubscriptionStatus SubscriptionStatus `json:"subscriptionStatus"`
	// RenewalAt is the end of the paid period: the next charge date normally, or
	// the date access stops when CancelAtPeriodEnd is set.
	RenewalAt *time.Time `json:"renewalAt,omitempty"`
	// CancelAtPeriodEnd distinguishes "renews then" from "ends then", which the
	// deletion precondition also needs: a subscription set to cancel already
	// satisfies the cancel-before-deleting requirement.
	CancelAtPeriodEnd    bool  `json:"cancelAtPeriodEnd"`
	StorageUsedBytes     int64 `json:"storageUsedBytes"`
	StorageReservedBytes int64 `json:"storageReservedBytes"`
	StorageLimitBytes    int64 `json:"storageLimitBytes"`
	// Monthly AI allowance. Distinct from storage: the actor spends credits,
	// the workspace owner spends bytes.
	CreditsUsedMicros     int64     `json:"creditsUsedMicros"`
	CreditsReservedMicros int64     `json:"creditsReservedMicros"`
	CreditsLimitMicros    int64     `json:"creditsLimitMicros"`
	CreditsPeriodStart    time.Time `json:"creditsPeriodStart"`
}

// IntegrationsStatus reflects Clerk external-account links (not local rows).
type IntegrationsStatus struct {
	Google    bool `json:"google"`
	Microsoft bool `json:"microsoft"`
}

/* --------------------------------------------------------------- users */

func (s *Store) Me(ctx context.Context, userID string) (User, error) {
	var u User
	row := s.pool.QueryRow(ctx, `SELECT id, name, COALESCE(email,''), COALESCE(avatar_url,''),
		COALESCE(class_label,''), streak, locale,
		chat_model_key, generate_model_key, editor_model_key, quiz_model_key,
		plan_tier, subscription_status
		FROM users WHERE id=$1`, userID)
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.AvatarURL, &u.ClassLabel, &u.Streak,
		&u.Locale, &u.ChatModelKey, &u.GenerateModelKey, &u.EditorModelKey, &u.QuizModelKey,
		&u.PlanTier, &u.SubscriptionStatus)
	if isNoRows(err) {
		return u, ErrNotFound
	}
	return u, err
}

func (s *Store) SetLocale(ctx context.Context, userID, locale string) error {
	if locale != "en" && locale != "zh" {
		return ErrForbidden
	}
	_, err := s.pool.Exec(ctx, `UPDATE users SET locale=$2, updated_at=now() WHERE id=$1`, userID, locale)
	return err
}

// ModelPrefsPatch updates one or more surface preferences. Nil fields stay.
type ModelPrefsPatch struct {
	ChatModelKey            *string
	GenerateModelKey        *string
	EditorModelKey          *string
	QuizModelKey            *string
	ChatReasoningMode       *string
	ChatReasoningEffort     *string
	GenerateReasoningMode   *string
	GenerateReasoningEffort *string
	QuizReasoningMode       *string
	QuizReasoningEffort     *string
}

// SetModelPrefs stores the user's chat/generate/editor/quiz preference. Omitted
// fields are left unchanged so a picker on one surface cannot wipe another.
// Empty model keys are rejected: every account always has a concrete key,
// populated from the registry default at insert. Registry keys are validated
// against enabled configs that advertise the surface. user_key rows also need
// a credential. Quiz also accepts a browser: prefix for in-tab GGUFs.
func (s *Store) SetModelPrefs(ctx context.Context, userID string, patch ModelPrefsPatch) error {
	for _, pref := range []struct {
		key     *string
		surface string
	}{
		{patch.ChatModelKey, SurfaceChat},
		{patch.GenerateModelKey, SurfaceGenerate},
		{patch.EditorModelKey, SurfaceEditor},
		{patch.QuizModelKey, SurfaceQuiz},
	} {
		if pref.key == nil {
			continue
		}
		if *pref.key == "" {
			return ErrModelKeyRequired
		}
		if IsBrowserQuizKey(*pref.key) {
			if pref.surface != SurfaceQuiz {
				return ErrNotFound
			}
			continue
		}
		if err := s.assertModelKey(ctx, userID, *pref.key, pref.surface); err != nil {
			return err
		}
	}
	if err := validateReasoningPatch(patch.ChatReasoningMode, patch.ChatReasoningEffort); err != nil {
		return err
	}
	if err := validateReasoningPatch(patch.GenerateReasoningMode, patch.GenerateReasoningEffort); err != nil {
		return err
	}
	if err := validateReasoningPatch(patch.QuizReasoningMode, patch.QuizReasoningEffort); err != nil {
		return err
	}
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	_, err := s.pool.Exec(ctx, `UPDATE users SET
		chat_model_key = CASE WHEN $2 THEN $3 ELSE chat_model_key END,
		generate_model_key = CASE WHEN $4 THEN $5 ELSE generate_model_key END,
		editor_model_key = CASE WHEN $6 THEN $7 ELSE editor_model_key END,
		quiz_model_key = CASE WHEN $8 THEN $9 ELSE quiz_model_key END,
		chat_reasoning_mode = CASE WHEN $10 THEN $11 ELSE chat_reasoning_mode END,
		chat_reasoning_effort = CASE WHEN $12 THEN $13 ELSE chat_reasoning_effort END,
		generate_reasoning_mode = CASE WHEN $14 THEN $15 ELSE generate_reasoning_mode END,
		generate_reasoning_effort = CASE WHEN $16 THEN $17 ELSE generate_reasoning_effort END,
		quiz_reasoning_mode = CASE WHEN $18 THEN $19 ELSE quiz_reasoning_mode END,
		quiz_reasoning_effort = CASE WHEN $20 THEN $21 ELSE quiz_reasoning_effort END,
		updated_at = now()
		WHERE id=$1`, userID,
		patch.ChatModelKey != nil, deref(patch.ChatModelKey),
		patch.GenerateModelKey != nil, deref(patch.GenerateModelKey),
		patch.EditorModelKey != nil, deref(patch.EditorModelKey),
		patch.QuizModelKey != nil, deref(patch.QuizModelKey),
		patch.ChatReasoningMode != nil, deref(patch.ChatReasoningMode),
		patch.ChatReasoningEffort != nil, deref(patch.ChatReasoningEffort),
		patch.GenerateReasoningMode != nil, deref(patch.GenerateReasoningMode),
		patch.GenerateReasoningEffort != nil, deref(patch.GenerateReasoningEffort),
		patch.QuizReasoningMode != nil, deref(patch.QuizReasoningMode),
		patch.QuizReasoningEffort != nil, deref(patch.QuizReasoningEffort))
	return err
}

func validateReasoningPatch(mode, effort *string) error {
	if mode != nil && *mode != "" && *mode != "off" && *mode != "on" {
		return ErrNotFound
	}
	if effort != nil && *effort != "" {
		switch *effort {
		case "low", "medium", "high", "xhigh", "max":
		default:
			return ErrNotFound
		}
	}
	return nil
}

func (s *Store) assertModelKey(ctx context.Context, userID, key, surface string) error {
	var authMode, provider string
	err := s.pool.QueryRow(ctx, `
		SELECT auth_mode, provider_slug FROM model_configs
		 WHERE model_key=$1 AND enabled AND $2 = ANY(surfaces)
		 ORDER BY version DESC LIMIT 1`, key, surface).Scan(&authMode, &provider)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if authMode == models.AuthUserKey {
		ok, credErr := s.HasLLMCredential(ctx, userID, provider)
		if credErr != nil {
			return credErr
		}
		if !ok {
			return ErrModelUnavailable
		}
	}
	return nil
}

type UserLLMPrefs struct {
	ChatModelKey            string
	GenerateModelKey        string
	EditorModelKey          string
	QuizModelKey            string
	ChatReasoningMode       string
	ChatReasoningEffort     string
	GenerateReasoningMode   string
	GenerateReasoningEffort string
	QuizReasoningMode       string
	QuizReasoningEffort     string
}

func (s *Store) UserLLMPrefs(ctx context.Context, userID string) (UserLLMPrefs, error) {
	var p UserLLMPrefs
	err := s.pool.QueryRow(ctx, `
		SELECT chat_model_key, generate_model_key, editor_model_key, quiz_model_key,
		       chat_reasoning_mode, chat_reasoning_effort,
		       generate_reasoning_mode, generate_reasoning_effort,
		       quiz_reasoning_mode, quiz_reasoning_effort
		  FROM users WHERE id=$1`, userID).Scan(
		&p.ChatModelKey, &p.GenerateModelKey, &p.EditorModelKey, &p.QuizModelKey,
		&p.ChatReasoningMode, &p.ChatReasoningEffort,
		&p.GenerateReasoningMode, &p.GenerateReasoningEffort,
		&p.QuizReasoningMode, &p.QuizReasoningEffort,
	)
	if isNoRows(err) {
		return p, ErrNotFound
	}
	return p, err
}

func (p UserLLMPrefs) ModelKey(surface string) string {
	switch surface {
	case SurfaceChat:
		return p.ChatModelKey
	case SurfaceGenerate:
		return p.GenerateModelKey
	case SurfaceEditor:
		return p.EditorModelKey
	case SurfaceQuiz:
		return p.QuizModelKey
	}
	return ""
}

func (p UserLLMPrefs) Reasoning(surface string) (mode, effort string) {
	switch surface {
	case SurfaceChat:
		return p.ChatReasoningMode, p.ChatReasoningEffort
	case SurfaceGenerate:
		return p.GenerateReasoningMode, p.GenerateReasoningEffort
	case SurfaceQuiz:
		return p.QuizReasoningMode, p.QuizReasoningEffort
	}
	return "", ""
}

// accountModelPrefs is the set written onto a brand-new user row. The registry
// surface default is the source of truth (ops registry grid); deepseek-flash is
// only the last resort when this process has no registry (tests that insert
// users without wiring one).
func (s *Store) accountModelPrefs(ctx context.Context) (chat, generate, editor, quiz string, err error) {
	const fallback = "deepseek-flash"
	if s.registry == nil {
		return fallback, fallback, fallback, fallback, nil
	}
	keys := make([]string, 0, 4)
	for _, surface := range []string{models.SurfaceChat, models.SurfaceGenerate, models.SurfaceEditor, models.SurfaceQuiz} {
		pin, err := s.registry.DefaultPin(surface)
		if err != nil {
			return "", "", "", "", err
		}
		if pin.Key == "" {
			return "", "", "", "", ErrModelUnavailable
		}
		keys = append(keys, pin.Key)
	}
	return keys[0], keys[1], keys[2], keys[3], nil
}

// UpsertUserFromClerk inserts or updates a user. The returned bool is true only
// when a new row was inserted (first sign-in), so callers can run one-time
// provisioning such as CreateDefaultWorkspace. Detection uses xmax=0, which is
// 0 for freshly inserted tuples and non-zero for rows touched by ON CONFLICT.
//
// The profile sync deliberately skips purged rows. This runs on every
// authenticated request, so without the guard a scrubbed tombstone would be
// repopulated with the name and email the purge just erased, the moment a
// still-valid Clerk identity made one more call.
func (s *Store) UpsertUserFromClerk(ctx context.Context, id, name, email, avatarURL string) (bool, error) {
	if name == "" {
		name = email
	}
	if name == "" {
		name = "User"
	}
	var created bool
	chatKey, genKey, editorKey, quizKey, err := s.accountModelPrefs(ctx)
	if err != nil {
		return false, err
	}
	err = s.pool.QueryRow(ctx, `INSERT INTO users
			(id, name, email, avatar_url, chat_model_key, generate_model_key, editor_model_key, quiz_model_key)
		VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8)
		ON CONFLICT (id) DO UPDATE SET
			name=EXCLUDED.name,
			email=EXCLUDED.email,
			avatar_url=COALESCE(NULLIF(EXCLUDED.avatar_url,''), users.avatar_url),
			updated_at=now()
		WHERE users.deleted_at IS NULL
		RETURNING (xmax = 0)`,
		id, name, email, avatarURL, chatKey, genKey, editorKey, quizKey).Scan(&created)
	// The WHERE clause suppresses the RETURNING row for a tombstone, which is
	// not an error: the account exists and stays scrubbed.
	if isNoRows(err) {
		return false, nil
	}
	return created, err
}

func (s *Store) UpsertUserFromWebhook(ctx context.Context, id, name, email, avatarURL string) error {
	_, err := s.UpsertUserFromClerk(ctx, id, name, email, avatarURL)
	return err
}

// CreateDefaultWorkspace provisions a starter workspace on first sign-in. Both
// the Clerk webhook and the JWT middleware can invoke this concurrently for the
// same brand-new user, so a session-level advisory lock serializes the
// check-then-create critical section to prevent duplicate default workspaces.
func (s *Store) CreateDefaultWorkspace(ctx context.Context, userID string) error {
	lockKey := "ws_default:" + userID
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, lockKey); err != nil {
		return err
	}
	// Unlock on a detached context so release still runs if ctx is cancelled.
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext($1))`, lockKey)
	}()

	var n int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE user_id=$1`, userID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err = s.CreateWorkspace(ctx, userID, "My workspace", ColorGreen, []TagRef{})
	return err
}

func (s *Store) AssertWorkspaceOwner(ctx context.Context, userID, wsID string) error {
	var owner *string
	err := s.pool.QueryRow(ctx, `SELECT user_id FROM workspaces WHERE id=$1`, wsID).Scan(&owner)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if owner == nil || *owner != userID {
		return ErrNotFound
	}
	return nil
}

/* --------------------------------------------------------- webhooks */

func (s *Store) WebhookProcessed(ctx context.Context, id string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `SELECT exists(SELECT 1 FROM webhook_events WHERE id=$1 AND processed_at IS NOT NULL)`, id).Scan(&exists)
	return exists, err
}

func (s *Store) RecordWebhookEvent(ctx context.Context, id, source, eventType string, payload json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO webhook_events (id, source, event_type, payload)
		VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, id, source, eventType, payload)
	return err
}

func (s *Store) MarkWebhookProcessed(ctx context.Context, id string, procErr error) error {
	var errStr *string
	if procErr != nil {
		s := procErr.Error()
		errStr = &s
	}
	_, err := s.pool.Exec(ctx, `UPDATE webhook_events SET processed_at=now(), error=$2 WHERE id=$1`, id, errStr)
	return err
}

/* --------------------------------------------------------- billing */

func (s *Store) GetBilling(ctx context.Context, userID string) (BillingInfo, error) {
	var b BillingInfo
	err := s.pool.QueryRow(ctx, `SELECT plan_tier, subscription_status FROM users WHERE id=$1`, userID).
		Scan(&b.PlanTier, &b.SubscriptionStatus)
	if isNoRows(err) {
		return b, ErrNotFound
	}
	if err != nil {
		return b, err
	}
	// RenewalAt was permanently null before user_subscriptions existed: nothing
	// persisted the period end, so it was not merely unread but uncomputable.
	sub, err := s.SubscriptionForUser(ctx, userID)
	if err != nil {
		return b, err
	}
	if sub != nil {
		b.RenewalAt = sub.CurrentPeriodEnd
		b.CancelAtPeriodEnd = sub.CancelAtPeriodEnd
	}
	usage, err := s.StorageUsage(ctx, userID)
	if err != nil {
		return b, err
	}
	b.StorageUsedBytes = usage.UsedBytes
	b.StorageReservedBytes = usage.ReservedBytes
	b.StorageLimitBytes = usage.LimitBytes
	credits, err := s.CreditBalance(ctx, userID)
	if err != nil {
		return b, err
	}
	b.CreditsUsedMicros = credits.UsedMicros
	b.CreditsReservedMicros = credits.ReservedMicros
	b.CreditsLimitMicros = credits.LimitMicros
	b.CreditsPeriodStart = credits.PeriodStart
	return b, nil
}

func (s *Store) GetStripeCustomerID(ctx context.Context, userID string) (string, error) {
	var id *string
	err := s.pool.QueryRow(ctx, `SELECT stripe_customer_id FROM users WHERE id=$1`, userID).Scan(&id)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if id == nil {
		return "", nil
	}
	return *id, err
}

func (s *Store) SetStripeCustomerID(ctx context.Context, userID, customerID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET stripe_customer_id=$2, updated_at=now() WHERE id=$1`, userID, customerID)
	return err
}

func (s *Store) UserIDByStripeCustomer(ctx context.Context, customerID string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id FROM users WHERE stripe_customer_id=$1`, customerID).Scan(&id)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return id, err
}

func (s *Store) ListStripeCustomers(ctx context.Context) ([]struct {
	UserID     string
	CustomerID string
	PlanTier   string
	Status     string
}, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, stripe_customer_id, plan_tier, subscription_status
		FROM users WHERE stripe_customer_id IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []struct {
		UserID     string
		CustomerID string
		PlanTier   string
		Status     string
	}{}
	for rows.Next() {
		var row struct {
			UserID     string
			CustomerID string
			PlanTier   string
			Status     string
		}
		if err := rows.Scan(&row.UserID, &row.CustomerID, &row.PlanTier, &row.Status); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// OAuth connection storage was removed: Clerk holds provider tokens now, and
// the legacy oauth_connections table is gone from the baseline schema.
