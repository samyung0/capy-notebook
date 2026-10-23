package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// Daily caps on signed-out grading. Classrooms share one address, so the
// per-address cap (an IPv6 /64 is one address) is generous; the per-link cap
// keeps one shared item from taking the global pool, and the global cap
// protects the Jev key's quota.
const (
	AnonymousGradingPartsPerIP   = 300
	AnonymousGradingPartsPerLink = 2_000
	AnonymousGradingPartsPerDay  = 50_000
)

// SignedInGradingPartsPerDay caps the open parts one signed-in user has Jev
// grade a UTC day: quiz attempts, review and bank checks, computation checks.
const SignedInGradingPartsPerDay = 2_000

var (
	ErrAnonymousGradingLimit = errors.New("anonymous grading limit reached")
	ErrGradingLimit          = errors.New("daily grading limit reached")
)

var anonymousLocalID = regexp.MustCompile(fmt.Sprintf(`^[A-Za-z0-9-]{1,%d}$`, fieldlimits.AnonymousLocalID))

// AnonymousIPHash salts the client IP with the link secret so stored rows never
// hold an address.
func (s *Store) AnonymousIPHash(ip string) string {
	mac := hmac.New(sha256.New, s.shareLinkSecret)
	mac.Write([]byte("anonymous-ip:v1:" + ip))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

// ReserveAnonymousGrading counts parts against today's caps before any Jev
// call; linkID is the shared item the verified token names. Counted parts stay
// counted when grading later fails, so retries cannot spend past the cap. A
// client-chosen local id that is not a plain token is recorded as empty.
func (s *Store) ReserveAnonymousGrading(ctx context.Context, ipHash, linkID, localID string, parts int) error {
	if !anonymousLocalID.MatchString(localID) {
		localID = ""
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// One lock per day serializes the cap checks; anonymous grading is rare
	// enough that this is not a bottleneck.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('anonymous-grading:' || (now() AT TIME ZONE 'UTC')::date))`); err != nil {
		return err
	}
	var byIP, byLink, total int
	if err := tx.QueryRow(ctx, `SELECT
		COALESCE(sum(parts) FILTER (WHERE ip_hash=$1), 0),
		COALESCE(sum(parts) FILTER (WHERE link_id=$2), 0), COALESCE(sum(parts), 0)
		FROM anonymous_grading_usage WHERE day=(now() AT TIME ZONE 'UTC')::date`,
		ipHash, linkID).Scan(&byIP, &byLink, &total); err != nil {
		return err
	}
	if byIP+parts > AnonymousGradingPartsPerIP || byLink+parts > AnonymousGradingPartsPerLink ||
		total+parts > AnonymousGradingPartsPerDay {
		return ErrAnonymousGradingLimit
	}
	if _, err := tx.Exec(ctx, `INSERT INTO anonymous_grading_usage (day, ip_hash, local_id, link_id, parts)
		VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3, $4)
		ON CONFLICT (day, ip_hash, local_id, link_id)
		DO UPDATE SET parts=anonymous_grading_usage.parts+EXCLUDED.parts, updated_at=now()`,
		ipHash, localID, linkID, parts); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordAnonymousGradingUsage adds what the reserved parts consumed.
func (s *Store) RecordAnonymousGradingUsage(ctx context.Context, ipHash, linkID, localID string, inputTokens, costMicroUSD int64) error {
	if !anonymousLocalID.MatchString(localID) {
		localID = ""
	}
	_, err := s.pool.Exec(ctx, `UPDATE anonymous_grading_usage
		SET input_tokens=input_tokens+$4, cost_micro_usd=cost_micro_usd+$5, updated_at=now()
		WHERE day=(now() AT TIME ZONE 'UTC')::date AND ip_hash=$1 AND local_id=$2 AND link_id=$3`,
		ipHash, localID, linkID, inputTokens, costMicroUSD)
	return err
}

// ReserveGrading counts a signed-in user's open parts against today's cap
// before any Jev call; counted parts stay counted when grading later fails.
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

// PruneGradingUsage keeps 30 days of signed-out and signed-in grading rows.
func (s *Store) PruneGradingUsage(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM anonymous_grading_usage
		WHERE day < (now() AT TIME ZONE 'UTC')::date - 30`); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM grading_usage
		WHERE day < (now() AT TIME ZONE 'UTC')::date - 30`)
	return err
}
