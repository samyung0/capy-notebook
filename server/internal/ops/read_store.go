package ops

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	topUsersLimit      = 20
	recentUsageLimit   = 50
	userSearchLimit    = 20
	userSearchMaxLen   = 128
	userWorkspaceLimit = 100
	maxCostRows        = 500
)

type ReadStore struct {
	app *store.Store
	db  *pgxpool.Pool
}

func NewReadStore(app *store.Store) *ReadStore {
	return &ReadStore{app: app, db: app.Pool()}
}

func (s *ReadStore) Operator(ctx context.Context, userID string) (Session, error) {
	var out Session
	err := s.db.QueryRow(ctx,
		`SELECT o.user_id, COALESCE(u.email, ''), u.name, o.role
		 FROM operators o JOIN users u ON u.id = o.user_id
		 WHERE o.user_id = $1
		   AND u.deleted_at IS NULL
		   AND u.suspended_at IS NULL
		   AND u.deletion_requested_at IS NULL`, userID).
		Scan(&out.UserID, &out.Email, &out.Name, &out.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, store.ErrForbidden
	}
	return out, err
}

func (s *ReadStore) Overview(ctx context.Context, requestedDays ...int) (Overview, error) {
	days := 30
	if len(requestedDays) > 0 {
		days = requestedDays[0]
	}
	if days < 1 || days > 90 {
		return Overview{}, validation("days must be between 1 and 90")
	}
	out := Overview{
		ByKind:     []UsagePoint{},
		BySurface:  []UsagePoint{},
		TopUsers:   []RankedUser{},
		TopStorage: []StorageUser{},
	}
	err := s.db.QueryRow(ctx, `
		SELECT
			COALESCE(sum(credit_micros) FILTER (WHERE day = CURRENT_DATE), 0),
			COALESCE(sum(credit_micros) FILTER (
				WHERE day >= date_trunc('month', CURRENT_DATE)::date
			), 0)
		FROM usage_daily
		WHERE day >= date_trunc('month', CURRENT_DATE)::date
	`).Scan(&out.TodayCredits, &out.MonthCredits)
	if err != nil {
		return out, err
	}
	err = s.db.QueryRow(ctx, `
		SELECT COALESCE(sum(
			st.used_bytes + COALESCE((
				SELECT sum(d.delta_bytes) FROM user_storage_deltas d
				WHERE d.user_id = st.user_id
			), 0)
		), 0)
		FROM user_storage st`).
		Scan(&out.StorageTotal)
	if err != nil {
		return out, err
	}
	if out.ByKind, err = s.usageSeries(ctx, "kind", days); err != nil {
		return out, err
	}
	if out.BySurface, err = s.usageSeries(ctx, "surface", days); err != nil {
		return out, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT d.actor_user_id, COALESCE(u.email, ''), u.name, u.plan_tier,
			sum(d.credit_micros)::bigint
		FROM usage_daily d JOIN users u ON u.id = d.actor_user_id
		WHERE d.day >= date_trunc('month', CURRENT_DATE)::date
		GROUP BY d.actor_user_id, u.email, u.name, u.plan_tier
		ORDER BY sum(d.credit_micros) DESC LIMIT $1`, topUsersLimit)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item RankedUser
		if err := rows.Scan(&item.UserID, &item.Email, &item.Name,
			&item.PlanTier, &item.CreditMicros); err != nil {
			rows.Close()
			return out, err
		}
		out.TopUsers = append(out.TopUsers, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `
		SELECT u.id, COALESCE(u.email, ''), u.name,
			COALESCE(st.used_bytes, 0) + COALESCE((
				SELECT sum(d.delta_bytes) FROM user_storage_deltas d
				WHERE d.user_id = u.id
			), 0)
		FROM users u LEFT JOIN user_storage st ON st.user_id = u.id
		ORDER BY 4 DESC, u.id LIMIT $1`, topUsersLimit)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item StorageUser
		if err := rows.Scan(&item.UserID, &item.Email, &item.Name,
			&item.UsedBytes); err != nil {
			rows.Close()
			return out, err
		}
		out.TopStorage = append(out.TopStorage, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	err = s.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM users WHERE created_at >= CURRENT_DATE),
			(SELECT count(*) FROM workspaces
			 WHERE last_accessed_at >= now() - interval '7 days'),
			(SELECT count(*) FROM jobs WHERE status = 'pending'),
			(SELECT count(*) FROM jobs WHERE status = 'running'),
			(SELECT count(*) FROM jobs
			 WHERE status = 'failed' AND updated_at >= now() - interval '24 hours'),
			(SELECT last_run_at FROM usage_rollup_state WHERE id = true)
	`).Scan(&out.SignupsToday, &out.ActiveWorkspaces7d,
		&out.Jobs.Queued, &out.Jobs.Running, &out.Jobs.Failed24h,
		&out.RollupLastRunAt)
	return out, err
}

