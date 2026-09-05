package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/copytext"
	"github.com/samyung0/capy-notebook/server/internal/models"
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
	if err == nil {
		u.PlanTier, u.SubscriptionStatus, err = s.effectiveSubscriptionStateForUser(
			ctx, s.pool, userID,
		)
	}
	return u, err
}

func (s *Store) SetLocale(ctx context.Context, userID, locale string) error {
	if locale != "en" && locale != "zh" {
		return ErrForbidden
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET locale=$2, updated_at=now()
		WHERE id=$1`, userID, locale); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ModelPrefsPatch updates one or more slot preferences. Nil fields stay.
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
// fields are left unchanged so a picker on one slot cannot wipe another.
// Thinking is stored per (user, model, slot): switching models must
// not reuse another model's level. Empty model refs are rejected: every
// account always has a concrete provider/model pair, populated from the registry
// default at insert. Model refs are validated against enabled configs that
// advertise the slot. BYOK-only rows also need a credential. Quiz
// also accepts the browser provider for in-tab GGUFs.
func (s *Store) SetModelPrefs(ctx context.Context, userID string, patch ModelPrefsPatch) error {
	prefs := []struct {
		ref  *models.Ref
		slot string
	}{
		{patch.ChatModel, models.SlotChat},
		{patch.GenerateModel, models.SlotGenerate},
		{patch.EditorModel, models.SlotEditor},
		{patch.QuizModel, models.SlotQuiz},
	}
	for _, pref := range prefs {
		if pref.ref == nil {
			continue
		}
		if pref.ref.Zero() {
			return ErrModelRefRequired
		}
		if IsBrowserQuizModel(*pref.ref) {
			if pref.slot != models.SlotQuiz {
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
	if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
		return err
	}

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
		if err := s.assertModelRef(ctx, tx, userID, *pref.ref, pref.slot); err != nil {
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
	if err := upsertModelThinking(ctx, tx, userID, chatModel, models.SlotChat, patch.ChatThinking); err != nil {
		return err
	}
	if err := upsertModelThinking(ctx, tx, userID, generateModel, models.SlotGenerate, patch.GenerateThinking); err != nil {
		return err
	}
	if err := upsertModelThinking(ctx, tx, userID, quizModel, models.SlotQuiz, patch.QuizThinking); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func upsertModelThinking(ctx context.Context, tx pgx.Tx, userID string, ref models.Ref, slot string, thinking *string) error {
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
		if err := assertCatalogThinking(ctx, tx, ref, slot, *thinking); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO user_model_reasoning (user_id, provider_slug, model_slug, slot, thinking)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id, provider_slug, model_slug, slot) DO UPDATE SET
			thinking = EXCLUDED.thinking`,
		userID, ref.ProviderSlug, ref.ModelSlug, slot, *thinking)
	return err
}

func validateThinkingPatch(thinking string) error {
	if thinking == "" || models.IsKnownThinking(thinking) {
		return nil
	}
	return ErrNotFound
}

