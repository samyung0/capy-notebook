package store

import (
	"context"
	"net/url"
	"time"
)

// liveProjectionTimeout bounds the room's store and projection behind a View
// read; the read serves the stored projection when it runs out.
const liveProjectionTimeout = 10 * time.Second

// ProjectLiveNote asks the collaboration service to project a note whose
// room holds stored versions its projection has not caught up with, so View
// opens on the current content (Epo 2026-10-07; notes otherwise project when
// the room goes idle or unloads). A note whose projection is current makes no
// call, and the service does nothing for a room no instance has loaded.
// Reports whether materials.content moved.
func (s *Store) ProjectLiveNote(ctx context.Context, materialID string) (bool, error) {
	var stale bool
	err := s.pool.QueryRow(ctx, `SELECT stored_version > projected_version
		FROM material_yjs_documents WHERE material_id=$1`, materialID).Scan(&stale)
	if isNoRows(err) {
		return false, nil
	}
	if err != nil || !stale {
		return false, err
	}
	ctx, cancel := context.WithTimeout(ctx, liveProjectionTimeout)
	defer cancel()
	var out struct {
		Projected bool `json:"projected"`
	}
	path := "/internal/materials/" + url.PathEscape(materialID) + "/project"
	if err := s.postDocumentAuthority(ctx, path, struct{}{}, &out); err != nil {
		return false, err
	}
	return out.Projected, nil
}
