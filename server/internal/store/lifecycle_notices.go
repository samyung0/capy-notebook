package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Buffer reminder schedule relative to the end of the over-quota grace window
// (lapse + overQuotaBufferDays). Notices fire at the start of grace, seven and
// three days before freeze, and once when frozen.
const (
	lifecycleNoticeStarted = "over_quota_started"
	lifecycleNoticeT7      = "over_quota_t7"
	lifecycleNoticeT3      = "over_quota_t3"
	lifecycleNoticeFrozen  = "over_quota_frozen"
)

// SweepOverQuotaNotices sends the buffer-period reminders for every lapsed,
// over-limit account. Freeze itself is derived state — this only notifies.
func (s *Store) SweepOverQuotaNotices(ctx context.Context) (int, error) {
	// Candidate: most recent paid period has ended, account not deleted /
	// suspended / pending deletion. Storage comparison happens per row.
	rows, err := s.pool.Query(ctx, `SELECT u.id, u.email, u.locale,
		GREATEST(
			max(s.current_period_end) FILTER (
				WHERE s.plan_tier='pro' AND s.status IN `+entitlingStatuses+`
					AND s.current_period_end <= now()),
			max(LEAST(
				COALESCE(s.current_period_end, s.ended_at, s.canceled_at,
					to_timestamp(NULLIF(s.stripe_event_created, 0)), s.updated_at),
				COALESCE(s.ended_at, s.canceled_at,
					to_timestamp(NULLIF(s.stripe_event_created, 0)), s.updated_at)
			)) FILTER (WHERE s.plan_tier='pro' AND s.status NOT IN `+entitlingStatuses+`)
		)
		FROM users u
		JOIN user_subscriptions s ON s.user_id = u.id
		WHERE u.deleted_at IS NULL
			AND u.suspended_at IS NULL
			AND u.deletion_requested_at IS NULL
		GROUP BY u.id, u.email, u.locale
		HAVING NOT EXISTS(SELECT 1 FROM user_subscriptions live
			WHERE live.user_id=u.id AND live.plan_tier='pro'
				AND live.status IN `+entitlingStatuses+`
				AND (live.current_period_end IS NULL OR live.current_period_end > now()))
			AND GREATEST(
				max(s.current_period_end) FILTER (
					WHERE s.plan_tier='pro' AND s.status IN `+entitlingStatuses+`
						AND s.current_period_end <= now()),
				max(LEAST(
					COALESCE(s.current_period_end, s.ended_at, s.canceled_at,
						to_timestamp(NULLIF(s.stripe_event_created, 0)), s.updated_at),
					COALESCE(s.ended_at, s.canceled_at,
						to_timestamp(NULLIF(s.stripe_event_created, 0)), s.updated_at)
				)) FILTER (WHERE s.plan_tier='pro' AND s.status NOT IN `+entitlingStatuses+`)
			) IS NOT NULL`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	sent := 0
	for rows.Next() {
		var userID, locale string
		var email *string
		var periodEnd time.Time
		if err := rows.Scan(&userID, &email, &locale, &periodEnd); err != nil {
			return sent, err
		}
		status, err := s.AccountAccess(ctx, userID)
		if err != nil {
			return sent, err
		}
		if !status.ShrinkOnly() {
			continue
		}
		toEmail := ""
		if email != nil {
			toEmail = *email
		}
		n, err := s.dispatchOverQuotaNotices(ctx, userID, toEmail, locale, periodEnd, status)
		if err != nil {
			return sent, err
		}
		sent += n
	}
	return sent, rows.Err()
}

func (s *Store) dispatchOverQuotaNotices(
	ctx context.Context,
	userID, toEmail, locale string,
	periodEnd time.Time,
	status AccountStatus,
) (int, error) {
	graceEnds := periodEnd.AddDate(0, 0, overQuotaBufferDays)
	now := time.Now()
	kinds := []string{lifecycleNoticeStarted}
	if !now.Before(graceEnds.AddDate(0, 0, -7)) {
		kinds = append(kinds, lifecycleNoticeT7)
	}
	if !now.Before(graceEnds.AddDate(0, 0, -3)) {
		kinds = append(kinds, lifecycleNoticeT3)
	}
	if !now.Before(graceEnds) || status.State == AccountOverQuotaFrozen {
		kinds = append(kinds, lifecycleNoticeFrozen)
	}

	sent := 0
	for _, kind := range kinds {
		ok, err := s.sendLifecycleNotice(ctx, userID, toEmail, locale, kind, periodEnd, status)
		if err != nil {
			return sent, err
		}
		if ok {
			sent++
		}
	}
	return sent, nil
}

func (s *Store) sendLifecycleNotice(
	ctx context.Context,
	userID, toEmail, locale, kind string,
	periodEnd time.Time,
	status AccountStatus,
) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
		return false, err
	}
	current, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return false, err
	}
	if !current.ShrinkOnly() {
		return false, nil
	}
	status = current

	tag, err := tx.Exec(ctx, `INSERT INTO lifecycle_notices (user_id, kind, period_end)
		VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, userID, kind, periodEnd)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}

	template := "subscription-over-quota"
	code := kind
	switch kind {
	case lifecycleNoticeFrozen:
		template = "subscription-frozen"
	}

	data, err := json.Marshal(map[string]any{
		"code":              code,
		"storageUsedBytes":  status.StorageUsedBytes,
		"storageLimitBytes": status.StorageLimitBytes,
		"graceEndsAt":       status.GraceEndsAt,
		"periodEnd":         periodEnd,
	})
	if err != nil {
		return false, err
	}

	result, err := NotifyTx(ctx, tx, NotifyParams{
		UserID:         userID,
		ToEmail:        toEmail,
		Locale:         locale,
		Kind:           NotifSystem,
		Data:           data,
		Href:           "/settings",
		Template:       template,
		Category:       "billing",
		IdempotencyKey: fmt.Sprintf("%s:%s:%d", kind, userID, periodEnd.Unix()),
	})
	if err != nil {
		return false, err
	}
	_ = result
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}