func assertCatalogThinking(ctx context.Context, tx pgx.Tx, ref models.Ref, slot, thinking string) error {
	var levels []string
	err := tx.QueryRow(ctx, `
		SELECT thinking_levels FROM model_configs
		 WHERE provider_slug=$1 AND model_slug=$2 AND enabled AND $3 = ANY(slots)
		 ORDER BY version DESC LIMIT 1`, ref.ProviderSlug, ref.ModelSlug, slot).Scan(&levels)
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

func (s *Store) assertModelRef(ctx context.Context, q rowQueryer, userID string, ref models.Ref, slot string) error {
	var platformEnabled, byokEnabled bool
	var provider string
	err := q.QueryRow(ctx, `
		SELECT platform_enabled, byok_enabled, provider_slug FROM model_configs
		 WHERE provider_slug=$1 AND model_slug=$2 AND enabled AND $3 = ANY(slots)
		 ORDER BY version DESC LIMIT 1`, ref.ProviderSlug, ref.ModelSlug, slot).Scan(&platformEnabled, &byokEnabled, &provider)
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
	Slot string
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
		SELECT provider_slug, model_slug, slot, thinking
		  FROM user_model_reasoning WHERE user_id=$1`, userID)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.thinking = map[modelThinkingRef]string{}
	for rows.Next() {
		var ref models.Ref
		var slot, thinking string
		if err := rows.Scan(&ref.ProviderSlug, &ref.ModelSlug, &slot, &thinking); err != nil {
			return p, err
		}
		p.thinking[modelThinkingRef{Ref: ref, Slot: slot}] = thinking
	}
	return p, rows.Err()
}

func (p UserLLMPrefs) Model(slot string) models.Ref {
	switch slot {
	case models.SlotChat:
		return p.ChatModel
	case models.SlotGenerate:
		return p.GenerateModel
	case models.SlotEditor:
		return p.EditorModel
	case models.SlotQuiz:
		return p.QuizModel
	}
	return models.Ref{}
}

func (p UserLLMPrefs) Thinking(slot string) string {
	ref := p.Model(slot)
	if ref.Zero() || p.thinking == nil {
		return ""
	}
	return p.thinking[modelThinkingRef{Ref: ref, Slot: slot}]
}

// accountModelPrefs is the set written onto a brand-new user row. The registry
// slot default is the only source of truth.
func (s *Store) accountModelPrefs(ctx context.Context) (chat, generate, editor, quiz models.Ref, err error) {
	if s.registry == nil {
		return models.Ref{}, models.Ref{}, models.Ref{}, models.Ref{}, ErrModelUnavailable
	}
	refs := make([]models.Ref, 0, 4)
	for _, slot := range []string{models.SlotChat, models.SlotGenerate, models.SlotEditor, models.SlotQuiz} {
		pin, err := s.registry.DefaultPin(slot)
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

// UpsertUserFromClerk inserts or updates a user. The returned bool reports
// whether the account still needs its one-time starter workspace. Keeping that
// state on the user row lets a later request retry a failed first provision.
//
// The profile sync deliberately skips locked rows. This runs before the auth
// middleware's lifecycle check on every authenticated request, so without the
// guard a stale Clerk token could refresh PII after deletion was requested or
// while an operator suspension was in force. Purged tombstones must never be
// repopulated either.
func (s *Store) UpsertUserFromClerk(ctx context.Context, id, name, email, avatarURL string) (bool, error) {
	if name == "" {
		name = email
	}
	if name == "" {
		var locale string
		_ = s.pool.QueryRow(ctx, `SELECT locale FROM users WHERE id=$1`, id).Scan(&locale)
		name = copytext.T(locale, copytext.User)
	}
	// Most calls are profile refreshes for an existing account. Handle those
	// without consulting the model registry: changing or temporarily disabling
	// the signup defaults must not make an existing session fail. Locked rows
	// intentionally do not match this update.
	var needsDefaultWorkspace bool
	err := s.pool.QueryRow(ctx, `UPDATE users SET
			name=$2,
			email=COALESCE(NULLIF($3,''), email),
			avatar_url=COALESCE(NULLIF($4,''), avatar_url),
			updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL
			AND deletion_requested_at IS NULL
			AND suspended_at IS NULL
		RETURNING starter_workspace_provisioned_at IS NULL`, id, name, email, avatarURL).
		Scan(&needsDefaultWorkspace)
	if err == nil {
		return needsDefaultWorkspace, nil
	}
	if !isNoRows(err) {
		return false, err
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, id).
		Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}

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
			email=COALESCE(EXCLUDED.email, users.email),
			avatar_url=COALESCE(NULLIF(EXCLUDED.avatar_url,''), users.avatar_url),
			updated_at=now()
		WHERE users.deleted_at IS NULL
			AND users.deletion_requested_at IS NULL
			AND users.suspended_at IS NULL
		RETURNING starter_workspace_provisioned_at IS NULL`,
		id, name, email, avatarURL,
		chatModel.ProviderSlug, chatModel.ModelSlug,
		genModel.ProviderSlug, genModel.ModelSlug,
		editorModel.ProviderSlug, editorModel.ModelSlug,
		quizModel.ProviderSlug, quizModel.ModelSlug).Scan(&needsDefaultWorkspace)
	// The WHERE clause suppresses the RETURNING row for a tombstone, which is
	// not an error: the account exists and stays scrubbed.
	if isNoRows(err) {
		return false, nil
	}
	return needsDefaultWorkspace, err
}

