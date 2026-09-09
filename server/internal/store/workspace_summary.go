package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// WorkspaceSummary contains only metadata intended for anonymous readers.
// It deliberately does not embed Workspace or any content-bearing model.
type WorkspaceSummary struct {
	Name        string                    `json:"name"`
	Author      string                    `json:"author"`
	Description string                    `json:"description"`
	Color       UserColor                 `json:"color"`
	Privacy     Privacy                   `json:"privacy"`
	Tags        []string                  `json:"tags" nullable:"false"`
	Chapters    []WorkspaceSummaryChapter `json:"chapters" nullable:"false"`
	Files       []WorkspaceSummaryFile    `json:"files" nullable:"false" doc:"Unfiled files"`
}

type WorkspaceSummaryChapter struct {
	Name  string                 `json:"name"`
	Files []WorkspaceSummaryFile `json:"files" nullable:"false"`
}

// WorkspaceSummaryFile is the only file metadata an anonymous reader sees.
type WorkspaceSummaryFile struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"sizeBytes"`
	AddedAt   time.Time `json:"addedAt"`
}

var ErrSummaryTooLarge = errors.New("workspace summary exceeds public response limit")

// PublicWorkspaceSummary reads visibility, owner lifecycle, and metadata in one
// SQL snapshot. Quota restricts writes, so an over-quota owner remains readable.
func (s *Store) PublicWorkspaceSummary(ctx context.Context, id string) (WorkspaceSummary, error) {
	var out WorkspaceSummary
	var body []byte
	err := s.pool.QueryRow(ctx, `
 SELECT jsonb_build_object(
   'name', w.name, 'author', COALESCE(owner.name, ''), 'description', w.description, 'color', w.color, 'privacy', w.privacy,
   'tags', COALESCE((SELECT jsonb_agg(t.name ORDER BY t.name)
     FROM entity_tags et JOIN tags t ON t.id=et.tag_id WHERE et.workspace_id=w.id), '[]'::jsonb),
   'chapters', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', c.name,
     'files', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', f.name, 'sizeBytes', f.size_bytes, 'addedAt', f.added_at) ORDER BY f.position, f.id)
       FROM files f WHERE f.workspace_id=w.id AND f.chapter_id=c.id), '[]'::jsonb))
     ORDER BY c.position, c.id)
     FROM (SELECT id, name, position FROM chapters WHERE workspace_id=w.id
       ORDER BY position, id LIMIT 1001) c), '[]'::jsonb),
   'files', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', f.name, 'sizeBytes', f.size_bytes, 'addedAt', f.added_at) ORDER BY f.position, f.id)
     FROM files f WHERE f.workspace_id=w.id AND f.chapter_id IS NULL), '[]'::jsonb)
 )
 FROM workspaces w JOIN users owner ON owner.id=w.user_id
 WHERE w.id=$1 AND w.privacy IN ('link','public')
   AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
   AND owner.suspended_at IS NULL`, id).Scan(&body)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	// No partial outline: unusually large workspaces fail explicitly.
	if len(body) > 256*1024 {
		return out, ErrSummaryTooLarge
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return WorkspaceSummary{}, err
	}
	if len(out.Chapters) > 1000 {
		return WorkspaceSummary{}, ErrSummaryTooLarge
	}
	return out, nil
}
