package store

import (
	"context"
	"errors"
)

// SignedInGradingPartsPerDay caps the open parts one signed-in user has a model
// grade a UTC day: quiz attempts, review and bank checks, computation checks.
const SignedInGradingPartsPerDay = 2_000

var ErrGradingLimit = errors.New("daily grading limit reached")

// ReserveGrading counts a signed-in user's open parts against today's cap
// before any model call; counted parts stay counted when grading later fails.
func (s *Store) ReserveGrading(ctx context.Context, userID string, parts int) error {
	tag, err := s.pool.Exec(ctx, `INSERT INTO grading_usage (day, user_id, parts)
		SELECT (now() AT TIME ZONE 'UTC')::date, $1, $2::int WHERE $2::int <= $3::int
		ON CONFLICT (day, user_id) DO UPDATE SET parts=grading_usage.parts+EXCLUDED.parts
		WHERE grading_usage.parts+EXCLUDED.parts <= $3::int`, userID, parts, SignedInGradingPartsPerDay)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrGradingLimit
	}
	return nil
}

// PruneDailyUsage keeps 30 days of the per-day counters: grading and invites.
func (s *Store) PruneDailyUsage(ctx context.Context) error {
	for _, table := range []string{"grading_usage", "invite_usage"} {
		if _, err := s.pool.Exec(ctx, `DELETE FROM `+table+`
			WHERE day < (now() AT TIME ZONE 'UTC')::date - 30`); err != nil {
			return err
		}
	}
	return nil
}