func (s *ReadStore) usageSeries(
	ctx context.Context,
	dimension string,
	days int,
) ([]UsagePoint, error) {
	if dimension != "kind" && dimension != "surface" {
		return nil, fmt.Errorf("unsupported usage dimension")
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT day, %s, sum(credit_micros)::bigint
		FROM usage_daily WHERE day >= CURRENT_DATE - ($1::int - 1)
		GROUP BY day, %s ORDER BY day, %s`, dimension, dimension, dimension), days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]UsagePoint, 0)
	for rows.Next() {
		var item UsagePoint
		var day time.Time
		if err := rows.Scan(&day, &item.Key, &item.CreditMicros); err != nil {
			return nil, err
		}
		item.Day = day.Format("2006-01-02")
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *ReadStore) Health(ctx context.Context, stuckMinutes int) (Health, error) {
	var out Health
	if stuckMinutes < 1 || stuckMinutes > 24*60 {
		return out, validation("stuck job threshold must be between 1 and 1440 minutes")
	}
	var settled, released int64
	err := s.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM credit_reservations
			 WHERE status = 'open' AND expires_at < now()),
			(SELECT last_run_at FROM usage_rollup_state WHERE id = true),
			(SELECT count(*) FROM jobs
			 WHERE status = 'running'
			   AND COALESCE(lease_expires_at, locked_at, updated_at)
			       < now() - make_interval(mins => $1)),
			(SELECT count(*) FROM email_outbox
			 WHERE status = 'failed' AND updated_at >= now() - interval '24 hours'),
			(SELECT count(*) FROM ops_completed_assistant_messages m
			 WHERE m.created_at >= now() - interval '24 hours'
			   AND m.trace_id IS NOT NULL
			   AND NOT EXISTS (
					SELECT 1 FROM usage_events ue
					WHERE ue.trace_id = m.trace_id
					  AND ue.created_at >= now() - interval '25 hours'
			   )),
			(SELECT count(*) FROM credit_reservations
			 WHERE status = 'settled' AND settled_at >= now() - interval '24 hours'),
			(SELECT count(*) FROM credit_reservations
			 WHERE status = 'released' AND settled_at >= now() - interval '24 hours')
	`, stuckMinutes).Scan(
		&out.ExpiredReservations, &out.RollupLastRunAt, &out.StuckJobs,
		&out.EmailFailures24h, &out.UsageMissing24h, &settled, &released,
	)
	out.RollupStale = out.RollupLastRunAt == nil ||
		time.Since(*out.RollupLastRunAt) > 45*time.Minute
	out.ReservationRatio24h.Settled = settled
	out.ReservationRatio24h.Released = released
	if total := settled + released; total > 0 {
		out.ReservationRatio24h.ReleaseRate = float64(released) / float64(total)
	}
	return out, err
}

