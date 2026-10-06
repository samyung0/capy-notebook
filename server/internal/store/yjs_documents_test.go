package store

import (
	"errors"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func TestProjectMaterialContentRejectsLockedOwner(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx, ownerID, material := createTestMaterial(t, s, PlanFree)
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
		testProjection(t, materialTestContent(t, "must not project")),
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

func testProjection(t *testing.T, content string) materialdoc.Projection {
	t.Helper()
	doc, err := materialdoc.Parse(content)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := materialdoc.NewProjection(doc)
	if err != nil {
		t.Fatal(err)
	}
	return projection
}

// A projection answers the row's numbers without reading the content back,
// and content equal to what is stored advances the watermark without a
// revision: compared as jsonb on the row's first projection, by the hash of
// the last projection after it.
func TestProjectMaterialContentRevisesOnlyChangedContent(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx, _, material := createTestMaterial(t, s, PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, state, stored_version) VALUES ($1, '\x00'::bytea, 9)`,
		material.ID); err != nil {
		t.Fatal(err)
	}
	created := testProjection(t, material.Content)
	changed := testProjection(t, materialTestContent(t, "changed"))
	expect := func(version int64, projection materialdoc.Projection, revision int64) {
		t.Helper()
		projected, err := s.ProjectMaterialContent(ctx, material.ID, projection, version)
		if err != nil {
			t.Fatal(err)
		}
		stored, err := s.GetMaterial(ctx, material.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Revision != revision {
			t.Fatalf("version %d: revision %d, want %d", version, stored.Revision, revision)
		}
		want := ProjectedMaterial{
			ID: stored.ID, Revision: stored.Revision, SizeBytes: int64(len(stored.Content)),
			NodeCount: stored.NodeCount, MaxDepth: stored.MaxDepth,
		}
		if !projected.UpdatedAt.Equal(stored.UpdatedAt) {
			t.Fatalf("version %d: updated %v, row says %v", version, projected.UpdatedAt, stored.UpdatedAt)
		}
		projected.UpdatedAt = time.Time{}
		if projected != want {
			t.Fatalf("version %d: projected %+v, row says %+v", version, projected, want)
		}
	}
	expect(1, created, material.Revision)   // first projection: jsonb compare
	expect(2, created, material.Revision)   // hash compare
	expect(3, changed, material.Revision+1) // a real change
	expect(4, changed, material.Revision+1)
	expect(5, created, material.Revision+2) // back to the original text
	expect(4, changed, material.Revision+2) // stale version: nothing written
}
