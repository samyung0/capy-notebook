package store

import (
	"errors"
	"testing"
)

func TestProjectMaterialContentRejectsLockedOwner(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, ownerID, material := createRevisionTestMaterial(t, s, PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, state, stored_version) VALUES ($1, '\x00'::bytea, 1)`,
		material.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='manual review' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}

	_, err := s.ProjectMaterialContent(
		ctx,
		material.ID,
		revisionTestContent(t, "must not project"),
		1,
	)
	var locked *AccountLockedError
	if !errors.As(err, &locked) || locked.State != AccountSuspended {
		t.Fatalf("projection error = %v, want suspended account lock", err)
	}

	stored, err := s.GetMaterial(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Revision != material.Revision || stored.Content != material.Content {
		t.Fatal("locked projection changed the material")
	}
}
