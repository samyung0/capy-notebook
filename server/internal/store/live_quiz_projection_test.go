package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// quizProjection is a quiz block of `questions` boolean questions whose part
// holds `blocks` text blocks of `chars` characters each.
func quizProjection(t *testing.T, questions, blocks, chars int, marker string) materialdoc.Projection {
	t.Helper()
	children := make([]any, questions)
	for q := range children {
		texts := make([]any, blocks)
		for b := range texts {
			texts[b] = map[string]any{"type": "text", "text": marker + strings.Repeat("x", chars-len(marker))}
		}
		id := fmt.Sprintf("q%d", q)
		children[q] = map[string]any{
			"type": "quiz_question", "id": id, "children": []any{map[string]any{"text": ""}},
			"question": map[string]any{
				"id": id, "layout": "paper", "labels": "letters", "stem": []any{},
				"parts": []any{map[string]any{
					"id": id + "-p", "blocks": texts, "marks": 1, "solution": []any{},
					"answer": map[string]any{"type": "boolean", "correct": true},
				}},
			},
		}
	}
	projection, err := materialdoc.NewProjection(materialdoc.Envelope{
		SchemaVersion: materialdoc.SchemaVersion,
		Value:         []map[string]any{{"type": "quiz", "id": "quiz", "children": children}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return projection
}

func createTestQuiz(t *testing.T, s *Store) (context.Context, string, string) {
	t.Helper()
	ctx, owner, _ := createTestMaterial(t, s, PlanFree)
	quiz, err := s.CreateMaterial(ctx, Material{
		CreatedBy: owner, Kind: "quiz", Title: "Live quiz",
		Content: quizProjection(t, 1, 1, 10, "a").Raw, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, state, stored_version) VALUES ($1, '\x00'::bytea, 10)`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	return ctx, owner, quiz.ID
}

// An image only an incomplete question holds is named by the collaboration
// service beside the projection and stays in use; once nothing names it, the
// prune trashes it (live-items REVIEW1 S4).
func TestQuizProjectionKeepsAssetsItsDocumentsName(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx, owner, quizID := createTestQuiz(t, s)
	assetID := uid("asset")
	if _, err := s.pool.Exec(ctx, `INSERT INTO editor_assets
		(id,material_id,user_id,created_by,name,purpose,object_path,content_type,size_bytes,status,completed_at)
		VALUES ($1,$2,$3,$3,'figure.png','image',$4,'image/png',10,'ready',now()-interval '2 minutes')`,
		assetID, quizID, owner, "editor-assets/"+assetID); err != nil {
		t.Fatal(err)
	}
	trashed := func() bool {
		t.Helper()
		var trashed bool
		if err := s.pool.QueryRow(ctx, `SELECT trashed_at IS NOT NULL FROM editor_assets WHERE id=$1`,
			assetID).Scan(&trashed); err != nil {
			t.Fatal(err)
		}
		return trashed
	}
	if _, err := s.ProjectMaterialContent(ctx, quizID, quizProjection(t, 1, 1, 10, "b"), 1,
		[]string{assetID}); err != nil {
		t.Fatal(err)
	}
	if trashed() {
		t.Fatal("an asset the live documents name was trashed")
	}
	if _, err := s.ProjectMaterialContent(ctx, quizID, quizProjection(t, 1, 1, 10, "c"), 2, nil); err != nil {
		t.Fatal(err)
	}
	if !trashed() {
		t.Fatal("an asset nothing names stayed")
	}
}

// A quiz's content and keys documents count together against the limits in
// the collaboration service; Go refuses a quiz projection over a limit unless
// it shrank from the stored content (live-items REVIEW1 S3).
func TestQuizProjectionOverALimitMustShrink(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx, _, quizID := createTestQuiz(t, s)
	big := quizProjection(t, 50, 4, 12_000, "d")
	if big.Metrics.SizeBytes <= materialdoc.MaxDocumentBytes {
		t.Fatalf("fixture is %d bytes, want over %d", big.Metrics.SizeBytes, materialdoc.MaxDocumentBytes)
	}
	if _, err := s.ProjectMaterialContent(ctx, quizID, big, 1, nil); !errors.Is(err, materialdoc.ErrLimitExceeded) {
		t.Fatalf("over-limit growth projected: %v", err)
	}
	// Stored over the limit already: a smaller projection, still over it, is
	// a recovery and lands.
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET content=$2::jsonb, node_count=$3, max_depth=$4
		WHERE id=$1`, quizID, big.Raw, big.Metrics.NodeCount, big.Metrics.MaxDepth); err != nil {
		t.Fatal(err)
	}
	smaller := quizProjection(t, 49, 4, 12_000, "e")
	if smaller.Metrics.SizeBytes <= materialdoc.MaxDocumentBytes {
		t.Fatalf("smaller fixture is %d bytes, want over %d", smaller.Metrics.SizeBytes, materialdoc.MaxDocumentBytes)
	}
	if _, err := s.ProjectMaterialContent(ctx, quizID, smaller, 2, nil); err != nil {
		t.Fatalf("a shrinking quiz projection was refused: %v", err)
	}
}
