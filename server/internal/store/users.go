package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/evonotes/server/internal/copytext"
	"github.com/evonotes/server/internal/models"
)

const BrowserProviderSlug = "browser"

// IsBrowserQuizModel is a client-only in-tab GGUF identity. These refs never appear
// in model_configs; the browser loads the weights itself.
func IsBrowserQuizModel(ref models.Ref) bool {
	return ref.ProviderSlug == BrowserProviderSlug && ref.ModelSlug != ""
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
		chat_model_provider_slug, chat_model_slug,
		generate_model_provider_slug, generate_model_slug,
		editor_model_provider_slug, editor_model_slug,
		quiz_model_provider_slug, quiz_model_slug,
		plan_tier, subscription_status
		FROM users WHERE id=$1`, userID)
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.AvatarURL, &u.ClassLabel, &u.Streak,
		&u.Locale,
		&u.ChatModel.ProviderSlug, &u.ChatModel.ModelSlug,
		&u.GenerateModel.ProviderSlug, &u.GenerateModel.ModelSlug,
		&u.EditorModel.ProviderSlug, &u.EditorModel.ModelSlug,
		&u.QuizModel.ProviderSlug, &u.QuizModel.ModelSlug,
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
	ChatModel        *models.Ref
	GenerateModel    *models.Ref
	EditorModel      *models.Ref
	QuizModel        *models.Ref
	ChatThinking     *string
	GenerateThinking *string
	QuizThinking     *string
}

// SetModelPrefs stores the user's chat/generate/editor/quiz preference. Omitted
// fields are left unchanged so a picker on one surface cannot wipe another.
// Thinking is stored per (user, model, surface): switching models must
// not reuse another model's level. Empty model refs are rejected: every
// account always has a concrete provider/model pair, populated from the registry
// default at insert. Model refs are validated against enabled configs that
// advertise the surface. BYOK-only rows also need a credential. Quiz
// also accepts the browser provider for in-tab GGUFs.
func (s *Store) SetModelPrefs(ctx context.Context, userID string, patch ModelPrefsPatch) error {
	prefs := []struct {
		ref     *models.Ref
		surface string
	}{
		{patch.ChatModel, SurfaceChat},
		{patch.GenerateModel, SurfaceGenerate},
		{patch.EditorModel, SurfaceEditor},
		{patch.QuizModel, SurfaceQuiz},
	}
	for _, pref := range prefs {
		if pref.ref == nil {
			continue
		}
		if pref.ref.Zero() {
			return ErrModelRefRequired
		}
		if IsBrowserQuizModel(*pref.ref) {
			if pref.surface != SurfaceQuiz {
				return ErrNotFound
			}
			continue
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var current UserLLMPrefs
	if err := tx.QueryRow(ctx, `
		SELECT chat_model_provider_slug, chat_model_slug,
		       generate_model_provider_slug, generate_model_slug,
		       editor_model_provider_slug, editor_model_slug,
		       quiz_model_provider_slug, quiz_model_slug
		  FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(
		&current.ChatModel.ProviderSlug, &current.ChatModel.ModelSlug,
		&current.GenerateModel.ProviderSlug, &current.GenerateModel.ModelSlug,
		&current.EditorModel.ProviderSlug, &current.EditorModel.ModelSlug,
		&current.QuizModel.ProviderSlug, &current.QuizModel.ModelSlug,
	); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	for _, pref := range prefs {
		if pref.ref == nil || IsBrowserQuizModel(*pref.ref) {
			continue
		}
		if err := s.assertModelRef(ctx, tx, userID, *pref.ref, pref.surface); err != nil {
			return err
		}
	}
	deref := func(p *models.Ref) models.Ref {
		if p == nil {
			return models.Ref{}
		}
		return *p
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET
		chat_model_provider_slug = CASE WHEN $2 THEN $3 ELSE chat_model_provider_slug END,
		chat_model_slug = CASE WHEN $2 THEN $4 ELSE chat_model_slug END,
		generate_model_provider_slug = CASE WHEN $5 THEN $6 ELSE generate_model_provider_slug END,
		generate_model_slug = CASE WHEN $5 THEN $7 ELSE generate_model_slug END,
		editor_model_provider_slug = CASE WHEN $8 THEN $9 ELSE editor_model_provider_slug END,
		editor_model_slug = CASE WHEN $8 THEN $10 ELSE editor_model_slug END,
		quiz_model_provider_slug = CASE WHEN $11 THEN $12 ELSE quiz_model_provider_slug END,
		quiz_model_slug = CASE WHEN $11 THEN $13 ELSE quiz_model_slug END,
		updated_at = now()
		WHERE id=$1`, userID,
		patch.ChatModel != nil, deref(patch.ChatModel).ProviderSlug, deref(patch.ChatModel).ModelSlug,
		patch.GenerateModel != nil, deref(patch.GenerateModel).ProviderSlug, deref(patch.GenerateModel).ModelSlug,
		patch.EditorModel != nil, deref(patch.EditorModel).ProviderSlug, deref(patch.EditorModel).ModelSlug,
		patch.QuizModel != nil, deref(patch.QuizModel).ProviderSlug, deref(patch.QuizModel).ModelSlug); err != nil {
		return err
	}
	chatModel := current.ChatModel
	if patch.ChatModel != nil {
		chatModel = *patch.ChatModel
	}
	generateModel := current.GenerateModel
	if patch.GenerateModel != nil {
		generateModel = *patch.GenerateModel
	}
	quizModel := current.QuizModel
	if patch.QuizModel != nil {
		quizModel = *patch.QuizModel
	}
	if err := upsertModelThinking(ctx, tx, userID, chatModel, SurfaceChat, patch.ChatThinking); err != nil {
		return err
	}
	if err := upsertModelThinking(ctx, tx, userID, generateModel, SurfaceGenerate, patch.GenerateThinking); err != nil {
		return err
	}
	if err := upsertModelThinking(ctx, tx, userID, quizModel, SurfaceQuiz, patch.QuizThinking); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func upsertModelThinking(ctx context.Context, tx pgx.Tx, userID string, ref models.Ref, surface string, thinking *string) error {
	if thinking == nil {
		return nil
	}
	if err := validateThinkingPatch(*thinking); err != nil {
		return err
	}
	if IsBrowserQuizModel(ref) {
		return ErrNotFound
	}
	if *thinking != "" {
		if err := assertCatalogThinking(ctx, tx, ref, surface, *thinking); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO user_model_reasoning (user_id, provider_slug, model_slug, surface, thinking)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id, provider_slug, model_slug, surface) DO UPDATE SET
			thinking = EXCLUDED.thinking`,
		userID, ref.ProviderSlug, ref.ModelSlug, surface, *thinking)
	return err
}

