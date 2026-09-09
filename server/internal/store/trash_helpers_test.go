package store

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// Tests that need a resource to disappear for good go through the same two
// steps a user does: trash, then the owner's permanent delete of that episode.
func trashAndPurgeFile(ctx context.Context, s *Store, ownerID, fileID string) error {
	op, err := s.TrashFile(ctx, ownerID, fileID, AgentOperation{})
	if err != nil {
		return err
	}
	_, err = s.PurgeTrashed(ctx, ownerID, agenttools.KindSourceFile, fileID, op.Effect.TrashEpisodeID, AgentOperation{})
	return err
}

func trashAndPurgeMaterial(ctx context.Context, s *Store, ownerID, materialID string) error {
	op, err := s.TrashMaterial(ctx, ownerID, materialID, "", AgentOperation{})
	if err != nil {
		return err
	}
	_, err = s.PurgeTrashed(ctx, ownerID, agenttools.KindMaterial, materialID, op.Effect.TrashEpisodeID, AgentOperation{})
	return err
}

var _ = testing.Short
