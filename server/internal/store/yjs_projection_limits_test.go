package store

import (
	"fmt"
	"testing"

	"github.com/evonotes/server/internal/materialdoc"
)

func TestProjectMaterialContentAllowsValidOverLimitRecovery(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, _, material := createRevisionTestMaterial(t, s, PlanFree)
	value := make([]map[string]any, materialdoc.MaxNodes/2+1)
	for index := range value {
		value[index] = map[string]any{
			"type":     "p",
			"id":       fmt.Sprintf("block_%d", index),
			"children": []any{map[string]any{"text": "x"}},
		}
	}
	raw, err := materialdoc.MarshalProjection(materialdoc.Envelope{
		SchemaVersion: materialdoc.SchemaVersion,
		Value:         value,
	})
	if err != nil {
		t.Fatal(err)
	}
	metrics, err := materialdoc.Metrics(raw)
	if err != nil {
		t.Fatal(err)
	}
	if metrics.NodeCount <= materialdoc.MaxNodes {
		t.Fatalf("fixture node count=%d, want over %d", metrics.NodeCount, materialdoc.MaxNodes)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, state, stored_version) VALUES ($1, '\x00'::bytea, 1)`,
		material.ID); err != nil {
		t.Fatal(err)
	}

	projected, err := s.ProjectMaterialContent(ctx, material.ID, raw, 1)
	if err != nil {
		t.Fatalf("valid over-limit projection failed: %v", err)
	}
	projectedMetrics, err := materialdoc.Metrics(projected.Content)
	if err != nil {
		t.Fatal(err)
	}
	if projected.NodeCount != metrics.NodeCount || projectedMetrics.NodeCount != metrics.NodeCount {
		t.Fatalf("projection metrics mismatch: row=%d content=%d want=%d",
			projected.NodeCount, projectedMetrics.NodeCount, metrics.NodeCount)
	}
}
