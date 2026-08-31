package planlimits

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	TierFree = "free"
	TierPro  = "pro"
)

var ErrCatalogNotLoaded = errors.New("plan limits catalog not loaded")

// Limits is the complete set of user-facing numeric limits for one plan.
// OwnedWorkspaces is zero when ownership is unlimited.
type Limits struct {
	StorageBytes      int64
	CreditMicros      int64
	SourceFileBytes   int64
	MaterialRevisions int
	OwnedWorkspaces   int
	FilesPerWorkspace int
	FilesPerUpload    int
}

// Catalog is an immutable startup snapshot. Its map is private so request
// paths can read values but cannot replace them or observe database edits.
type Catalog struct {
	byTier map[string]Limits
}

func Load(ctx context.Context, pool *pgxpool.Pool) (Catalog, error) {
	rows, err := pool.Query(ctx, `SELECT plan_tier, storage_limit_bytes,
		credit_limit_micros, source_file_max_bytes, material_revision_limit,
		owned_workspace_limit, files_per_workspace, files_per_upload
		FROM plan_limits ORDER BY plan_tier`)
	if err != nil {
		return Catalog{}, fmt.Errorf("load plan limits: %w", err)
	}
	defer rows.Close()

	byTier := make(map[string]Limits, 2)
	for rows.Next() {
		var (
			tier            string
			limits          Limits
			ownedWorkspaces *int
		)
		if err := rows.Scan(
			&tier,
			&limits.StorageBytes,
			&limits.CreditMicros,
			&limits.SourceFileBytes,
			&limits.MaterialRevisions,
			&ownedWorkspaces,
			&limits.FilesPerWorkspace,
			&limits.FilesPerUpload,
		); err != nil {
			return Catalog{}, fmt.Errorf("scan plan limits: %w", err)
		}
		if tier != TierFree && tier != TierPro {
			return Catalog{}, fmt.Errorf("unknown plan tier %q", tier)
		}
		if _, exists := byTier[tier]; exists {
			return Catalog{}, fmt.Errorf("duplicate plan tier %q", tier)
		}
		if ownedWorkspaces != nil {
			limits.OwnedWorkspaces = *ownedWorkspaces
		}
		if err := validate(tier, limits); err != nil {
			return Catalog{}, err
		}
		byTier[tier] = limits
	}
	if err := rows.Err(); err != nil {
		return Catalog{}, fmt.Errorf("load plan limits: %w", err)
	}
	free, hasFree := byTier[TierFree]
	pro, hasPro := byTier[TierPro]
	if !hasFree || !hasPro || len(byTier) != 2 {
		return Catalog{}, errors.New("plan limits must contain exactly free and pro")
	}
	if err := validateUpgrade(free, pro); err != nil {
		return Catalog{}, err
	}
	return Catalog{byTier: byTier}, nil
}

func validate(tier string, limits Limits) error {
	if limits.StorageBytes <= 0 || limits.CreditMicros <= 0 ||
		limits.SourceFileBytes <= 0 || limits.MaterialRevisions <= 0 ||
		limits.OwnedWorkspaces < 0 || limits.FilesPerWorkspace <= 0 ||
		limits.FilesPerUpload <= 0 {
		return fmt.Errorf("plan %q contains a non-positive limit", tier)
	}
	if limits.FilesPerUpload > limits.FilesPerWorkspace {
		return fmt.Errorf("plan %q files per upload exceeds files per workspace", tier)
	}
	return nil
}

func validateUpgrade(free, pro Limits) error {
	if pro.StorageBytes < free.StorageBytes ||
		pro.CreditMicros < free.CreditMicros ||
		pro.SourceFileBytes < free.SourceFileBytes ||
		pro.MaterialRevisions < free.MaterialRevisions ||
		pro.FilesPerWorkspace < free.FilesPerWorkspace ||
		pro.FilesPerUpload < free.FilesPerUpload {
		return errors.New("pro plan limits cannot be lower than free plan limits")
	}
	if free.OwnedWorkspaces == 0 && pro.OwnedWorkspaces != 0 {
		return errors.New("pro owned-workspace limit cannot be finite when free is unlimited")
	}
	if free.OwnedWorkspaces > 0 && pro.OwnedWorkspaces > 0 &&
		pro.OwnedWorkspaces < free.OwnedWorkspaces {
		return errors.New("pro owned-workspace limit cannot be lower than free")
	}
	return nil
}

func (c Catalog) For(tier string) (Limits, error) {
	if c.byTier == nil {
		return Limits{}, ErrCatalogNotLoaded
	}
	limits, ok := c.byTier[tier]
	if !ok {
		return Limits{}, fmt.Errorf("unknown plan tier %q", tier)
	}
	return limits, nil
}

func (c Catalog) MaxSourceFileBytes() (int64, error) {
	free, err := c.For(TierFree)
	if err != nil {
		return 0, err
	}
	pro, err := c.For(TierPro)
	if err != nil {
		return 0, err
	}
	return max(free.SourceFileBytes, pro.SourceFileBytes), nil
}