func (s *ReadStore) SearchUsers(ctx context.Context, query string) ([]UserSearchResult, error) {
	query = strings.TrimSpace(query)
	if len(query) < 2 {
		return []UserSearchResult{}, nil
	}
	if len(query) > userSearchMaxLen {
		return nil, validation("user search must be at most %d characters", userSearchMaxLen)
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, name, COALESCE(email, ''), plan_tier
		FROM users
		WHERE id = $1 OR email ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%'
		ORDER BY (id = $1) DESC, (lower(email) = lower($1)) DESC, email
		LIMIT $2`, query, userSearchLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]UserSearchResult, 0)
	for rows.Next() {
		var item UserSearchResult
		if err := rows.Scan(&item.UserID, &item.Name, &item.Email, &item.PlanTier); err != nil {
			return nil, err
		}
		status, err := s.app.AccountAccess(ctx, item.UserID)
		if err != nil {
			return nil, err
		}
		item.AccountState = string(status.State)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *ReadStore) User(ctx context.Context, userID string) (UserDetail, error) {
	out := UserDetail{
		UsageByKind: []UsagePoint{},
		Workspaces:  []UserWorkspace{},
		RecentUsage: []UsageEvent{},
	}
	err := s.db.QueryRow(ctx, `
		SELECT id, name, COALESCE(email, ''), plan_tier
		FROM users WHERE id = $1`, userID).
		Scan(&out.UserID, &out.Name, &out.Email, &out.PlanTier)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, store.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	status, err := s.app.AccountAccess(ctx, userID)
	if err != nil {
		return out, err
	}
	out.AccountState = string(status.State)
	credits, err := s.app.CreditBalance(ctx, userID)
	if err != nil {
		return out, err
	}
	out.Credits = CreditBalance{
		PeriodStart:    credits.PeriodStart.Format("2006-01-02"),
		UsedMicros:     credits.UsedMicros,
		ReservedMicros: credits.ReservedMicros,
		LimitMicros:    credits.LimitMicros,
	}
	err = s.db.QueryRow(ctx, `
		SELECT COALESCE(st.used_bytes, 0) + COALESCE((
				SELECT sum(d.delta_bytes) FROM user_storage_deltas d
				WHERE d.user_id = $1
			), 0),
			COALESCE(st.reserved_bytes, 0)
		FROM users u LEFT JOIN user_storage st ON st.user_id = u.id
		WHERE u.id = $1`, userID).Scan(
		&out.Storage.UsedBytes, &out.Storage.ReservedBytes,
	)
	if err != nil {
		return out, err
	}
	out.Storage.LimitBytes = store.StorageLimitBytes(store.PlanTier(out.PlanTier))
	rows, err := s.db.Query(ctx, `
		SELECT day, kind, sum(credit_micros)::bigint
		FROM usage_daily
		WHERE actor_user_id = $1 AND day >= CURRENT_DATE - 89
		GROUP BY day, kind ORDER BY day, kind`, userID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item UsagePoint
		var day time.Time
		if err := rows.Scan(&day, &item.Key, &item.CreditMicros); err != nil {
			rows.Close()
			return out, err
		}
		item.Day = day.Format("2006-01-02")
		out.UsageByKind = append(out.UsageByKind, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `
		SELECT w.id, w.name, count(f.id), w.last_accessed_at
		FROM workspaces w LEFT JOIN files f ON f.workspace_id = w.id
		WHERE w.user_id = $1
		GROUP BY w.id ORDER BY w.last_accessed_at DESC
		LIMIT $2`, userID, userWorkspaceLimit)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item UserWorkspace
		if err := rows.Scan(&item.ID, &item.Name, &item.FileCount, &item.LastActivityAt); err != nil {
			rows.Close()
			return out, err
		}
		out.Workspaces = append(out.Workspaces, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `
		SELECT COALESCE(trace_id, ''), kind, surface,
			provider, model, model_key, model_version, input_tokens,
			output_tokens, units, unit, credit_micros, created_at, '{}'::jsonb
		FROM usage_events WHERE actor_user_id = $1
		ORDER BY created_at DESC LIMIT $2`, userID, recentUsageLimit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item UsageEvent
		if err := rows.Scan(&item.TraceID, &item.Kind, &item.Surface,
			&item.Provider, &item.Model,
			&item.ModelKey, &item.ModelVersion, &item.InputTokens,
			&item.OutputTokens, &item.Units, &item.Unit,
			&item.CreditMicros, &item.CreatedAt, &item.Metadata); err != nil {
			return out, err
		}
		out.RecentUsage = append(out.RecentUsage, item)
	}
	return out, rows.Err()
}

var costDimensions = map[string]string{
	"day": "day::text", "user": "actor_user_id", "kind": "kind", "surface": "surface",
	"provider": "provider", "model": "model",
}

func (s *ReadStore) Costs(
	ctx context.Context,
	from, to time.Time,
	groupBy string,
) ([]CostRow, error) {
	if from.After(to) || to.Sub(from) > 365*24*time.Hour {
		return nil, validation("cost range must be ordered and at most 366 days")
	}
	if groupBy == "" {
		groupBy = "day"
	}
	column, ok := costDimensions[groupBy]
	if !ok {
		return nil, validation("unsupported cost group %q", groupBy)
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT %s AS key, sum(events)::bigint, sum(input_tokens)::bigint,
			sum(output_tokens)::bigint, sum(units)::bigint, sum(credit_micros)::bigint
		FROM usage_daily WHERE day >= $1::date AND day < $2::date GROUP BY %s
		ORDER BY sum(credit_micros) DESC LIMIT %d`,
		column, column, maxCostRows), from, to.Add(24*time.Hour))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]CostRow, 0)
	for rows.Next() {
		var item CostRow
		if err := rows.Scan(&item.Key, &item.Events, &item.InputTokens,
			&item.OutputTokens, &item.Units, &item.CreditMicros); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
