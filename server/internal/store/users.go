package store

import (
	"context"
	"encoding/json"
	"time"
)

type BillingInfo struct {
	PlanTier             PlanTier           `json:"planTier"`
	SubscriptionStatus   SubscriptionStatus `json:"subscriptionStatus"`
	RenewalAt            *time.Time         `json:"renewalAt,omitempty"`
	StorageUsedBytes     int64              `json:"storageUsedBytes"`
	StorageReservedBytes int64              `json:"storageReservedBytes"`
	StorageLimitBytes    int64              `json:"storageLimitBytes"`
}

// IntegrationsStatus reflects Clerk external-account links (not local rows).
type IntegrationsStatus struct {
	Google    bool `json:"google"`
	Microsoft bool `json:"microsoft"`
}

/* --------------------------------------------------------------- users */

func (s *Store) Me(ctx context.Context, userID string) (User, error) {
	var u User
	row := s.pool.QueryRow(ctx, `SELECT id, name, email, COALESCE(avatar_url,''), COALESCE(class_label,''), streak,
		plan_tier, subscription_status FROM users WHERE id=$1`, userID)
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.AvatarURL, &u.ClassLabel, &u.Streak, &u.PlanTier, &u.SubscriptionStatus)
	if isNoRows(err) {
		return u, ErrNotFound
	}
	return u, err
}

// UpsertUserFromClerk inserts or updates a user. The returned bool is true only
// when a new row was inserted (first sign-in), so callers can run one-time
// provisioning such as CreateDefaultWorkspace. Detection uses xmax=0, which is
// 0 for freshly inserted tuples and non-zero for rows touched by ON CONFLICT.
func (s *Store) UpsertUserFromClerk(ctx context.Context, id, name, email, avatarURL string) (bool, error) {
	if name == "" {
		name = email
	}
	if name == "" {
		name = "User"
	}
	var created bool
	err := s.pool.QueryRow(ctx, `INSERT INTO users (id, clerk_id, name, email, avatar_url)
		VALUES ($1,$1,$2,$3,NULLIF($4,''))
		ON CONFLICT (id) DO UPDATE SET
			name=EXCLUDED.name,
			email=EXCLUDED.email,
			avatar_url=COALESCE(NULLIF(EXCLUDED.avatar_url,''), users.avatar_url),
			updated_at=now()
		RETURNING (xmax = 0)`,
		id, name, email, avatarURL).Scan(&created)
	return created, err
}

func (s *Store) UpsertUserFromWebhook(ctx context.Context, id, name, email, avatarURL string) error {
	_, err := s.UpsertUserFromClerk(ctx, id, name, email, avatarURL)
	return err
}

func (s *Store) MarkUserDeleted(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET email=email || '.deleted', updated_at=now() WHERE id=$1`, id)
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
	usage, err := s.StorageUsage(ctx, userID)
	if err != nil {
		return b, err
	}
	b.StorageUsedBytes = usage.UsedBytes
	b.StorageReservedBytes = usage.ReservedBytes
	b.StorageLimitBytes = usage.LimitBytes
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

func (s *Store) UpdateSubscription(ctx context.Context, userID, status, planTier string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET subscription_status=$2, plan_tier=$3, updated_at=now() WHERE id=$1`,
		userID, status, planTier)
	return err
}

func (s *Store) UpdateSubscriptionByCustomerID(ctx context.Context, customerID, status, planTier string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET subscription_status=$2, plan_tier=$3, updated_at=now()
		WHERE stripe_customer_id=$1`, customerID, status, planTier)
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

// OAuth connection storage was removed: Clerk holds provider tokens now.
// The legacy oauth_connections table can be dropped in a future migration.