func (s *Store) UpsertUserFromWebhook(ctx context.Context, id, name, email, avatarURL string) error {
	_, err := s.UpsertUserFromClerk(ctx, id, name, email, avatarURL)
	return err
}

// CreateDefaultWorkspace provisions a starter workspace once. It uses the same
// user-row lock as every owned-workspace insert, then makes the empty check,
// insert, and completion marker one transaction. The durable marker lets a
// failed first attempt retry without recreating a workspace the user deletes.
func (s *Store) CreateDefaultWorkspace(ctx context.Context, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
		var locked *AccountLockedError
		if errors.As(err, &locked) {
			// A late identity event must not recreate content after the local
			// account crossed a terminal boundary.
			return nil
		}
		return err
	}
	status, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return err
	}
	if err := status.CreateErr(); err != nil {
		var locked *AccountLockedError
		if errors.As(err, &locked) {
			return nil
		}
		return err
	}

	var provisioned bool
	if err := tx.QueryRow(ctx, `SELECT starter_workspace_provisioned_at IS NOT NULL
		FROM users WHERE id=$1`, userID).Scan(&provisioned); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if provisioned {
		return tx.Commit(ctx)
	}

	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE user_id=$1`, userID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.gateOwnedWorkspacesTx(ctx, tx, userID, 1); err != nil {
			return err
		}
		embed, err := s.newWorkspaceEmbedding(ctx)
		if err != nil {
			return err
		}
		if err := s.insertWorkspaceTx(
			ctx, tx, uid("ws"), userID, "My workspace", ColorGreen, nil, embed,
		); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET
		starter_workspace_provisioned_at=COALESCE(starter_workspace_provisioned_at,now()),
		updated_at=now() WHERE id=$1`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
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

var ErrWebhookInProgress = errors.New("webhook event is already being processed")
var ErrWebhookClaimLost = errors.New("webhook event claim was lost")

// ClaimWebhookEvent atomically records and leases an event. A failed handler
// clears its lease in MarkWebhookProcessed so delivery can retry immediately;
// the timeout recovers a process that died before it could mark the row.
func (s *Store) ClaimWebhookEvent(
	ctx context.Context,
	id, source, eventType, userID string,
	payload json.RawMessage,
) (string, bool, error) {
	token := uid("webhook")
	var claimed string
	err := s.pool.QueryRow(ctx, `INSERT INTO webhook_events
			(id, source, event_type, user_id, payload, processing_token, processing_started_at)
		SELECT $1,$2,$3,(SELECT id FROM users WHERE id=$4),
			CASE WHEN EXISTS (SELECT 1 FROM users u
				WHERE u.id=$4 AND (u.deleted_at IS NOT NULL OR u.identity_deleted_at IS NOT NULL))
			THEN '{}'::jsonb ELSE $5::jsonb END,
			$6,now()
		ON CONFLICT (source,id) DO UPDATE SET
			event_type=EXCLUDED.event_type,
			user_id=COALESCE(EXCLUDED.user_id, webhook_events.user_id),
			payload=CASE WHEN EXISTS (SELECT 1 FROM users u
				WHERE u.id=COALESCE(EXCLUDED.user_id, webhook_events.user_id)
					AND (u.deleted_at IS NOT NULL OR u.identity_deleted_at IS NOT NULL))
				THEN '{}'::jsonb ELSE EXCLUDED.payload END,
			processing_token=EXCLUDED.processing_token,
			processing_started_at=now(), error=NULL
		WHERE webhook_events.processed_at IS NULL
		  AND (webhook_events.processing_token IS NULL
		       OR webhook_events.processing_started_at < now()-interval '5 minutes')
		RETURNING processing_token`, id, source, eventType, nullStr(userID), payload, token).Scan(&claimed)
	if err == nil {
		return claimed, false, nil
	}
	if !isNoRows(err) {
		return "", false, err
	}
	var processed bool
	if err := s.pool.QueryRow(ctx, `SELECT processed_at IS NOT NULL AND error IS NULL
		FROM webhook_events WHERE source=$1 AND id=$2`, source, id).Scan(&processed); err != nil {
		return "", false, err
	}
	if processed {
		return "", true, nil
	}
	return "", false, ErrWebhookInProgress
}