func validateThinkingPatch(thinking string) error {
	if thinking == "" || models.IsKnownThinking(thinking) {
		return nil
	}
	return ErrNotFound
}

func assertCatalogThinking(ctx context.Context, tx pgx.Tx, ref models.Ref, surface, thinking string) error {
	var levels []string
	err := tx.QueryRow(ctx, `
		SELECT thinking_levels FROM model_configs
		 WHERE provider_slug=$1 AND model_slug=$2 AND enabled AND $3 = ANY(surfaces)
		 ORDER BY version DESC LIMIT 1`, ref.ProviderSlug, ref.ModelSlug, surface).Scan(&levels)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	for _, item := range levels {
		if item == thinking {
			return nil
		}
	}
	return ErrNotFound
}

func (s *Store) assertModelRef(ctx context.Context, q rowQueryer, userID string, ref models.Ref, surface string) error {
	var platformEnabled, byokEnabled bool
	var provider string
	err := q.QueryRow(ctx, `
		SELECT platform_enabled, byok_enabled, provider_slug FROM model_configs
		 WHERE provider_slug=$1 AND model_slug=$2 AND enabled AND $3 = ANY(surfaces)
		 ORDER BY version DESC LIMIT 1`, ref.ProviderSlug, ref.ModelSlug, surface).Scan(&platformEnabled, &byokEnabled, &provider)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !platformEnabled && byokEnabled {
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
	ChatModel     models.Ref
	GenerateModel models.Ref
	EditorModel   models.Ref
	QuizModel     models.Ref
	thinking      map[modelThinkingRef]string
}

type modelThinkingRef struct {
	models.Ref
	Surface string
}

func (s *Store) UserLLMPrefs(ctx context.Context, userID string) (UserLLMPrefs, error) {
	var p UserLLMPrefs
	err := s.pool.QueryRow(ctx, `
		SELECT chat_model_provider_slug, chat_model_slug,
		       generate_model_provider_slug, generate_model_slug,
		       editor_model_provider_slug, editor_model_slug,
		       quiz_model_provider_slug, quiz_model_slug
		  FROM users WHERE id=$1`, userID).Scan(
		&p.ChatModel.ProviderSlug, &p.ChatModel.ModelSlug,
		&p.GenerateModel.ProviderSlug, &p.GenerateModel.ModelSlug,
		&p.EditorModel.ProviderSlug, &p.EditorModel.ModelSlug,
		&p.QuizModel.ProviderSlug, &p.QuizModel.ModelSlug,
	)
	if isNoRows(err) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT provider_slug, model_slug, surface, thinking
		  FROM user_model_reasoning WHERE user_id=$1`, userID)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.thinking = map[modelThinkingRef]string{}
	for rows.Next() {
		var ref models.Ref
		var surface, thinking string
		if err := rows.Scan(&ref.ProviderSlug, &ref.ModelSlug, &surface, &thinking); err != nil {
			return p, err
		}
		p.thinking[modelThinkingRef{Ref: ref, Surface: surface}] = thinking
	}
	return p, rows.Err()
}

func (p UserLLMPrefs) Model(surface string) models.Ref {
	switch surface {
	case SurfaceChat:
		return p.ChatModel
	case SurfaceGenerate:
		return p.GenerateModel
	case SurfaceEditor:
		return p.EditorModel
	case SurfaceQuiz:
		return p.QuizModel
	}
	return models.Ref{}
}

func (p UserLLMPrefs) Thinking(surface string) string {
	ref := p.Model(surface)
	if ref.Zero() || p.thinking == nil {
		return ""
	}
	return p.thinking[modelThinkingRef{Ref: ref, Surface: surface}]
}

// accountModelPrefs is the set written onto a brand-new user row. The registry
// surface default is the only source of truth.
func (s *Store) accountModelPrefs(ctx context.Context) (chat, generate, editor, quiz models.Ref, err error) {
	if s.registry == nil {
		return models.Ref{}, models.Ref{}, models.Ref{}, models.Ref{}, ErrModelUnavailable
	}
	refs := make([]models.Ref, 0, 4)
	for _, surface := range []string{models.SurfaceChat, models.SurfaceGenerate, models.SurfaceEditor, models.SurfaceQuiz} {
		pin, err := s.registry.DefaultPin(surface)
		if err != nil {
			return models.Ref{}, models.Ref{}, models.Ref{}, models.Ref{}, err
		}
		if pin.Ref.Zero() {
			return models.Ref{}, models.Ref{}, models.Ref{}, models.Ref{}, ErrModelUnavailable
		}
		refs = append(refs, pin.Ref)
	}
	return refs[0], refs[1], refs[2], refs[3], nil
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
		var locale string
		_ = s.pool.QueryRow(ctx, `SELECT locale FROM users WHERE id=$1`, id).Scan(&locale)
		name = copytext.T(locale, copytext.User)
	}
	var created bool
	chatModel, genModel, editorModel, quizModel, err := s.accountModelPrefs(ctx)
	if err != nil {
		return false, err
	}
	err = s.pool.QueryRow(ctx, `INSERT INTO users
			(id, name, email, avatar_url,
			 chat_model_provider_slug, chat_model_slug,
			 generate_model_provider_slug, generate_model_slug,
			 editor_model_provider_slug, editor_model_slug,
			 quiz_model_provider_slug, quiz_model_slug)
			VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT (id) DO UPDATE SET
			name=EXCLUDED.name,
			email=EXCLUDED.email,
			avatar_url=COALESCE(NULLIF(EXCLUDED.avatar_url,''), users.avatar_url),
			updated_at=now()
		WHERE users.deleted_at IS NULL
		RETURNING (xmax = 0)`,
		id, name, email, avatarURL,
		chatModel.ProviderSlug, chatModel.ModelSlug,
		genModel.ProviderSlug, genModel.ModelSlug,
		editorModel.ProviderSlug, editorModel.ModelSlug,
		quizModel.ProviderSlug, quizModel.ModelSlug).Scan(&created)
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
