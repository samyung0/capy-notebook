package store

import "context"

// EditIncident is one editing incident the browser saw: a user lost or could
// lose work (human/observability-metering.md, 2026-10-05). The collaboration
// service writes its own room incidents to the same table directly.
type EditIncident struct {
	FileID   string
	FileKind string
	Kind     string
	// Reason and SizeBytes are optional.
	Reason    string
	SizeBytes *int64
}

// RecordEditIncident stores one incident for userID.
func (s *Store) RecordEditIncident(ctx context.Context, userID string, incident EditIncident) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO edit_incidents
		(user_id, file_id, file_kind, kind, reason, size_bytes)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6)`,
		userID, incident.FileID, incident.FileKind, incident.Kind, incident.Reason, incident.SizeBytes)
	return err
}

// PruneEditIncidents deletes incidents older than their 90 days.
func (s *Store) PruneEditIncidents(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM edit_incidents
		WHERE created_at < now() - interval '90 days'`)
	return err
}