// RedactWebhookEvent removes a terminal event body that cannot be associated
// with a live local user. The delivery identity and outcome remain available
// for idempotency and diagnostics without retaining provider PII indefinitely.
func (s *Store) RedactWebhookEvent(ctx context.Context, source, id, token string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE webhook_events SET payload='{}'::jsonb
		WHERE source=$1 AND id=$2 AND processing_token=$3`, source, id, token)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrWebhookClaimLost
	}
	return nil
}

func (s *Store) AssociateWebhookEvent(ctx context.Context, source, id, token, userID string) error {
	if userID == "" {
		return nil
	}
	tag, err := s.pool.Exec(ctx, `UPDATE webhook_events SET user_id=$4,
		payload=CASE WHEN EXISTS (SELECT 1 FROM users u
			WHERE u.id=$4 AND (u.deleted_at IS NOT NULL OR u.identity_deleted_at IS NOT NULL))
			THEN '{}'::jsonb ELSE payload END
		WHERE source=$1 AND id=$2 AND processing_token=$3`, source, id, token, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrWebhookClaimLost
	}
	return nil
}

func (s *Store) MarkWebhookProcessed(ctx context.Context, source, id, token string, procErr error) error {
	var errStr *string
	if procErr != nil {
		s := procErr.Error()
		errStr = &s
	}
	tag, err := s.pool.Exec(ctx, `UPDATE webhook_events SET
		processed_at=CASE WHEN $3::text IS NULL THEN now() ELSE NULL END,
		error=$3, processing_token=NULL, processing_started_at=NULL
		WHERE source=$1 AND id=$2 AND processing_token=$4`, source, id, errStr, token)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrWebhookClaimLost
	}
	return nil
}

/* --------------------------------------------------------- billing */

func (s *Store) GetBilling(ctx context.Context, userID string) (BillingInfo, error) {
	var b BillingInfo
	var err error
	b.PlanTier, b.SubscriptionStatus, err = s.effectiveSubscriptionStateForUser(
		ctx, s.pool, userID,
	)
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

func (s *Store) UserIDByStripeCustomer(ctx context.Context, customerID string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id FROM users WHERE stripe_customer_id=$1`, customerID).Scan(&id)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return id, err
}

type StripeCustomer struct {
	UserID          string
	CustomerID      string
	PlanTier        string
	Status          string
	LifecycleClosed bool
}

func (s *Store) ListStripeCustomers(ctx context.Context) ([]StripeCustomer, error) {
	rows, err := s.pool.Query(ctx, `SELECT u.id, u.stripe_customer_id,
		CASE WHEN NOT EXISTS(SELECT 1 FROM user_subscriptions any_sub
				WHERE any_sub.user_id=u.id) THEN u.plan_tier
			ELSE COALESCE((SELECT live.plan_tier FROM user_subscriptions live
				WHERE live.user_id=u.id AND live.status IN `+entitlingStatuses+`
				  AND (live.current_period_end IS NULL OR live.current_period_end > now())
				ORDER BY (live.plan_tier='pro') DESC,
				  live.current_period_end DESC NULLS FIRST LIMIT 1), 'free') END,
		CASE WHEN NOT EXISTS(SELECT 1 FROM user_subscriptions any_sub
				WHERE any_sub.user_id=u.id) THEN u.subscription_status
			ELSE COALESCE((SELECT live.status FROM user_subscriptions live
				WHERE live.user_id=u.id AND live.status IN `+entitlingStatuses+`
				  AND (live.current_period_end IS NULL OR live.current_period_end > now())
				ORDER BY (live.plan_tier='pro') DESC,
				  live.current_period_end DESC NULLS FIRST LIMIT 1), 'canceled') END,
		(u.deletion_requested_at IS NOT NULL OR u.deleted_at IS NOT NULL OR
		 u.suspended_at IS NOT NULL)
		FROM users u WHERE u.stripe_customer_id IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StripeCustomer{}
	for rows.Next() {
		var row StripeCustomer
		if err := rows.Scan(
			&row.UserID, &row.CustomerID, &row.PlanTier, &row.Status, &row.LifecycleClosed,
		); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// OAuth connection storage was removed: Clerk holds provider tokens now, and
// the legacy oauth_connections table is gone from the baseline schema.
