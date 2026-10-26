package store

import (
	"context"
	"errors"
	"slices"
)

// ErrInvalidCustomization refuses a customization the app could not apply.
var ErrInvalidCustomization = errors.New("invalid customization")

// Validate repeats the request schema's bounds, so nothing reaches the
// column that the schema would have refused.
func (c Customization) Validate() error {
	f := c.PageFrame
	ok := slices.Contains([]string{"classroom", "notion"}, c.Style) &&
		slices.Contains([]string{"latte", "frappe", "mocha"}, c.Theme) &&
		slices.Contains([]string{"none", "arc", "mesh", "glow"}, f.Pattern) &&
		slices.Contains([]string{"dusk", "sea", "meadow", "rose", "sunset", "wheat", "mist", "custom"}, f.Colours) &&
		len(f.Dots) >= 1 && len(f.Dots) <= 3 && unit(f.Strength)
	for _, d := range f.Dots {
		ok = ok && unit(d.X) && unit(d.Y)
	}
	if !ok {
		return ErrInvalidCustomization
	}
	return nil
}

func unit(v float64) bool { return v >= 0 && v <= 1 }

// SetCustomization replaces the account's synced customization. The struct
// is stored as marshalled, so only its known fields reach the column.
func (s *Store) SetCustomization(ctx context.Context, userID string, c Customization) error {
	if err := c.Validate(); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE users SET customization=$2, updated_at=now() WHERE id=$1`, userID, c)
	return err
}
